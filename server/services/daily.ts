/**
 * Daily records — what a house was fed, drank, laid and lost, one day at a time.
 *
 * Kept apart from the flock lifecycle. Placing a batch, housing it and depleting
 * it happen a handful of times in a flock's life and are set up deliberately;
 * this is the screen somebody fills in every morning for eleven houses on a
 * phone. Mixing the two puts a daily field next to a once-a-lifetime one and
 * invites both to be got wrong.
 *
 * A save writes TWO tables in one transaction: `placement_days` for the
 * quantities, and `flock_movements` for the birds lost. Mortality lives in the
 * ledger rather than in a column here so it can carry a cause, and so the bird
 * count keeps coming from one place.
 *
 * Saving a day is REPLACE, not append. The form shows what is already recorded
 * and saves the whole day back, so pressing save twice leaves one day's worth
 * of records rather than two — the single most common way daily entry goes
 * wrong.
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  CAUSE_REQUIRED,
  feedTransfers,
  flockMovements,
  flockPlacements,
  flocks,
  houses,
  movementDelta,
  placementDays,
} from "@shared/schema";
import type { db as Db } from "../db";
import { PostingError } from "./posting";
import { ageOn, placementCounts } from "./flocks";
import { refreshFlockDay } from "./rollup";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** The kinds this screen owns. Transfers and adjustments are not daily events. */
export const DAILY_KINDS = ["mortality", "cull", "male_removal"] as const;

export interface LossLine {
  kind: (typeof DAILY_KINDS)[number];
  qty: number;
  /**
   * The form ported from the farm's own app does not ask why — so a row that
   * does not say falls back to "unknown" rather than being refused. The column
   * and its CHECK stay, so the day causes start being recorded nothing has to
   * change underneath.
   */
  causeCode?: string | null;
  note?: string | null;
}

/** What a row without a stated cause is recorded as. */
const UNSTATED_CAUSE = "unknown";

export interface DayInput {
  placementId: string;
  day: string;
  feedConsumedKg?: string | null;
  feedClosingKg?: string | null;
  waterKl?: string | null;
  eggsTotal?: number | null;
  eggsCracked?: number | null;
  eggsDirty?: number | null;
  note?: string | null;
  losses: LossLine[];
}

/**
 * Every open house on a day, with what has been recorded for it.
 *
 * Houses with no entry come back too, with `entered: false`. A screen that only
 * lists what has been filled in cannot show you what has not, and the missing
 * house is the entire point of looking.
 */
export async function dayBoard(tx: Tx, day: string) {
  const placements = await tx
    .select({
      placementId: flockPlacements.id,
      fromDate: flockPlacements.fromDate,
      houseId: houses.id,
      houseCode: houses.code,
      housePurpose: houses.purpose,
      flockId: flocks.id,
      flockCode: flocks.code,
      hatchDate: flocks.hatchDate,
      layStartDate: flocks.layStartDate,
      locationName: sql<string>`(SELECT name FROM locations WHERE id = ${houses.locationId})`,
    })
    .from(flockPlacements)
    .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
    .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
    .where(
      and(
        lte(flockPlacements.fromDate, day),
        sql`(${flockPlacements.toDate} IS NULL OR ${flockPlacements.toDate} >= ${day})`,
      ),
    )
    .orderBy(asc(houses.code));

  const ids = placements.map((p) => p.placementId);
  if (!ids.length) return { day, rows: [], entered: 0 };

  // Sequential, not Promise.all. A transaction is a single connection, and
  // firing four queries at it concurrently makes node-postgres queue them
  // anyway while warning that the client is already executing — the
  // parallelism is imaginary and the warning is real.
  const days = await tx
    .select()
    .from(placementDays)
    .where(and(inArray(placementDays.placementId, ids), eq(placementDays.day, day)));

  const losses = await tx
    .select({
      placementId: flockMovements.placementId,
      kind: flockMovements.kind,
      qty: flockMovements.qty,
      causeCode: flockMovements.causeCode,
      note: flockMovements.note,
    })
    .from(flockMovements)
    .where(
      and(
        inArray(flockMovements.placementId, ids),
        eq(flockMovements.eventDate, day),
        inArray(flockMovements.kind, [...DAILY_KINDS]),
      ),
    );

  const counts = await placementCounts(tx, ids, day);
  // Opening is the closing count of the day before — the farm's own form shows
  // both, and seeing them either side of the entry is what catches a fat finger.
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const opening = await placementCounts(tx, ids, prev);

  // Feed DELIVERED is not typed here. It is the mill's transfer into this house,
  // which already exists as a real stock movement with a cost on it; a second
  // hand-keyed number beside it would be a second answer to the same question.
  const delivered = await tx
    .select({
      houseId: feedTransfers.toHouseId,
      kg: sql<string>`sum(${feedTransfers.quantityKg})`,
    })
    .from(feedTransfers)
    .where(
      and(
        inArray(
          feedTransfers.toHouseId,
          placements.map((p) => p.houseId),
        ),
        eq(feedTransfers.transferDate, day),
      ),
    )
    .groupBy(feedTransfers.toHouseId);
  const deliveredOf = new Map(delivered.map((d) => [d.houseId, d.kg]));

  // Yesterday's feed is a hint, not a default — it saves typing on a house
  // whose intake is steady without quietly inventing a number for one whose
  // is not.
  const yesterday = await tx
    .select({
      placementId: placementDays.placementId,
      feedConsumedKg: placementDays.feedConsumedKg,
    })
    .from(placementDays)
    .where(
      and(inArray(placementDays.placementId, ids), sql`${placementDays.day} = ${day}::date - 1`),
    );

  const dayOf = new Map(days.map((d) => [d.placementId, d]));
  const hintOf = new Map(yesterday.map((d) => [d.placementId, d.feedConsumedKg]));
  const lossOf = new Map<string, LossLine[]>();
  for (const l of losses) {
    const list = lossOf.get(l.placementId) ?? [];
    list.push({ kind: l.kind as LossLine["kind"], qty: l.qty, causeCode: l.causeCode, note: l.note });
    lossOf.set(l.placementId, list);
  }

  const rows = placements.map((p) => {
    const entry = dayOf.get(p.placementId);
    const age = ageOn(p.hatchDate, day);
    return {
      ...p,
      age,
      birds: counts.get(p.placementId) ?? 0,
      openingBirds: opening.get(p.placementId) ?? 0,
      feedDeliveredKg: deliveredOf.get(p.houseId) ?? null,
      entered: !!entry,
      day: entry ?? null,
      losses: lossOf.get(p.placementId) ?? [],
      feedHint: hintOf.get(p.placementId) ?? null,
      /**
       * Whether to offer the egg fields. Around 16 weeks a pullet house starts
       * producing, so the cut-off is age rather than the kind of shed — and a
       * flock already recorded as laying always shows them.
       */
      expectEggs: !!p.layStartDate || age.weeks >= 16,
    };
  });

  return { day, rows, entered: rows.filter((r) => r.entered).length };
}

