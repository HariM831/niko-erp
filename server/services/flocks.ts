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
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  CAUSE_REQUIRED,
  flockMovements,
  flockPlacements,
  flocks,
  houses,
  movementDelta,
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
 * Place a new flock into its first house.
 *
 * The flock, the placement and the opening `place` movement are one
 * transaction: a flock with no placement is a cohort nobody can find, and a
 * placement with no opening movement is a house holding zero birds.
 */
export async function createFlock(
  tx: Tx,
  args: {
    code: string;
    locationId: string;
    breedId: string;
    standardSetId: string;
    houseId: string;
    hatchDate: string;
    fromDate: string;
    origin: string;
    originRef?: string | null;
    placedCount: number;
    note?: string | null;
    userId: string;
  },
) {
  if (args.placedCount <= 0) throw new PostingError("Place at least one bird");
  if (args.fromDate < args.hatchDate) {
    throw new PostingError("A flock cannot be placed before it hatched");
  }
  const house = await liveHouse(tx, args.houseId);
  if (house.locationId !== args.locationId) {
    throw new PostingError(`${house.code} is not at the site you chose`);
  }

  const [flock] = await tx
    .insert(flocks)
    .values({
      code: args.code.trim(),
      locationId: args.locationId,
      breedId: args.breedId,
      standardSetId: args.standardSetId,
      hatchDate: args.hatchDate,
      origin: args.origin,
      originRef: args.originRef ?? null,
      placedCount: args.placedCount,
      // Purchased pullets can arrive already laying, but that is a decision for
      // whoever places them — the default is the honest one.
      status: "rearing",
      note: args.note ?? null,
    })
    .returning();

  const [placement] = await tx
    .insert(flockPlacements)
    .values({ flockId: flock!.id, houseId: args.houseId, fromDate: args.fromDate })
    .returning();

  await tx.insert(flockMovements).values({
    placementId: placement!.id,
    eventDate: args.fromDate,
    kind: "place",
    qty: args.placedCount,
    recordedBy: args.userId,
  });

  return { flock: flock!, placement: placement! };
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
