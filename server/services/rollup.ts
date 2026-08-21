/**
 * `refreshFlockDay` — the only writer of `flock_day`.
 *
 * Every derived farm figure is worked out here, once, and read from the table
 * afterwards. That is the point of the table: the same closing count used to be
 * computed on the board, on the house page, in the report and in the API, and
 * those four disagreed.
 *
 * The whole flock is recomputed on any change, not a suffix of it. Two reasons:
 * cumulative columns run over the flock across every house it has lived in, so
 * a correction on day 3 moves day 400; and FIFO feed costing depends on the
 * full delivery history, so it cannot start mid-life. A flock is a few hundred
 * days — recomputing beats persisting balances that could drift.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  birdWeighings,
  feedTransfers,
  flockDay,
  flockMovements,
  flockPlacements,
  flocks,
  houses,
  movementDelta,
  placementDays,
  standardPoints,
} from "@shared/schema";
import type { db as Db } from "../db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
const d2 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : v.toFixed(2));
const d3 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : v.toFixed(3));
const d4 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : v.toFixed(4));

const epochDay = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const addDay = (iso: string, k: number) =>
  new Date((epochDay(iso) + k) * 86_400_000).toISOString().slice(0, 10);

/** One FIFO layer: a delivery into a house, drawn down oldest-first. */
interface Layer {
  day: string;
  itemId: string | null;
  left: number;
  unitCost: number | null;
}

/**
 * Rebuild every `flock_day` row for one flock.
 *
 * Call it inside the caller's transaction, after whatever changed. Cheap enough
 * to call on every write; the alternative is a nightly job and a day of wrong
 * numbers in between.
 */
