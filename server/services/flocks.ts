/**
 * The flock spine: cohorts, where they live, and every bird in or out.
 *
 * One rule runs through all of it — **the bird count is never stored**. It is
 * summed from `flock_movements` every time it is asked for. A stored running
 * total is a second copy of the truth, and the first thing that happens to a
 * second copy is that somebody backdates a mortality row and the two stop
 * agreeing. Summing is cheap; reconciling two numbers a year later is not.
 *
 * The other rule: a transfer never edits a placement. It closes one and opens
 * another, writing a paired transfer_out/transfer_in so the ledger balances and
 * the timeline still reads correctly years from now.
 */
import { and, asc, desc, eq, inArray, isNull, like, lte, sql } from "drizzle-orm";
import {
  CAUSE_REQUIRED,
  flockHatches,
  flockMovements,
  flockPlacements,
  flocks,
  hatchProfile,
  houses,
  locations,
  mortalityCauses,
  movementDelta,
  standardSets,
} from "@shared/schema";
import type { db as Db } from "../db";
import { PostingError } from "./posting";
import { refreshFlockDay } from "./rollup";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export interface MovementInput {
  kind: string;
  qty: number;
  eventDate: string;
  causeCode?: string | null;
  adjustmentSign?: number | null;
  note?: string | null;
}

/**
 * Bird count per placement, as at a date, derived from movements.
 *
 * Returns a Map so callers can look up a placement they already hold rather
 * than issuing one query per card — the board asks for eleven at once.
 */
export async function placementCounts(
  tx: Tx,
  placementIds: string[],
  asOf?: string,
): Promise<Map<string, number>> {
  if (!placementIds.length) return new Map();
  const rows = await tx
    .select({
      placementId: flockMovements.placementId,
      kind: flockMovements.kind,
      qty: flockMovements.qty,
      sign: flockMovements.adjustmentSign,
    })
    .from(flockMovements)
    .where(
      and(
        inArray(flockMovements.placementId, placementIds),
        asOf ? lte(flockMovements.eventDate, asOf) : undefined,
      ),
    );
  const out = new Map(placementIds.map((id) => [id, 0]));
  for (const r of rows) {
    out.set(r.placementId, (out.get(r.placementId) ?? 0) + movementDelta(r.kind, r.qty, r.sign));
  }
  return out;
}

/** One placement's count, for the paths that genuinely only need one. */
export async function placementCount(tx: Tx, placementId: string, asOf?: string) {
  return (await placementCounts(tx, [placementId], asOf)).get(placementId) ?? 0;
}


async function liveHouse(tx: Tx, houseId: string) {
  const [h] = await tx.select().from(houses).where(eq(houses.id, houseId));
  if (!h) throw new PostingError("No such house");
  if (!h.isActive) throw new PostingError(`${h.code} is retired — nothing can be placed in it`);
  return h;
}

/**
 * The one writer of `flocks.hatch_date` and `flocks.placed_count`.
 *
 * Both are derived from `flock_hatches`. Keeping the derivation in a single
 * function is what stops them disagreeing with the rows they come from — the
 * same reason bird counts are not stored at all.
 */
export async function recomputeHatchProfile(tx: Tx, flockId: string) {
  const lines = await tx
    .select({ hatchDate: flockHatches.hatchDate, qty: flockHatches.qty })
    .from(flockHatches)
    .where(eq(flockHatches.flockId, flockId));
  const profile = hatchProfile(lines);
  if (!profile) throw new PostingError("A flock needs at least one hatch");
  await tx
    .update(flocks)
    .set({ hatchDate: profile.hatchDate, placedCount: profile.placedCount })
    .where(eq(flocks.id, flockId));
  return profile;
}

/**
 * The next flock code for a site and year: `NAL-2026-03`.
 *
 * Read off the codes that exist rather than a counter, so a deleted or
 * hand-entered flock cannot leave the sequence pointing at a number already in
 * use. Site and year are IN the code because that is what people say out loud —
 * "the second Nalbari batch of the year" — and a bare serial would send them to
 * a screen to find out which one that is.
 *
 * `flocks.code` is unique, so a race between two people opening the dialog ends
 * in a rejected insert rather than two flocks sharing a name.
 */
