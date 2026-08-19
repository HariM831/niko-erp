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
import { and, asc, eq, inArray, isNull, like, lte, sql } from "drizzle-orm";
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

/** The open placements of a flock, oldest first. */
async function openPlacements(tx: Tx, flockId: string) {
  return tx
    .select()
    .from(flockPlacements)
    .where(and(eq(flockPlacements.flockId, flockId), isNull(flockPlacements.toDate)))
    .orderBy(asc(flockPlacements.fromDate));
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
  return profile;
}

/**
 * Move birds from one house to another.
 *
 * A partial transfer leaves the source open with the remainder; a full one
 * closes it. Either way two movements are written against the same date, so the
 * flock's total is unchanged by the move itself — which is what makes lifetime
 * mortality continuous across a house change, the thing the old model got
 * wrong.
 */
export async function transferBirds(
  tx: Tx,
  args: {
    placementId: string;
    toHouseId: string;
    qty: number;
    eventDate: string;
    note?: string | null;
    userId: string;
  },
) {
  const [from] = await tx
    .select()
    .from(flockPlacements)
    .where(eq(flockPlacements.id, args.placementId));
  if (!from) throw new PostingError("No such placement");
  if (from.toDate) throw new PostingError("That placement is already closed");
  if (args.qty <= 0) throw new PostingError("Transfer at least one bird");
  if (args.eventDate < from.fromDate) {
    throw new PostingError("A transfer cannot pre-date the placement it leaves");
  }
  if (from.houseId === args.toHouseId) throw new PostingError("That is the same house");

  const available = await placementCount(tx, from.id, args.eventDate);
  if (args.qty > available) {
    throw new PostingError(`Only ${available.toLocaleString("en-IN")} bird(s) in that house`);
  }
  await liveHouse(tx, args.toHouseId);

  // Re-enter a house the flock already occupies rather than opening a second
  // placement beside it — the partial unique index would refuse anyway, and one
  // house holding one flock twice is not a thing.
  const [existing] = await tx
    .select()
    .from(flockPlacements)
    .where(
      and(
        eq(flockPlacements.flockId, from.flockId),
        eq(flockPlacements.houseId, args.toHouseId),
        isNull(flockPlacements.toDate),
      ),
    );
  const to =
    existing ??
    (
      await tx
        .insert(flockPlacements)
        .values({
          flockId: from.flockId,
          houseId: args.toHouseId,
          fromDate: args.eventDate,
          note: args.note ?? null,
        })
        .returning()
    )[0]!;

  await tx.insert(flockMovements).values([
    {
      placementId: from.id,
      eventDate: args.eventDate,
      kind: "transfer_out",
      qty: args.qty,
      counterpartPlacementId: to.id,
      note: args.note ?? null,
      recordedBy: args.userId,
    },
    {
      placementId: to.id,
      eventDate: args.eventDate,
      kind: "transfer_in",
      qty: args.qty,
      counterpartPlacementId: from.id,
      note: args.note ?? null,
      recordedBy: args.userId,
    },
  ]);

  // Emptied by the move: close it. A placement left open at zero shows up as a
  // house with a flock in it on every board.
  if (args.qty === available) {
    await tx
      .update(flockPlacements)
      .set({ toDate: args.eventDate })
      .where(eq(flockPlacements.id, from.id));
  }

  return { fromPlacementId: from.id, toPlacementId: to.id, closed: args.qty === available };
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
  return row!;
}

/** The window a batch is normally housed in. Outside it is a warning, not a bar. */
export const HOUSING_WEEKS = { from: 12, to: 16 } as const;

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
 * Housing — the move out of rearing and into the layer house(s).
 *
 * The one ceremony in a flock's life where it changes hands. It is a transfer
 * underneath, but a specific one, and giving it its own operation buys three
 * things a bare transfer does not:
 *
 *  - **It is all-or-nothing.** The quantities must add up to every bird in the
 *    rearing house. Housing that leaves 200 birds behind in P1 is not a clean
 *    handover, it is a mess two teams will argue about in a month.
 *  - **It only goes to layer houses.** Housing a batch into another pullet shed
 *    is a transfer, not housing, and calling it housing would put a false date
 *    on the flock.
 *  - **It stamps `housed_on`**, which anchors every rearing-phase figure in the
 *    lifetime report.
 *
 * Splitting across several layer houses is ordinary — one rearing shed usually
 * fills two laying sheds — so it takes a list, and all of it lands in one
 * transaction.
 */