export async function refreshFlockDay(tx: Tx, flockId: string): Promise<number> {
  const [flock] = await tx.select().from(flocks).where(eq(flocks.id, flockId));
  if (!flock) return 0;

  const placements = await tx
    .select({
      id: flockPlacements.id,
      houseId: flockPlacements.houseId,
      fromDate: flockPlacements.fromDate,
      toDate: flockPlacements.toDate,
      locationId: houses.locationId,
    })
    .from(flockPlacements)
    .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
    .where(eq(flockPlacements.flockId, flockId))
    .orderBy(asc(flockPlacements.fromDate));
  if (!placements.length) return 0;

  const ids = placements.map((p) => p.id);
  await tx.delete(flockDay).where(inArray(flockDay.placementId, ids));

  // ── Everything the days are built from ──
  const movements = await tx
    .select({
      placementId: flockMovements.placementId,
      day: flockMovements.eventDate,
      kind: flockMovements.kind,
      qty: flockMovements.qty,
      sign: flockMovements.adjustmentSign,
    })
    .from(flockMovements)
    .where(inArray(flockMovements.placementId, ids));

  const days = await tx
    .select()
    .from(placementDays)
    .where(inArray(placementDays.placementId, ids));

  const weighings = await tx
    .select()
    .from(birdWeighings)
    .where(inArray(birdWeighings.placementId, ids))
    .orderBy(asc(birdWeighings.weighedOn));

  const standards = flock.standardSetId
    ? await tx.select().from(standardPoints).where(eq(standardPoints.setId, flock.standardSetId))
    : [];
  const stdOf = new Map(standards.map((s) => [s.ageWeek, s]));

  // Feed deliveries, pooled per HOUSE — physically true: feed left in a silo is
  // eaten by whoever is placed there next.
  const houseIds = [...new Set(placements.map((p) => p.houseId))];
  const deliveries = await tx
    .select({
      houseId: feedTransfers.toHouseId,
      day: feedTransfers.transferDate,
      itemId: feedTransfers.itemId,
      qty: feedTransfers.quantityKg,
      rate: feedTransfers.ratePerKg,
      value: feedTransfers.value,
    })
    .from(feedTransfers)
    // A voided transfer never happened: it must not feed a FIFO layer, or the
    // cost per egg quietly includes feed the shed was never sent.
    .where(and(inArray(feedTransfers.toHouseId, houseIds), ne(feedTransfers.status, "void")))
    .orderBy(asc(feedTransfers.transferDate));

  const pool = new Map<string, Layer[]>();
  for (const h of houseIds) pool.set(h, []);
  for (const dv of deliveries) {
    const qty = n(dv.qty);
    if (!dv.houseId || qty <= 0) continue;
    // rate_per_kg where the mill set one; otherwise value/qty; otherwise none.
    const unit = dv.rate != null ? n(dv.rate) : dv.value != null ? n(dv.value) / qty : null;
    pool.get(dv.houseId)!.push({ day: dv.day, itemId: dv.itemId, left: qty, unitCost: unit });
  }

  // ── Index by (placement, day) ──
  const key = (p: string, day: string) => `${p}|${day}`;
  const dayRow = new Map(days.map((r) => [key(r.placementId, r.day), r]));

  const moveOf = new Map<string, Record<string, number>>();
  for (const m of movements) {
    const k = key(m.placementId, m.day);
    const bucket = moveOf.get(k) ?? {};
    bucket[m.kind] = (bucket[m.kind] ?? 0) + m.qty;
    bucket.__delta = (bucket.__delta ?? 0) + movementDelta(m.kind, m.qty, m.sign);
    moveOf.set(k, bucket);
  }

  const deliveredOf = new Map<string, number>();
  for (const dv of deliveries) {
    if (!dv.houseId) continue;
    for (const p of placements) {
      if (p.houseId !== dv.houseId) continue;
      if (dv.day < p.fromDate) continue;
      if (p.toDate && dv.day > p.toDate) continue;
      const k = key(p.id, dv.day);
      deliveredOf.set(k, (deliveredOf.get(k) ?? 0) + n(dv.qty));
    }
  }

  // ── Walk the flock's whole life, in date order across placements ──
  //
  // Cumulative figures run over the FLOCK, so they are carried between
  // placements rather than restarting — the break that made the old lifetime
  // numbers useless at exactly the moment a batch was housed.
  const today = new Date().toISOString().slice(0, 10);
  const closingOf = new Map<string, number>();
  let cumEggs = 0;
  let cumFeed = 0;
  let cumFeedCost = 0;
  /** Has any feed anywhere in this flock's life carried a price? */
  let cumPriced = false;
  let cumMort = 0;
  let birdsAtLayStart: number | null = null;
  const rows: Array<Record<string, unknown>> = [];

  // The last day a placement has anything recorded against it. A record is the
  // authority on whether a day happened: a day someone saved must appear here,
  // even if it sits past the placement's end date or past today — otherwise the
  // figures they entered are simply invisible and nobody can tell why.
  const recordedTo = new Map<string, string>();
  const later = (id: string, day: string) => {
    if (day > (recordedTo.get(id) ?? "")) recordedTo.set(id, day);
  };
  for (const r of days) later(r.placementId, r.day);
  for (const m of movements) later(m.placementId, m.day);

  // Every (placement, day) the flock existed, oldest first.
  const timeline: Array<{ p: (typeof placements)[number]; day: string }> = [];
  for (const p of placements) {
    let last = p.toDate ?? today;
    const recorded = recordedTo.get(p.id);
    if (recorded && recorded > last) last = recorded;
    for (let day = p.fromDate; day <= last; day = addDay(day, 1)) {
      timeline.push({ p, day });
    }
  }
  timeline.sort((a, b) => a.day.localeCompare(b.day) || a.p.fromDate.localeCompare(b.p.fromDate));

  for (const { p, day } of timeline) {
    const k = key(p.id, day);
    const mv = moveOf.get(k) ?? {};
    const pd = dayRow.get(k);

    const opening = closingOf.get(p.id) ?? 0;
    const closing = Math.max(0, opening + (mv.__delta ?? 0));
    closingOf.set(p.id, closing);

    const avgBirds = (opening + closing) / 2;
    // Age runs from the flock's bird-weighted average hatch date, so the chicks
    // from the FIRST hatch are alive for a few days before day 0. They are real
    // birds eating real feed, so their days are week 1 rather than week 0 or a
    // negative one — the guide has nothing earlier to compare them against.
    const ageDays = epochDay(day) - epochDay(flock.hatchDate);
    const ageWeek = Math.max(1, Math.floor(ageDays / 7) + 1);
    const laying = !!flock.layStartDate && day >= flock.layStartDate;
    // Hen-housed is per bird housed at the START of lay, so this is captured on
    // the first laying day the flock actually has a row for — not keyed to the
    // lay date itself, which can fall in a gap between placements.
    if (laying && birdsAtLayStart == null) birdsAtLayStart = opening || closing;

    const mortality = mv.mortality ?? 0;
    const culls = mv.cull ?? 0;
    cumMort += mortality + culls;

    const eggs = pd?.eggsTotal ?? null;
    if (eggs) cumEggs += eggs;

    const feedKg = pd?.feedConsumedKg == null ? null : n(pd.feedConsumedKg);
    if (feedKg) cumFeed += feedKg;

    // ── FIFO: draw the day's feed from the house's oldest open layer ──
    let feedCost: number | null = null;
    let incomplete = false;
    let itemId: string | null = null;
    if (feedKg && feedKg > 0) {
      const layers = pool.get(p.houseId)!;
      let remaining = feedKg;
      let cost = 0;
      let priced = false;
      let lastUnit: number | null = null;
      for (const layer of layers) {
        if (remaining <= 0) break;
        if (layer.day > day || layer.left <= 0) continue;
        const take = Math.min(remaining, layer.left);
        if (layer.unitCost == null) incomplete = true;
        else {
          cost += take * layer.unitCost;
          priced = true;
        }
        lastUnit = layer.unitCost ?? lastUnit;
        layer.left -= take;
        remaining -= take;
        itemId = layer.itemId ?? itemId;
      }
      if (remaining > 0) {
        // Eaten more than was ever delivered. Charge it at the last known rate
        // and flag the day rather than pretending the feed was free.
        if (lastUnit != null) {
          cost += remaining * lastUnit;
          priced = true;
        }
        incomplete = true;
      }
      // Nothing priced at all means there is no cost to report — not a cost of
      // zero. A confident ₹0.00 per egg is worse than an honest dash, because
      // somebody will believe it.
      if (priced) {
        feedCost = cost;
        cumFeedCost += cost;
        cumPriced = true;
      }
    }

    // Two meters, one number downstream. Null only when neither was read — a
    // genuine zero is a reading, not a gap.
    const water =
      pd == null || (pd.waterUpperKl == null && pd.waterLowerKl == null)
        ? null
        : (n(pd.waterUpperKl) + n(pd.waterLowerKl)) * 1000;

    const weighing = [...weighings]
      .filter((w) => w.placementId === p.id && w.weighedOn <= day)
      .pop();
    const std = stdOf.get(ageWeek);

    rows.push({
      placementId: p.id,
      day,
      flockId,
      houseId: p.houseId,
      locationId: p.locationId,
      phase: laying ? "lay" : "rear",
      ageDays,
      ageWeek,
      openingBirds: opening,
      closingBirds: closing,
      mortality,
      culls,
      maleRemovals: mv.male_removal ?? 0,
      transfersIn: mv.transfer_in ?? 0,
      transfersOut: (mv.transfer_out ?? 0) + (mv.depletion ?? 0),
      eggs,
      eggsCracked: pd?.eggsCracked ?? null,
      eggsDirty: pd?.eggsDirty ?? null,
      hdPct: eggs != null && avgBirds > 0 ? d2((eggs / avgBirds) * 100) : null,
      cumEggs,
      eggsPerHenHoused: birdsAtLayStart ? d2(cumEggs / birdsAtLayStart) : null,
      feedKg: d2(feedKg),
      feedDeliveredKg: d2(deliveredOf.get(k) ?? 0) ?? "0",
      feedClosingKg: pd?.feedClosingKg ?? null,
      feedPerBirdG: feedKg != null && avgBirds > 0 ? d2((feedKg * 1000) / avgBirds) : null,
      feedGPerEgg: feedKg != null && eggs ? d2((feedKg * 1000) / eggs) : null,
      cumFeedKg: d2(cumFeed) ?? "0",
      cumFeedKgPerBird: avgBirds > 0 ? d3(cumFeed / avgBirds) : null,
      itemId,
      feedCost: d2(feedCost),
      feedCostPerKg: feedCost != null && feedKg ? d4(feedCost / feedKg) : null,
      feedCostIncomplete: incomplete,
      cfpe: feedCost != null && eggs ? d4(feedCost / eggs) : null,
      cumFeedCost: cumPriced ? d2(cumFeedCost) : null,
      cumCfpe: cumPriced && cumEggs > 0 ? d4(cumFeedCost / cumEggs) : null,
      waterL: d2(water),
      waterPerBirdMl: water != null && avgBirds > 0 ? d2((water * 1000) / avgBirds) : null,
      waterFeedRatio: water != null && feedKg ? d3(water / feedKg) : null,
      cumMortality: cumMort,
      cumMortalityPct: flock.placedCount ? d3((cumMort / flock.placedCount) * 100) : null,
      liveabilityPct: flock.placedCount ? d3((closing / flock.placedCount) * 100) : null,
      bodyWeightG: weighing?.avgWeightG ?? null,
      eggWeightG: weighing?.eggWeightG ?? null,
      stdBodyWeightG: std?.bodyWeightG ?? null,
      stdFeedGPerBird: std?.feedGPerBirdDay ?? null,
      stdWaterMlPerBird: std?.waterMlPerBirdDay ?? null,
      stdLayPct: std?.layPct ?? null,
      stdEggWeightG: std?.eggWeightG ?? null,
      stdCumMortalityPct: std?.cumMortalityPct ?? null,
    });
  }

  // Chunked: a long-lived flock is well past the parameter ceiling in one go.
  for (let i = 0; i < rows.length; i += 300) {
    await tx.insert(flockDay).values(rows.slice(i, i + 300) as never);
  }
  return rows.length;
}