export async function nextFlockCode(tx: Tx, locationId: string, year: number) {
  const [site] = await tx
    .select({ code: locations.code })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!site) throw new PostingError("No such site");

  // Three letters is enough to tell Nalbari from Panbari at a glance, and keeps
  // the whole code short enough to write on a shed door.
  const prefix = `${site.code.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase()}-${year}-`;
  const taken = await tx
    .select({ code: flocks.code })
    .from(flocks)
    .where(like(flocks.code, `${prefix}%`));
  const highest = taken.reduce((max, r) => {
    const tail = r.code.slice(prefix.length);
    return /^\d+$/.test(tail) ? Math.max(max, Number(tail)) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(2, "0")}`;
}

/**
 * Place a new flock into its first house.
 *
 * Everything lands in one transaction: a flock with no placement is a cohort
 * nobody can find, and a placement with no opening movement is a house holding
 * zero birds.
 *
 * One `place` movement PER HATCH, dated on that hatch — because that is what
 * happened. Three thousand birds arriving on Monday and four on Wednesday is
 * two events, and lumping them into one dated row would make the house's count
 * wrong for two days.
 */
export async function createFlock(
  tx: Tx,
  args: {
    /** Omitted by the UI — generated from site and year. Scripts may pass one. */
    code?: string | null;
    locationId: string;
    breedId: string;
    houseId: string;
    hatches: Array<{ hatchDate: string; qty: number }>;
    note?: string | null;
    userId: string;
  },
) {
  if (!args.hatches.length) throw new PostingError("Add at least one hatch");
  if (args.hatches.some((h) => h.qty <= 0)) throw new PostingError("Every hatch needs birds");
  const dates = new Set(args.hatches.map((h) => h.hatchDate));
  if (dates.size !== args.hatches.length) {
    throw new PostingError("The same hatch date appears twice — combine them into one line");
  }
  const profile = hatchProfile(args.hatches)!;

  const house = await liveHouse(tx, args.houseId);
  if (house.locationId !== args.locationId) {
    throw new PostingError(`${house.code} is not at the site you chose`);
  }

  // The breed's default curve, pinned now and never repointed. Null if the
  // breed has none yet — that is a missing benchmark, not a reason to refuse to
  // record ten thousand real birds.
  const [defaultSet] = await tx
    .select({ id: standardSets.id })
    .from(standardSets)
    .where(and(eq(standardSets.breedId, args.breedId), eq(standardSets.isDefault, true)));

  // The year comes from when the birds hatched, not from today: a batch entered
  // in January for a December hatch belongs to the December sequence.
  const code =
    args.code?.trim() ||
    (await nextFlockCode(tx, args.locationId, Number(profile.firstHatch.slice(0, 4))));

  const [flock] = await tx
    .insert(flocks)
    .values({
      code,
      locationId: args.locationId,
      breedId: args.breedId,
      standardSetId: defaultSet?.id ?? null,
      hatchDate: profile.hatchDate,
      placedCount: profile.placedCount,
      status: "rearing",
      note: args.note?.trim() || null,
    })
    .returning();

  await tx
    .insert(flockHatches)
    .values(args.hatches.map((h) => ({ flockId: flock!.id, ...h })));

  // The placement opens on the first hatch: the house is holding birds from the
  // moment the earliest of them arrives.
  const [placement] = await tx
    .insert(flockPlacements)
    .values({ flockId: flock!.id, houseId: args.houseId, fromDate: profile.firstHatch })
    .returning();

  await tx.insert(flockMovements).values(
    args.hatches.map((h) => ({
      placementId: placement!.id,
      eventDate: h.hatchDate,
      kind: "place",
      qty: h.qty,
      recordedBy: args.userId,
    })),
  );

  await refreshFlockDay(tx, flock!.id);
  return { flock: flock!, placement: placement!, profile };
}

/**
 * Would this set of arrivals leave the house holding fewer than zero birds on
 * any day?
 *
 * Asked BEFORE anything is written. Writing first and validating after only
 * works if every caller wraps this in its own transaction and never catches the
 * error — which is a rule living in other people's code, and the kind that gets
 * broken quietly. Checking first means a refusal changes nothing, whatever the
 * caller does with it.
 *
 * A change that leaves today's count healthy can still leave a fortnight in the
 * middle where the house held minus 300 birds, so the whole ledger is walked
 * rather than just the end of it.
 */
async function firstNegativeDay(
  tx: Tx,
  placementId: string,
  proposedHatches: Array<{ hatchDate: string; qty: number }>,
) {
  const existing = await tx
    .select({
      eventDate: flockMovements.eventDate,
      kind: flockMovements.kind,
      qty: flockMovements.qty,
      sign: flockMovements.adjustmentSign,
    })
    .from(flockMovements)
    .where(eq(flockMovements.placementId, placementId));

  const ledger = [
    // The proposed arrivals replace every existing `place` row wholesale.
    ...proposedHatches.map((h) => ({ eventDate: h.hatchDate, delta: h.qty, arrival: true })),
    ...existing
      .filter((m) => m.kind !== "place")
      .map((m) => ({
        eventDate: m.eventDate,
        delta: movementDelta(m.kind, m.qty, m.sign),
        arrival: false,
      })),
  ].sort(
    (a, b) =>
      // Same day: birds arrive before anything happens to them.
      a.eventDate.localeCompare(b.eventDate) || Number(b.arrival) - Number(a.arrival),
  );

  let running = 0;
  for (const m of ledger) {
    running += m.delta;
    if (running < 0) return { day: m.eventDate, short: running };
  }
  return null;
}

/**
 * Replace a flock's hatches.
 *
 * The reason this exists: a batch is opened on the 10th and chicks keep
 * arriving until the 19th. Nobody knows the full composition on day one, so the
 * hatch list has to stay editable — and every edit moves the flock's age, since
 * age is the weighted average of exactly these lines.
 *
 * Whole-set replace rather than add/edit/delete endpoints, for the same reason
 * the standard curve is replaced whole: the set is one object, and a half-
 * applied edit is worse than a rejected one. The `place` movements are rewritten
 * to match — they are the ledger entry FOR a hatch, so they cannot be left
 * behind describing an arrival that no longer exists.
 *
 * Hatches always land in the flock's FIRST placement. Chicks arrive at the
 * house the flock was placed in; if that placement has already closed before
 * the hatch date, the birds did not arrive there and this refuses rather than
 * inventing somewhere to put them.
 */
export async function setFlockHatches(
  tx: Tx,
  flockId: string,
  lines: Array<{ hatchDate: string; qty: number }>,
  userId: string,
) {
  if (!lines.length) throw new PostingError("A flock needs at least one hatch");
  if (lines.some((l) => l.qty <= 0)) throw new PostingError("Every hatch needs birds");
  if (new Set(lines.map((l) => l.hatchDate)).size !== lines.length) {
    throw new PostingError("The same hatch date appears twice — combine them into one line");
  }

  const [flock] = await tx.select().from(flocks).where(eq(flocks.id, flockId));
  if (!flock) throw new PostingError("No such flock");
  if (flock.status === "depleted") {
    throw new PostingError("That flock is depleted — its hatches are history now");
  }

  const [first] = await tx
    .select({
      id: flockPlacements.id,
      toDate: flockPlacements.toDate,
      houseCode: houses.code,
    })
    .from(flockPlacements)
    .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
    .where(eq(flockPlacements.flockId, flockId))
    .orderBy(asc(flockPlacements.fromDate))
    .limit(1);
  if (!first) throw new PostingError("That flock has no placement");

  const profile = hatchProfile(lines)!;
  if (first.toDate && profile.lastHatch > first.toDate) {
    throw new PostingError(
      `The flock left ${first.houseCode} on ${first.toDate}, so chicks could not have arrived there on ${profile.lastHatch}`,
    );
  }

  // Everything that could refuse, refuses now — before a single row moves.
  const negative = await firstNegativeDay(tx, first.id, lines);
  if (negative) {
    throw new PostingError(
      `That would leave ${first.houseCode} holding ${negative.short.toLocaleString("en-IN")} birds on ${negative.day}. Those birds have already died or been moved out.`,
    );
  }

  await tx
    .delete(flockMovements)
    .where(and(eq(flockMovements.placementId, first.id), eq(flockMovements.kind, "place")));
  await tx.delete(flockHatches).where(eq(flockHatches.flockId, flockId));

  await tx.insert(flockHatches).values(lines.map((l) => ({ flockId, ...l })));
  await tx.insert(flockMovements).values(
    lines.map((l) => ({
      placementId: first.id,
      eventDate: l.hatchDate,
      kind: "place",
      qty: l.qty,
      recordedBy: userId,
    })),
  );

  // The house holds birds from the first arrival, whichever way that moved.
  await tx
    .update(flockPlacements)
    .set({ fromDate: profile.firstHatch })
    .where(eq(flockPlacements.id, first.id));

  await recomputeHatchProfile(tx, flockId);
  await refreshFlockDay(tx, flockId);
  return profile;
}


/** Mortality, culls, male removals and adjustments. */
export async function recordMovement(
  tx: Tx,
  args: MovementInput & { placementId: string; userId: string },
) {
  if (args.kind === "transfer_in" || args.kind === "transfer_out") {
    throw new PostingError("Use a transfer for that — it needs both ends");
  }
  if (args.qty <= 0) throw new PostingError("Enter a quantity above zero");
  if (CAUSE_REQUIRED.includes(args.kind) && !args.causeCode) {
    throw new PostingError("Say why — a mortality or cull without a cause explains nothing");
  }
  if (args.kind === "adjustment" && args.adjustmentSign !== 1 && args.adjustmentSign !== -1) {
    throw new PostingError("An adjustment has to say whether it adds or removes");
  }

  const [placement] = await tx
    .select()
    .from(flockPlacements)
    .where(eq(flockPlacements.id, args.placementId));
  if (!placement) throw new PostingError("No such placement");
  if (placement.toDate && args.eventDate > placement.toDate) {
    throw new PostingError("That date is after the flock left this house");
  }
  if (args.eventDate < placement.fromDate) {
    throw new PostingError("That date is before the flock arrived");
  }

  const delta = movementDelta(args.kind, args.qty, args.adjustmentSign);
  if (delta < 0) {
    const available = await placementCount(tx, placement.id, args.eventDate);
    if (args.qty > available) {
      throw new PostingError(
        `Only ${available.toLocaleString("en-IN")} bird(s) in the house on that date`,
      );
    }
  }

  const [row] = await tx
    .insert(flockMovements)
    .values({
      placementId: placement.id,
      eventDate: args.eventDate,
      kind: args.kind,
      qty: args.qty,
      adjustmentSign: args.kind === "adjustment" ? args.adjustmentSign : null,
      causeCode: args.causeCode ?? null,
      note: args.note ?? null,
      recordedBy: args.userId,
    })
    .returning();
  await refreshFlockDay(tx, placement.flockId);
  return row!;
}

/** The window a batch is normally housed in. Outside it is a warning, not a bar. */
export const HOUSING_WEEKS = { from: 12, to: 16 } as const;

/**
 * Would this whole set of movements ever leave a house holding fewer than zero
 * birds? Asked before anything is written.
 *
 * Simulated per HOUSE rather than per placement, because a placement may not
 * exist yet — the destination of a transfer line is created by the very
 * operation being checked. One flock can be open in a house only once, so the
 * house is a safe key.
 */
function walkForNegative(
  events: Array<{ date: string; houseId: string; houseCode: string; delta: number }>,
) {
  const sorted = [...events].sort(
    // Same day: arrivals land before departures, because birds that arrive in
    // the morning can be moved on in the afternoon.
    (a, b) => a.date.localeCompare(b.date) || b.delta - a.delta,
  );
  const running = new Map<string, number>();
  for (const e of sorted) {
    const next = (running.get(e.houseId) ?? 0) + e.delta;
    if (next < 0) return { houseCode: e.houseCode, date: e.date, short: next };
    running.set(e.houseId, next);
  }
  return null;
}

/**
 * Every movement of a flock that is NOT of the given kinds, as house-keyed
 * events — the fixed background a proposed set of lines is checked against.
 */
async function otherEvents(tx: Tx, flockId: string, excludeKinds: readonly string[]) {
  const rows = await tx
    .select({
      houseId: houses.id,
      houseCode: houses.code,
      date: flockMovements.eventDate,
      kind: flockMovements.kind,
      qty: flockMovements.qty,
      sign: flockMovements.adjustmentSign,
    })
    .from(flockMovements)
    .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
    .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
    .where(eq(flockPlacements.flockId, flockId));
  return rows
    .filter((r) => !excludeKinds.includes(r.kind))
    .map((r) => ({
      houseId: r.houseId,
      houseCode: r.houseCode,
      date: r.date,
      delta: movementDelta(r.kind, r.qty, r.sign),
    }));
}

/**
 * The flock's placement in a house, reused if it has one and created if not.
 *
 * Reuses a CLOSED placement as well as an open one. When a set of transfer
 * lines is rewritten, every placement is temporarily emptied and reopened — and
 * a version of this that only looked for open rows created a second placement
 * in a house the flock had already left, splitting one occupancy across two
 * rows and stranding the movements on the wrong one. A flock returning to a
 * house it has stood in is the same occupancy; `reconcilePlacements` decides
 * afterwards whether it is still open.
 */
async function placementIn(tx: Tx, flockId: string, houseId: string, from: string) {
  const [existing] = await tx
    .select()
    .from(flockPlacements)
    .where(and(eq(flockPlacements.flockId, flockId), eq(flockPlacements.houseId, houseId)))
    .orderBy(asc(flockPlacements.fromDate))
    .limit(1);
  if (existing) {
    // An earlier line than the placement's start drags the start back with it.
    if (from < existing.fromDate) {
      await tx
        .update(flockPlacements)
        .set({ fromDate: from })
        .where(eq(flockPlacements.id, existing.id));
      return { ...existing, fromDate: from };
    }
    return existing;
  }
  const [made] = await tx
    .insert(flockPlacements)
    .values({ flockId, houseId, fromDate: from })
    .returning();
  return made!;
}

/**
 * Reopen every placement before a set is rebuilt.
 *
 * End dates are a CONSEQUENCE of the ledger, so they are cleared and recomputed
 * rather than patched. Leaving them in place while the movements underneath
 * change is how a house ends up closed on a date nothing happened.
 */
async function reopenAll(tx: Tx, flockId: string) {
  await tx
    .update(flockPlacements)
    .set({ toDate: null })
    .where(eq(flockPlacements.flockId, flockId));
}

/** Close placements that have emptied, reopen those that have not. */
async function reconcilePlacements(tx: Tx, flockId: string) {
  const all = await tx
    .select()
    .from(flockPlacements)
    .where(eq(flockPlacements.flockId, flockId))
    .orderBy(asc(flockPlacements.fromDate));
  const counts = await placementCounts(
    tx,
    all.map((p) => p.id),
  );
  for (const p of all) {
    const left = counts.get(p.id) ?? 0;
    const moves = await tx
      .select({ date: flockMovements.eventDate })
      .from(flockMovements)
      .where(eq(flockMovements.placementId, p.id))
      .orderBy(desc(flockMovements.eventDate))
      .limit(1);
    if (left === 0 && moves.length) {
      // Emptied: it closes on the day the last bird left. A placement left open
      // at zero shows up as a house with a flock in it on every board.
      if (p.toDate !== moves[0]!.date) {
        await tx
          .update(flockPlacements)
          .set({ toDate: moves[0]!.date })
          .where(eq(flockPlacements.id, p.id));
      }
    } else if (left > 0 && p.toDate) {
      // Refilled by an edit: it is open again.
      await tx.update(flockPlacements).set({ toDate: null }).where(eq(flockPlacements.id, p.id));
    } else if (!moves.length) {
      // An edit removed every movement it ever had, so it never happened.
      await tx.delete(flockPlacements).where(eq(flockPlacements.id, p.id));
    }
  }
}

export interface TransferLine {
  eventDate: string;
  fromHouseId: string;
  toHouseId: string;
  qty: number;
}

/**
 * Replace a flock's transfers.
 *
 * Moving a batch out of rearing is not one event — it takes the best part of a
 * week, a lorry at a time, and nobody knows on the first morning how it will
 * break down. So transfers are an editable set of dated lines, exactly like
 * hatches, rather than a single act that has to be got right first time.
 *
 * Housing falls out of this rather than being its own ceremony: when the last
 * bird leaves rearing for a layer house, `housed_on` is that date. There is
 * nothing to "carry over" — feed, weighings, vaccinations and medications hang
 * off the FLOCK, not the shed, so they never move when the birds do.
 */
export async function setFlockTransfers(
  tx: Tx,
  flockId: string,
  lines: TransferLine[],
  userId: string,
) {
  const [flock] = await tx.select().from(flocks).where(eq(flocks.id, flockId));
  if (!flock) throw new PostingError("No such flock");

  const shedIds = [...new Set(lines.flatMap((l) => [l.fromHouseId, l.toHouseId]))];
  const sheds = shedIds.length
    ? await tx.select().from(houses).where(inArray(houses.id, shedIds))
    : [];
  const shedOf = new Map(sheds.map((h) => [h.id, h]));

  for (const l of lines) {
    if (l.qty <= 0) throw new PostingError("Every transfer line needs a number above zero");
    if (l.fromHouseId === l.toHouseId) throw new PostingError("A line moves birds to the same house");
    for (const id of [l.fromHouseId, l.toHouseId]) {
      const h = shedOf.get(id);
      if (!h) throw new PostingError("No such house");
      if (!h.isActive) throw new PostingError(`${h.code} is retired`);
      if (h.locationId !== flock.locationId) throw new PostingError(`${h.code} is at another site`);
    }
  }

  // Check the whole resulting ledger before touching anything.
  const background = await otherEvents(tx, flockId, ["transfer_in", "transfer_out"]);
  const proposed = lines.flatMap((l) => [
    {
      houseId: l.fromHouseId,
      houseCode: shedOf.get(l.fromHouseId)!.code,
      date: l.eventDate,
      delta: -l.qty,
    },
    {
      houseId: l.toHouseId,
      houseCode: shedOf.get(l.toHouseId)!.code,
      date: l.eventDate,
      delta: l.qty,
    },
  ]);
  const bad = walkForNegative([...background, ...proposed]);
  if (bad) {
    throw new PostingError(
      `That would leave ${bad.houseCode} holding ${bad.short.toLocaleString("en-IN")} birds on ${bad.date}.`,
    );
  }

  // Out with the old set.
  const existing = await tx
    .select({ id: flockPlacements.id })
    .from(flockPlacements)
    .where(eq(flockPlacements.flockId, flockId));
  await tx.delete(flockMovements).where(
    and(
      inArray(
        flockMovements.placementId,
        existing.map((p) => p.id),
      ),
      inArray(flockMovements.kind, ["transfer_in", "transfer_out"]),
    ),
  );

  await reopenAll(tx, flockId);

  // In with the new, oldest first so a placement opens on its earliest line.
  for (const l of [...lines].sort((a, b) => a.eventDate.localeCompare(b.eventDate))) {
    const from = await placementIn(tx, flockId, l.fromHouseId, l.eventDate);
    const to = await placementIn(tx, flockId, l.toHouseId, l.eventDate);
    await tx.insert(flockMovements).values([
      {
        placementId: from.id,
        eventDate: l.eventDate,
        kind: "transfer_out",
        qty: l.qty,
        counterpartPlacementId: to.id,
        recordedBy: userId,
      },
      {
        placementId: to.id,
        eventDate: l.eventDate,
        kind: "transfer_in",
        qty: l.qty,
        counterpartPlacementId: from.id,
        recordedBy: userId,
      },
    ]);
  }

  await reconcilePlacements(tx, flockId);

  // Housed when the rearing house finally empties into layer houses. Derived,
  // so correcting a transfer line corrects the housing date with it.
  const layerIds = new Set(sheds.filter((h) => h.purpose === "layer").map((h) => h.id));
  const intoLayers = lines.filter((l) => layerIds.has(l.toHouseId));
  let housedOn: string | null = null;
  if (intoLayers.length) {
    const rearing = [...new Set(intoLayers.map((l) => l.fromHouseId))];
    const stillThere = await tx
      .select({ id: flockPlacements.id })
      .from(flockPlacements)
      .where(
        and(
          eq(flockPlacements.flockId, flockId),
          inArray(flockPlacements.houseId, rearing),
          isNull(flockPlacements.toDate),
        ),
      );
    if (!stillThere.length) {
      housedOn = intoLayers.reduce((d, l) => (l.eventDate > d ? l.eventDate : d), intoLayers[0]!.eventDate);
    }
  }
  await tx.update(flocks).set({ housedOn }).where(eq(flocks.id, flockId));

  await refreshFlockDay(tx, flockId);
  return { housedOn, lines: lines.length };
}

export interface CullLine {
  eventDate: string;
  houseId: string;
  qty: number;
}

/**
 * Replace a flock's culling-out.
 *
 * End of life is no more a single day than the start of it: a house is emptied
 * over several days as the lorries come. Same shape as hatches and transfers —
 * an editable set of dated lines — so a batch part-way through being culled
 * reads correctly, rather than being either wholly alive or wholly gone.
 *
 * The flock is depleted when the last bird leaves, and that is derived: remove
 * a cull line and it is live again, which is what somebody correcting a
 * mistyped lorry actually means.
 */
export async function setFlockCulls(tx: Tx, flockId: string, lines: CullLine[], userId: string) {
  const [flock] = await tx.select().from(flocks).where(eq(flocks.id, flockId));
  if (!flock) throw new PostingError("No such flock");

  const shedIds = [...new Set(lines.map((l) => l.houseId))];
  const sheds = shedIds.length
    ? await tx.select().from(houses).where(inArray(houses.id, shedIds))
    : [];
  const shedOf = new Map(sheds.map((h) => [h.id, h]));
  for (const l of lines) {
    if (l.qty <= 0) throw new PostingError("Every culling line needs a number above zero");
    if (!shedOf.has(l.houseId)) throw new PostingError("No such house");
  }

  const background = await otherEvents(tx, flockId, ["depletion"]);
  const proposed = lines.map((l) => ({
    houseId: l.houseId,
    houseCode: shedOf.get(l.houseId)!.code,
    date: l.eventDate,
    delta: -l.qty,
  }));
  const bad = walkForNegative([...background, ...proposed]);
  if (bad) {
    throw new PostingError(
      `That would leave ${bad.houseCode} holding ${bad.short.toLocaleString("en-IN")} birds on ${bad.date}.`,
    );
  }

  const placements = await tx
    .select({ id: flockPlacements.id, houseId: flockPlacements.houseId })
    .from(flockPlacements)
    .where(eq(flockPlacements.flockId, flockId));
  await tx.delete(flockMovements).where(
    and(
      inArray(
        flockMovements.placementId,
        placements.map((p) => p.id),
      ),
      eq(flockMovements.kind, "depletion"),
    ),
  );

  await reopenAll(tx, flockId);

  for (const l of lines) {
    const placement = placements.find((p) => p.houseId === l.houseId);
    if (!placement) throw new PostingError("That flock was never in that house");
    await tx.insert(flockMovements).values({
      placementId: placement.id,
      eventDate: l.eventDate,
      kind: "depletion",
      qty: l.qty,
      recordedBy: userId,
    });
  }

  await reconcilePlacements(tx, flockId);

  // Depleted only when nothing is left anywhere.
  const after = await tx
    .select({ id: flockPlacements.id })
    .from(flockPlacements)
    .where(eq(flockPlacements.flockId, flockId));
  const counts = await placementCounts(
    tx,
    after.map((p) => p.id),
  );
  const alive = [...counts.values()].reduce((n, v) => n + v, 0);
  const lastDay = lines.reduce((d, l) => (l.eventDate > d ? l.eventDate : d), lines[0]?.eventDate ?? "");
  const [updated] = await tx
    .update(flocks)
    .set(
      alive === 0 && lines.length
        ? { status: "depleted", depletedOn: lastDay }
        : { status: flock.layStartDate ? "laying" : "rearing", depletedOn: null },
    )
    .where(eq(flocks.id, flockId))
    .returning();

  await refreshFlockDay(tx, flockId);
  return { flock: updated!, remaining: alive, lines: lines.length };
}

/**
 * What is being handed over: the state of the flock on a given day.
 *
 * Everything here is derived from the movement ledger, which is the reason the
 * handover needs no copying at all. Feed, weighings, vaccinations and
 * medications hang off the FLOCK, not the house it happens to be standing in —
 * so when the birds walk from P1 to L4 their records do not move, because they
 * were never in P1 to begin with. The old model kept them against the shed,
 * which is exactly why housing used to mean re-keying everything and why every
 * lifetime figure restarted at the move.
 *
 * (Feed deliveries, bird weighings, vaccination events and medication courses
 * are Phase 3/4 tables and do not exist yet. They will appear in this summary
 * without a migration, because they attach to the flock.)
 */
export async function handoverSummary(tx: Tx, flockId: string, on: string) {
  const [flock] = await tx.select().from(flocks).where(eq(flocks.id, flockId));
  if (!flock) throw new PostingError("No such flock");

  const rows = await tx
    .select({
      placementId: flockMovements.placementId,
      houseCode: houses.code,
      eventDate: flockMovements.eventDate,
      kind: flockMovements.kind,
      qty: flockMovements.qty,
      sign: flockMovements.adjustmentSign,
      causeCode: flockMovements.causeCode,
      causeLabel: mortalityCauses.label,
      toDate: flockPlacements.toDate,
    })
    .from(flockMovements)
    .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
    .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
    .leftJoin(mortalityCauses, eq(mortalityCauses.code, flockMovements.causeCode))
    .where(and(eq(flockPlacements.flockId, flockId), lte(flockMovements.eventDate, on)));

  const byHouse = new Map<string, { houseCode: string; placementId: string; birds: number; open: boolean }>();
  const byCause = new Map<string, number>();
  let lost = 0;
  for (const m of rows) {
    const slot = byHouse.get(m.placementId) ?? {
      houseCode: m.houseCode,
      placementId: m.placementId,
      birds: 0,
      open: !m.toDate,
    };
    slot.birds += movementDelta(m.kind, m.qty, m.sign);
    byHouse.set(m.placementId, slot);
    if (m.kind === "mortality" || m.kind === "cull") {
      lost += m.qty;
      const label = m.causeLabel ?? m.causeCode ?? "Unknown";
      byCause.set(label, (byCause.get(label) ?? 0) + m.qty);
    }
  }

  const birds = [...byHouse.values()].reduce((n, h) => n + h.birds, 0);
  const age = ageOn(flock.hatchDate, on);
  return {
    flockCode: flock.code,
    on,
    age,
    /** Whether the batch is inside the usual 12–16 week housing window. */
    inWindow: age.weeks >= HOUSING_WEEKS.from && age.weeks <= HOUSING_WEEKS.to,
    placedCount: flock.placedCount,
    birds,
    lost,
    cumMortalityPct: flock.placedCount ? (lost / flock.placedCount) * 100 : 0,
    liveabilityPct: flock.placedCount ? (birds / flock.placedCount) * 100 : 0,
    houses: [...byHouse.values()].filter((h) => h.open && h.birds > 0),
    causes: [...byCause.entries()]
      .map(([label, qty]) => ({ label, qty }))
      .sort((a, b) => b.qty - a.qty),
  };
}


/**
 * The flock comes into lay.
 *
 * Recorded on the flock, not derived from the house it moved to: a pullet house
 * genuinely produces at point of lay before transfer, and a flock housed into a
 * layer shed at 16 weeks is not laying on the day it arrives.
 */
export async function startLay(tx: Tx, flockId: string, on: string) {
  const [flock] = await tx.select().from(flocks).where(eq(flocks.id, flockId));
  if (!flock) throw new PostingError("No such flock");
  if (flock.status === "depleted") throw new PostingError("That flock is depleted");
  if (on < flock.hatchDate) throw new PostingError("Lay cannot start before the hatch date");
  const [row] = await tx
    .update(flocks)
    .set({ status: "laying", layStartDate: on })
    .where(eq(flocks.id, flockId))
    .returning();
  // Every day from here on is in lay, and the phase is stamped on the row.
  await refreshFlockDay(tx, flockId);
  return row!;
}


/**
 * Age in weeks and days on a given date. Day 0 is the hatch date, so a flock
 * hatched today is "0w 0d" rather than a week old.
 */
export function ageOn(hatchDate: string, on: string) {
  const days = Math.floor(
    (Date.parse(`${on}T00:00:00Z`) - Date.parse(`${hatchDate}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 0) return { days: 0, weeks: 0, rem: 0, label: "—" };
  const weeks = Math.floor(days / 7);
  const rem = days % 7;
  return { days, weeks, rem, label: `${weeks}w ${rem}d` };
}