export async function houseFlock(
  tx: Tx,
  args: {
    flockId: string;
    placementId: string;
    moves: Array<{ toHouseId: string; qty: number }>;
    on: string;
    note?: string | null;
    userId: string;
  },
) {
  if (!args.moves.length) throw new PostingError("Say which layer house the birds go to");

  const [flock] = await tx.select().from(flocks).where(eq(flocks.id, args.flockId));
  if (!flock) throw new PostingError("No such flock");
  if (flock.status === "depleted") throw new PostingError("That flock is depleted");
  if (flock.housedOn) {
    throw new PostingError(
      `${flock.code} was already housed on ${flock.housedOn}. Use a transfer to move it again.`,
    );
  }

  // Every destination must be a layer house at the flock's own site.
  for (const m of args.moves) {
    const house = await liveHouse(tx, m.toHouseId);
    if (house.purpose !== "layer") {
      throw new PostingError(
        `${house.code} is a ${house.purpose} house. Housing goes into a layer house — use a transfer for anything else.`,
      );
    }
    if (house.locationId !== flock.locationId) {
      throw new PostingError(`${house.code} is at another site`);
    }
  }

  const available = await placementCount(tx, args.placementId, args.on);
  const moving = args.moves.reduce((n, m) => n + m.qty, 0);
  if (moving !== available) {
    throw new PostingError(
      `The rearing house holds ${available.toLocaleString("en-IN")} birds and you have allocated ${moving.toLocaleString("en-IN")}. Housing moves the whole batch — every bird has to have somewhere to go.`,
    );
  }

  const handover = await handoverSummary(tx, args.flockId, args.on);
  const results = [];
  for (const m of args.moves) {
    results.push(
      await transferBirds(tx, {
        placementId: args.placementId,
        toHouseId: m.toHouseId,
        qty: m.qty,
        eventDate: args.on,
        note: args.note ?? "Housed",
        userId: args.userId,
      }),
    );
  }

  // Status stays "rearing": housed at 14 weeks is not laying at 14 weeks. Lay
  // is its own event, recorded when the first eggs actually appear.
  const [updated] = await tx
    .update(flocks)
    .set({ housedOn: args.on })
    .where(eq(flocks.id, args.flockId))
    .returning();

  return { flock: updated!, handover, moves: results };
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
  return row!;
}

/**
 * End of life. Every open placement is emptied by an explicit `depletion`
 * movement and then closed, so the count reaches zero through the ledger rather
 * than by a flag that contradicts it.
 */
export async function depleteFlock(tx: Tx, flockId: string, on: string, userId: string) {
  const [flock] = await tx.select().from(flocks).where(eq(flocks.id, flockId));
  if (!flock) throw new PostingError("No such flock");
  if (flock.status === "depleted") throw new PostingError("That flock is already depleted");

  const open = await openPlacements(tx, flockId);
  const counts = await placementCounts(
    tx,
    open.map((p) => p.id),
    on,
  );
  for (const p of open) {
    if (on < p.fromDate) {
      throw new PostingError("That date is before the flock arrived in one of its houses");
    }
    const left = counts.get(p.id) ?? 0;
    if (left > 0) {
      await tx.insert(flockMovements).values({
        placementId: p.id,
        eventDate: on,
        kind: "depletion",
        qty: left,
        recordedBy: userId,
      });
    }
    await tx.update(flockPlacements).set({ toDate: on }).where(eq(flockPlacements.id, p.id));
  }

  const [row] = await tx
    .update(flocks)
    .set({ status: "depleted", depletedOn: on })
    .where(eq(flocks.id, flockId))
    .returning();
  return { flock: row!, placementsClosed: open.length };
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