/** Refresh whichever flock a placement belongs to. */
export async function refreshFromPlacement(tx: Tx, placementId: string) {
  const [p] = await tx
    .select({ flockId: flockPlacements.flockId })
    .from(flockPlacements)
    .where(eq(flockPlacements.id, placementId));
  if (p) await refreshFlockDay(tx, p.flockId);
}

/** Every flock that has ever stood in a house — used when a delivery changes. */
export async function refreshHouse(tx: Tx, houseId: string) {
  const rows = await tx
    .selectDistinct({ flockId: flockPlacements.flockId })
    .from(flockPlacements)
    .where(eq(flockPlacements.houseId, houseId));
  for (const r of rows) await refreshFlockDay(tx, r.flockId);
}

/**
 * The weekly management summary: one row per age week for one flock.
 *
 * Read-only, so it takes the connection or a transaction — a report has no
 * reason to open one and a check script has every reason to reuse its own.
 */
export async function weeklySummary(tx: Tx | typeof Db, flockId: string) {
  const rows = await tx.execute(sql`
    WITH d AS (SELECT * FROM flock_day WHERE flock_id = ${flockId})
    SELECT
      age_week                                                        AS "week",
      bool_or(eggs IS NOT NULL OR feed_kg IS NOT NULL)                AS "hasData",
      max(phase)                                                      AS "phase",
      /* Hen-day for the week is the week's eggs over the week's bird-days, not
         an average of daily percentages — houses change size within a week. */
      CASE WHEN sum((opening_birds + closing_birds) / 2.0) > 0
           THEN round(sum(coalesce(eggs,0)) / sum((opening_birds + closing_birds) / 2.0) * 100, 1)
      END                                                             AS "henDayPct",
      round(max(std_lay_pct), 1)                                      AS "stdHenDayPct",
      round(max(cum_eggs)::numeric / nullif(max(closing_birds), 0), 1) AS "cumHenDayEggs",
      round(max(cum_mortality_pct), 2)                                AS "cumMortPct",
      round(max(std_cum_mortality_pct), 2)                            AS "stdCumMortPct",
      round(max(eggs_per_hen_housed), 1)                              AS "cumHenHousedEggs",
      round(max(cum_feed_kg_per_bird), 2)                             AS "cumFeedKgPerBird",
      round(avg(feed_per_bird_g), 0)                                  AS "feedGPerBirdDay",
      round(max(std_feed_g_per_bird), 0)                              AS "stdFeedGPerBirdDay",
      CASE WHEN sum(coalesce(eggs,0)) > 0
           THEN round(sum(coalesce(feed_kg,0)) * 1000 / sum(eggs), 0)
      END                                                             AS "feedPerEggWeekG",
      round(avg(water_per_bird_ml), 0)                                AS "waterMlPerBirdDay",
      round(max(body_weight_g) / 1000.0, 3)                           AS "bodyWeightKg",
      round(max(std_body_weight_g) / 1000.0, 3)                       AS "stdBodyWeightKg",
      round(max(egg_weight_g), 1)                                     AS "eggWeightG",
      round(max(std_egg_weight_g), 1)                                 AS "stdEggWeightG",
      CASE WHEN max(cum_eggs) > 0
           THEN round(max(cum_feed_kg) * 1000 / max(cum_eggs), 0)
      END                                                             AS "feedPerEggCumG",
      round(max(cum_cfpe), 2)                                         AS "cumCostPerEgg",
      bool_or(feed_cost_incomplete)                                   AS "costIncomplete"
    FROM d
    GROUP BY age_week
    ORDER BY age_week`);
  return rows.rows;
}
