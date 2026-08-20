/**
 * The Houses screen's data, in the shapes the farm's own app used.
 *
 * The screen itself is a port — markup, tiles, modals and every calculation
 * carried over unchanged, because the people reading it every morning know it
 * and the data coming across was recorded through it. Keeping the page verbatim
 * means giving it the five collections it expects, so the adapting happens
 * HERE, once, instead of being smeared through a thousand lines of JSX where
 * every edit would risk changing a number on screen.
 *
 * The mapping, and why it reproduces the same figures:
 *
 *   sheds            ← houses
 *   stocks           ← flock_placements  (one "batch" per placement)
 *   records          ← placement_days + the movement ledger, per day
 *   breedStandards   ← standard_points of the flock's pinned set
 *   formulaTransfers ← feed_transfers into the house
 *
 * The old app computed a shed's closing count as
 *     opening + transferredIn − mortality − transferredOut − culled − male
 * so `openingCount` here carries ONLY the `place` movements and the daily rows
 * carry everything else. Add them up and you get exactly what the EGGSY ledger
 * says, because both are summing the same movements — just grouped differently.
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  breeds,
  feedTransfers,
  flockMovements,
  flockPlacements,
  flocks,
  houses,
  items,
  placementDays,
  standardPoints,
  standardSets,
} from "@shared/schema";
import type { db as Db } from "../db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

const num = (v: string | number | null) => (v == null ? 0 : Number(v));

export async function housesBoard(tx: Tx) {
  // ── Sheds ──
  const shedRows = await tx
    .select({
      id: houses.id,
      name: houses.code,
      type: houses.purpose,
      displayOrder: houses.displayOrder,
      farmName: sql<string>`(SELECT name FROM locations WHERE id = ${houses.locationId})`,
    })
    .from(houses)
    .where(eq(houses.isActive, true))
    .orderBy(asc(houses.displayOrder), asc(houses.code));

  // ── Batches: one per placement ──
  const placementRows = await tx
    .select({
      id: flockPlacements.id,
      shedId: flockPlacements.houseId,
      dateIn: flockPlacements.fromDate,
      batchNumber: flocks.code,
      /** The flock's bird-weighted average hatch date — what drives the age. */
      batchBirthDate: flocks.hatchDate,
      breedId: flocks.breedId,
      status: flocks.status,
      /** Only the `place` movements; every later change arrives as a daily row. */
      openingCount: sql<number>`coalesce((
        SELECT sum(m.qty) FROM flock_movements m
        WHERE m.placement_id = ${flockPlacements.id} AND m.kind = 'place'), 0)::int`,
    })
    .from(flockPlacements)
    .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
    .orderBy(asc(flockPlacements.fromDate));

  const stocks: Record<string, unknown[]> = {};
  for (const p of placementRows) {
    (stocks[p.shedId] ??= []).push({
      id: p.id,
      shedId: p.shedId,
      dateIn: p.dateIn,
      openingCount: p.openingCount,
      batchNumber: p.batchNumber,
      batchBirthDate: p.batchBirthDate,
      breedId: p.breedId,
      isActive: p.status !== "depleted",
    });
  }

  // ── Daily rows: the entered figures plus that day's movements ──
  //
  // A day appears if EITHER was recorded. A house can lose birds on a day
  // nobody entered feed for, and dropping those rows would quietly lose the
  // mortality from every total on the page.
  const dayRows = await tx.execute(sql`
    WITH days AS (
      SELECT placement_id, day FROM placement_days
      UNION
      SELECT placement_id, event_date AS day FROM flock_movements
       WHERE kind IN ('mortality','cull','male_removal','transfer_in','transfer_out','depletion')
    )
    SELECT
      d.placement_id                                   AS "placementId",
      p.house_id                                       AS "shedId",
      f.code                                           AS "batchNumber",
      to_char(d.day, 'YYYY-MM-DD')                     AS "date",
      coalesce(pd.feed_consumed_kg, 0)::float8         AS "feedIntakeKg",
      coalesce(pd.feed_closing_kg, 0)::float8          AS "feedStockKg",
      coalesce(pd.water_upper_kl, 0)::float8           AS "waterUpperKl",
      coalesce(pd.water_lower_kl, 0)::float8           AS "waterLowerKl",
      coalesce(pd.eggs_total, 0)::int                  AS "eggsProduced",
      coalesce(SUM(m.qty) FILTER (WHERE m.kind = 'mortality'), 0)::int      AS "mortality",
      coalesce(SUM(m.qty) FILTER (WHERE m.kind = 'cull'), 0)::int           AS "birdsCulled",
      coalesce(SUM(m.qty) FILTER (WHERE m.kind = 'male_removal'), 0)::int   AS "maleBirds",
      coalesce(SUM(m.qty) FILTER (WHERE m.kind = 'transfer_in'), 0)::int    AS "birdsTransferredIn",
      coalesce(SUM(m.qty) FILTER (WHERE m.kind IN ('transfer_out','depletion')), 0)::int
                                                                            AS "birdsTransferredOut"
    FROM days d
    JOIN flock_placements p ON p.id = d.placement_id
    JOIN flocks f           ON f.id = p.flock_id
    LEFT JOIN placement_days pd ON pd.placement_id = d.placement_id AND pd.day = d.day
    LEFT JOIN flock_movements m ON m.placement_id = d.placement_id AND m.event_date = d.day
    GROUP BY d.placement_id, p.house_id, f.code, d.day,
             pd.feed_consumed_kg, pd.feed_closing_kg, pd.water_upper_kl,
             pd.water_lower_kl, pd.eggs_total
    ORDER BY d.day DESC`);

  const records: Record<string, unknown[]> = {};
  for (const r of dayRows.rows as Array<Record<string, unknown>>) {
    (records[r.shedId as string] ??= []).push({ ...r, id: `${r.placementId}:${r.date}` });
  }

  // ── Breeds and their curves ──
  const breedRows = await tx
    .select({ id: breeds.id, name: breeds.name })
    .from(breeds)
    .orderBy(asc(breeds.name));

  // Only the default set per breed: the old screen looked standards up by breed
  // and week, with no notion of versions.
  const pointRows = await tx
    .select({
      breedId: standardSets.breedId,
      weekNumber: standardPoints.ageWeek,
      feedGramsPerBird: standardPoints.feedGPerBirdDay,
      waterMlPerBird: standardPoints.waterMlPerBirdDay,
      eggPercentage: standardPoints.layPct,
      mortalityPercent: standardPoints.cumMortalityPct,
      bodyWeightGrams: standardPoints.bodyWeightG,
    })
    .from(standardPoints)
    .innerJoin(standardSets, eq(standardSets.id, standardPoints.setId))
    .where(eq(standardSets.isDefault, true))
    .orderBy(asc(standardPoints.ageWeek));

  const breedStandards: Record<string, unknown[]> = {};
  for (const p of pointRows) {
    (breedStandards[p.breedId] ??= []).push({
      id: `${p.breedId}:${p.weekNumber}`,
      breedId: p.breedId,
      weekNumber: p.weekNumber,
      feedGramsPerBird: num(p.feedGramsPerBird),
      waterMlPerBird: num(p.waterMlPerBird),
      eggPercentage: num(p.eggPercentage),
      mortalityPercent: num(p.mortalityPercent),
      bodyWeightGrams: num(p.bodyWeightGrams),
    });
  }

  // ── Feed delivered into each house ──
  const transferRows = await tx
    .select({
      id: feedTransfers.id,
      shedId: feedTransfers.toHouseId,
      quantityKg: feedTransfers.quantityKg,
      date: feedTransfers.transferDate,
      formulaName: items.name,
    })
    .from(feedTransfers)
    .leftJoin(items, eq(items.id, feedTransfers.itemId))
    .where(isNotNull(feedTransfers.toHouseId))
    .orderBy(asc(feedTransfers.transferDate));

  return {
    sheds: shedRows,
    stocks,
    records,
    breeds: breedRows,
    breedStandards,
    formulaTransfers: transferRows.map((t) => ({
      ...t,
      quantityKg: num(t.quantityKg),
      costPerKg: null,
    })),
  };
}