/** The age week a standard point is keyed by. Week 1 is the first week of life. */
export function ageWeekOn(hatchDate: string, on: string) {
  return Math.floor(ageOn(hatchDate, on).days / 7) + 1;
}

/** Placements open on a date, with their house, flock and derived count. */
export async function boardRows(tx: Tx, on: string) {
  const rows = await tx
    .select({
      placementId: flockPlacements.id,
      fromDate: flockPlacements.fromDate,
      houseId: houses.id,
      houseCode: houses.code,
      housePurpose: houses.purpose,
      houseOwnerId: houses.ownerId,
      locationName: sql<string>`(SELECT name FROM locations WHERE id = ${houses.locationId})`,
      flockId: flocks.id,
      flockCode: flocks.code,
      flockStatus: flocks.status,
      hatchDate: flocks.hatchDate,
      standardSetId: flocks.standardSetId,
      breedName: sql<string>`(SELECT name FROM breeds WHERE id = ${flocks.breedId})`,
    })
    .from(flockPlacements)
    .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
    .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
    .where(
      and(
        lte(flockPlacements.fromDate, on),
        sql`(${flockPlacements.toDate} IS NULL OR ${flockPlacements.toDate} >= ${on})`,
      ),
    )
    .orderBy(asc(houses.code));

  const counts = await placementCounts(
    tx,
    rows.map((r) => r.placementId),
    on,
  );
  return rows.map((r) => ({
    ...r,
    birds: counts.get(r.placementId) ?? 0,
    age: ageOn(r.hatchDate, on),
  }));
}