const money = (v: string | null | undefined) => (v === "" || v == null ? null : v);

/**
 * Save one house's day.
 *
 * Replaces rather than appends: the day's mortality rows are deleted and
 * rewritten from what the form holds. That is what makes a correction a
 * correction instead of a second helping, and it is why this screen owns
 * mortality outright — nothing else writes those kinds.
 */
export async function saveDay(tx: Tx, input: DayInput, userId: string) {
  const [placement] = await tx
    .select({
      id: flockPlacements.id,
      flockId: flockPlacements.flockId,
      fromDate: flockPlacements.fromDate,
      toDate: flockPlacements.toDate,
      houseCode: houses.code,
    })
    .from(flockPlacements)
    .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
    .where(eq(flockPlacements.id, input.placementId));
  if (!placement) throw new PostingError("No such placement");
  if (input.day < placement.fromDate) {
    throw new PostingError(`The flock was not in ${placement.houseCode} on ${input.day}`);
  }
  if (placement.toDate && input.day > placement.toDate) {
    throw new PostingError(`The flock had left ${placement.houseCode} by ${input.day}`);
  }

  for (const l of input.losses) {
    if (l.qty <= 0) throw new PostingError("A loss line needs a number above zero");

  }

  // How many birds the house holds on the day, ignoring the losses being
  // replaced — otherwise a re-save would compare against a count that already
  // has the old numbers taken out of it and refuse a perfectly good edit.
  const others = await tx
    .select({
      kind: flockMovements.kind,
      qty: flockMovements.qty,
      sign: flockMovements.adjustmentSign,
      eventDate: flockMovements.eventDate,
    })
    .from(flockMovements)
    .where(and(eq(flockMovements.placementId, placement.id), lte(flockMovements.eventDate, input.day)));
  const withoutTodaysLosses = others
    .filter((m) => !(m.eventDate === input.day && (DAILY_KINDS as readonly string[]).includes(m.kind)))
    .reduce((n, m) => n + movementDelta(m.kind, m.qty, m.sign), 0);
  const losing = input.losses.reduce((n, l) => n + l.qty, 0);
  if (losing > withoutTodaysLosses) {
    throw new PostingError(
      `${placement.houseCode} held ${withoutTodaysLosses.toLocaleString("en-IN")} birds on ${input.day} — you cannot lose ${losing.toLocaleString("en-IN")}.`,
    );
  }

  await tx
    .insert(placementDays)
    .values({
      placementId: placement.id,
      day: input.day,
      feedConsumedKg: money(input.feedConsumedKg),
      feedClosingKg: money(input.feedClosingKg),
      waterKl: money(input.waterKl),
      eggsTotal: input.eggsTotal ?? null,
      eggsCracked: input.eggsCracked ?? null,
      eggsDirty: input.eggsDirty ?? null,
      note: input.note?.trim() || null,
      recordedBy: userId,
    })
    .onConflictDoUpdate({
      target: [placementDays.placementId, placementDays.day],
      set: {
        feedConsumedKg: money(input.feedConsumedKg),
        feedClosingKg: money(input.feedClosingKg),
        waterKl: money(input.waterKl),
        eggsTotal: input.eggsTotal ?? null,
        eggsCracked: input.eggsCracked ?? null,
        eggsDirty: input.eggsDirty ?? null,
        note: input.note?.trim() || null,
        recordedBy: userId,
        updatedAt: new Date(),
      },
    });

  await tx
    .delete(flockMovements)
    .where(
      and(
        eq(flockMovements.placementId, placement.id),
        eq(flockMovements.eventDate, input.day),
        inArray(flockMovements.kind, [...DAILY_KINDS]),
      ),
    );
  if (input.losses.length) {
    await tx.insert(flockMovements).values(
      input.losses.map((l) => ({
        placementId: placement.id,
        eventDate: input.day,
        kind: l.kind,
        qty: l.qty,
        causeCode: CAUSE_REQUIRED.includes(l.kind)
          ? (l.causeCode ?? UNSTATED_CAUSE)
          : (l.causeCode ?? null),
        note: l.note?.trim() || null,
        recordedBy: userId,
      })),
    );
  }

  // The reporting surface is rebuilt inside the same transaction, so it either
  // agrees with the ledger or neither of them happened.
  await refreshFlockDay(tx, placement.flockId);

  return { placementId: placement.id, day: input.day, lost: losing };
}
