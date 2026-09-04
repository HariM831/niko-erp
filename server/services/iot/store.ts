/**
 * Getting readings out of the sheds and into niko.
 *
 * The client in bhfarm.ts knows the vendor; this knows the farm. It maps a
 * controller to a house through `houses.bh_device_id`, writes what came back,
 * and keeps a per-house-per-day summary alongside.
 *
 * The day summary is kept apart from `placement_days` on purpose. What a person
 * wrote on the sheet and what the instrument measured are two different claims
 * about the same day, and the day they disagree is the day you want both.
 */
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import {
  houses,
  iotHouseDay,
  iotHouseSample,
  iotPollLog,
  iotReadings,
} from "@shared/schema";
import { db } from "../../db";
import {
  COLUMN_OF_TAG,
  METRIC_TAGS,
  SAMPLE_COLUMN_NAMES,
  SINGLE_TAGS,
  discoverDevices,
  fetchCurrentValues,
  fetchHistoryRows,
  keepHistory,
  nameOf,
  tagIdsFor,
  unpackHistoryRow,
  type BhTagValue,
} from "./bhfarm";
import { climbSince, type CounterSample } from "./counters";

/** Houses that name a controller, by device id. */
export async function housesByDevice(): Promise<Map<string, { id: string; code: string }>> {
  const rows = await db
    .select({ id: houses.id, code: houses.code, device: houses.bhDeviceId })
    .from(houses)
    .where(sql`${houses.bhDeviceId} IS NOT NULL`);
  return new Map(rows.filter((r) => r.device).map((r) => [r.device!, { id: r.id, code: r.code }]));
}

const num = (v: string | null | undefined) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Resolve one of the aggregate-or-sum metrics from a poll.
 *
 * The aggregate tag wins; failing that the per-line tags are summed. There is
 * no fallback to the pre-rename name — see bhfarm.ts. A metric with neither
 * reads null, and null is the honest answer.
 */
function resolveMetric(
  byName: Map<string, number>,
  spec: { total: string; lines: readonly string[] },
): number | null {
  const total = byName.get(spec.total);
  if (total != null) return total;
  const parts = spec.lines.map((l) => byName.get(l)).filter((v): v is number => v != null);
  return parts.length ? parts.reduce((s, v) => s + v, 0) : null;
}

/** Save a poll: latest values, history rows, and the day's summary. */
export async function saveReadings(
  houseId: string,
  readings: BhTagValue[],
  at = new Date(),
): Promise<number> {
  if (!readings.length) return 0;

  /**
   * Latest-value table: one row per tag, holding the newest reading.
   *
   * Deduped BEFORE the upsert. A backfill hands over the same tag at every
   * instant of a month, and Postgres refuses an ON CONFLICT that would touch
   * one row twice in a single statement — "cannot affect row a second time".
   * Keeping the newest is also the only answer that means anything here: this
   * table is a dial on a wall, and a dial shows the present.
   */
  const newest = new Map<string, BhTagValue>();
  for (const r of readings) {
    const held = newest.get(r.tagId);
    const heldAt = held?.recordedAt ?? "";
    const thisAt = r.recordedAt ?? "";
    if (!held || thisAt >= heldAt) newest.set(r.tagId, r);
  }
  const latest = [...newest.values()];

  for (let i = 0; i < latest.length; i += 200) {
    const slice = latest.slice(i, i + 200);
    await db
      .insert(iotReadings)
      .values(
        slice.map((r) => ({
          houseId,
          tagId: r.tagId,
          value: r.value,
          quality: r.quality,
          unit: r.unit,
          fetchedAt: r.recordedAt ? new Date(r.recordedAt) : at,
        })),
      )
      .onConflictDoUpdate({
        target: [iotReadings.houseId, iotReadings.tagId],
        set: {
          value: sql`excluded.value`,
          quality: sql`excluded.quality`,
          unit: sql`excluded.unit`,
          fetchedAt: sql`excluded.fetched_at`,
        },
        /**
         * Only ever forwards.
         *
         * The dedupe above keeps the newest reading within ONE call, which is
         * not the same as keeping the newest overall: a backfill run after a
         * live poll hands over a month whose last instant is older than now,
         * and without this the dial on the wall would tick backwards to it.
         */
        setWhere: sql`excluded.fetched_at >= "iot_readings"."fetched_at"`,
      });
  }

  /**
   * History: one row per instant, the charted tags as columns.
   *
   * Everything reached `iot_readings` above; only a charted few reach here.
   * Storing all 3,469 live tags a row apiece would write a million rows a day
   * for the sake of the opening angle of a curtain nobody will ever plot.
   *
   * Grouped by instant because that is what a row IS now. A live poll hands
   * over one instant and produces one row; a backfill hands over a month and
   * produces one row per five minutes of it.
   */
  const byInstant = new Map<string, BhTagValue[]>();
  for (const r of readings) {
    if (!keepHistory(r.tagId)) continue;
    const key = r.recordedAt ?? at.toISOString();
    const bucket = byInstant.get(key) ?? [];
    byInstant.set(key, bucket);
    bucket.push(r);
  }
  return writeSamples(houseId, byInstant);
}

/** Quoted identifiers, from our own literal column list — never from input. */
const COLS = SAMPLE_COLUMN_NAMES.map((c) => `"${c}"`).join(", ");

/**
 * A poll's readings reduced to the sample row's columns.
 *
 * Keyed on the tag's LAST segment: a live poll carries the full
 * `category.subcategory.name` path and the vendor's wide history rows carry
 * only the name, and the names are unique within the controller template.
 */
function sampleValues(readings: BhTagValue[]): (number | null)[] | null {
  const byColumn = new Map<string, number>();
  for (const r of readings) {
    // A reading the instrument does not stand behind is not a reading.
    if (r.quality !== 0 && r.quality !== 1) continue;
    const column = COLUMN_OF_TAG.get(nameOf(r.tagId));
    if (!column) continue;
    const v = num(r.value);
    if (v != null) byColumn.set(column, v);
  }
  if (!byColumn.size) return null;
  return SAMPLE_COLUMN_NAMES.map((c) => byColumn.get(c) ?? null);
}

/**
 * Write one wide row per instant.
 *
 * A conflicting row is merged rather than replaced, column by column. The two
 * writers disagree about how much they know: the vendor's history rows carry
 * roughly what the live poll does but not always the same set, and a later pass
 * that happens to be missing a tag must not blank out a value an earlier one
 * had. `coalesce(excluded, existing)` is the whole rule.
 */
export async function writeSamples(
  houseId: string,
  byInstant: Map<string, BhTagValue[]>,
): Promise<number> {
  const rows: { at: string; values: (number | null)[] }[] = [];
  for (const [instant, readings] of byInstant) {
    const values = sampleValues(readings);
    if (values) rows.push({ at: instant, values });
  }
  if (!rows.length) return 0;

  const set = SAMPLE_COLUMN_NAMES.map(
    (c) => `"${c}" = coalesce(excluded."${c}", "iot_house_sample"."${c}")`,
  ).join(", ");

  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const tuples = slice.map(
      (r) =>
        sql`(${houseId}::uuid, ${r.at}::timestamptz, ${sql.join(
          r.values.map((v) => sql`${v}::real`),
          sql`, `,
        )})`,
    );
    await db.execute(sql`
      INSERT INTO "iot_house_sample" ("house_id", "at", ${sql.raw(COLS)})
      VALUES ${sql.join(tuples, sql`, `)}
      ON CONFLICT ("house_id", "at") DO UPDATE SET ${sql.raw(set)}
    `);
    written += slice.length;
  }
  return written;
}

/** One poll's worth of readings, reduced to the figures the day cares about. */
interface Sample {
  at: Date;
  temp: number | null;
  humidity: number | null;
  co2: number | null;
  pressure: number | null;
  waterL: number | null;
  feedKg: number | null;
  siloKg: number | null;
  waterPerBird: number | null;
  feedPerBird: number | null;
  birdCount: number | null;
  birdAge: number | null;
}

function toSample(readings: BhTagValue[], at: Date): Sample | null {
  /**
   * Keyed on the tag's LAST segment.
   *
   * A live poll carries the full `category.subcategory.name` path; the vendor's
   * wide history rows carry only the name. The names are unique within the
   * controller template, so the last segment is the one grain both agree on —
   * and matching on anything longer means history silently measures nothing.
   */
  const byName = new Map<string, number>();
  for (const r of readings) {
    // A zero-quality reading is one the instrument does not stand behind.
    if (r.quality !== 0 && r.quality !== 1) continue;
    const v = num(r.value);
    if (v == null) continue;
    byName.set(nameOf(r.tagId), v);
  }
  if (!byName.size) return null;
  const recorded = readings.find((r) => r.recordedAt)?.recordedAt;
  return {
    at: recorded ? new Date(recorded) : at,
    temp: byName.get(SINGLE_TAGS.tempC) ?? null,
    humidity: byName.get(SINGLE_TAGS.humidityPct) ?? null,
    co2: byName.get(SINGLE_TAGS.co2Ppm) ?? null,
    pressure: byName.get(SINGLE_TAGS.pressurePa) ?? null,
    waterL: resolveMetric(byName, METRIC_TAGS.waterL),
    feedKg: resolveMetric(byName, METRIC_TAGS.feedKg),
    siloKg: resolveMetric(byName, METRIC_TAGS.siloKg),
    waterPerBird: byName.get(SINGLE_TAGS.waterPerBirdMl) ?? null,
    feedPerBird: byName.get(SINGLE_TAGS.feedPerBirdG) ?? null,
    birdCount: byName.get(SINGLE_TAGS.birdCount) ?? null,
    birdAge: byName.get(SINGLE_TAGS.birdAgeDays) ?? null,
  };
}

/** IST midnight opening `day` (YYYY-MM-DD). */
const startOfDay = (day: string) => new Date(`${day}T00:00:00+05:30`);

interface DayCounters {
  waterL: number | null;
  feedKg: number | null;
  waterPerBird: number | null;
  feedPerBird: number | null;
}

/**
 * The day's feed and water: what each counter CLIMBED between one IST
 * midnight and the next, from every sample held for the day.
 *
 * Not the day's highest reading. The controllers reset their counters once a
 * day but not at midnight, and not at the same hour as each other — L5's feed
 * around 21:30 IST, L3's around 02:00, the water meters a few minutes past
 * twelve. A peak since midnight therefore carried yesterday's closing figure
 * into today until today overtook it (L2's water stood at 30,200 L on a
 * morning it had drunk 8,000), and dropped a shed's evening feed from the day
 * it was eaten into the day after. `climbSince` cuts the series at each
 * confirmed reset and adds up the climbs, skipping the single-sample
 * dropouts the controllers throw.
 *
 * Read from the sample table rather than from the polls handed in, because a
 * live poll hands over ONE instant and the answer needs the whole day, plus
 * the value each counter held at midnight — six hours of the evening before
 * are fetched for that baseline. The polls are merged in for the instants the
 * table does not have yet; where both know an instant, the table's merged row
 * wins.
 */
async function dayCounters(houseId: string, day: string, own: Sample[] = []): Promise<DayCounters> {
  const dayStart = startOfDay(day);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const from = new Date(dayStart.getTime() - 6 * 3_600_000);
  const held = await db
    .select({
      at: iotHouseSample.at,
      waterL: iotHouseSample.waterL,
      feedKg: iotHouseSample.feedKg,
      waterPerBird: iotHouseSample.waterPerBirdMl,
      feedPerBird: iotHouseSample.feedPerBirdG,
    })
    .from(iotHouseSample)
    .where(
      and(
        eq(iotHouseSample.houseId, houseId),
        gte(iotHouseSample.at, from),
        lt(iotHouseSample.at, dayEnd),
      ),
    )
    .orderBy(iotHouseSample.at);

  type Row = { at: Date } & DayCounters;
  const byInstant = new Map<number, Row>();
  for (const r of held) byInstant.set(r.at.getTime(), r);
  for (const s of own) if (!byInstant.has(s.at.getTime())) byInstant.set(s.at.getTime(), s);
  const series = [...byInstant.values()].sort((a, b) => a.at.getTime() - b.at.getTime());

  const climb = (pick: (r: Row) => number | null) => {
    const points: CounterSample[] = [];
    for (const r of series) {
      const v = pick(r);
      if (v != null) points.push({ at: r.at, v });
    }
    return climbSince(points, dayStart);
  };
  return {
    waterL: climb((r) => r.waterL),
    feedKg: climb((r) => r.feedKg),
    waterPerBird: climb((r) => r.waterPerBird),
    feedPerBird: climb((r) => r.feedPerBird),
  };
}

/** What `dayCounters` would store for a day, for a repair to look at first. */
export async function countersOf(houseId: string, day: string): Promise<DayCounters> {
  return dayCounters(houseId, day);
}

/**
 * Re-derive one day's counters from its samples and write them over the
 * summary. Only the four counter columns move; the averages and extremes were
 * right all along. Returns whether a row was there to update.
 */
export async function recountDay(houseId: string, day: string): Promise<boolean> {
  const c = await dayCounters(houseId, day);
  if (c.waterL == null && c.feedKg == null && c.waterPerBird == null && c.feedPerBird == null) {
    return false;
  }
  const d = (v: number | null) => (v == null ? null : v.toFixed(2));
  const r = await db.execute(sql`
    UPDATE iot_house_day
       SET water_l = ${d(c.waterL)}, feed_kg = ${d(c.feedKg)},
           water_per_bird_ml = ${d(c.waterPerBird)}, feed_per_bird_g = ${d(c.feedPerBird)},
           updated_at = now()
     WHERE house_id = ${houseId} AND day = ${day}`);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Write a day's summary from every poll that landed in it.
 *
 * Takes ALL the samples rather than one at a time, and replaces the row. The
 * obvious alternative - fold one poll in and increment a counter - is right for
 * a live poll and quietly wrong for a backfill, where a whole day arrives at
 * once: it would count a day of readings as a single sample and report the last
 * one as the average.
 *
 * The averages skip nulls rather than treating them as zero. A sensor out for
 * an hour must not drag the day's mean towards the floor.
 *
 * Totals are the controller's OWN running figures for the day, so the LAST
 * sample wins rather than the sum: adding them would count the same litre once
 * per poll.
 */
export async function writeDay(
  houseId: string,
  day: string,
  polls: BhTagValue[][],
  at = new Date(),
): Promise<void> {
  const samples = polls.map((p) => toSample(p, at)).filter((s): s is Sample => s !== null);
  if (!samples.length) return;
  const counters = await dayCounters(houseId, day, samples);

  const vals = (pick: (s: Sample) => number | null) =>
    samples.map(pick).filter((v): v is number => v != null);
  const avg = (pick: (s: Sample) => number | null) => {
    const v = vals(pick);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const min = (pick: (s: Sample) => number | null) => {
    const v = vals(pick);
    return v.length ? Math.min(...v) : null;
  };
  const max = (pick: (s: Sample) => number | null) => {
    const v = vals(pick);
    return v.length ? Math.max(...v) : null;
  };
  /** The last reading of the day — right for a LEVEL, like what the silo holds. */
  const last = (pick: (s: Sample) => number | null) => {
    const v = vals(pick);
    return v.length ? v[v.length - 1]! : null;
  };

  /** A level that went negative is a bad reading, not an empty silo. */
  const lastSane = (pick: (s: Sample) => number | null) => {
    const v = vals(pick).filter((x) => x >= 0);
    return v.length ? v[v.length - 1]! : null;
  };

  const d = (v: number | null) => (v == null ? null : v.toFixed(2));

  await db.execute(sql`
    INSERT INTO iot_house_day
      (house_id, day, samples, temp_avg, temp_min, temp_max, humidity_avg,
       co2_avg, co2_max, pressure_avg, water_l, feed_kg, water_per_bird_ml,
       feed_per_bird_g, silo_kg, bird_count, bird_age_days, updated_at)
    VALUES (
      ${houseId}, ${day}, ${samples.length},
      ${d(avg((s) => s.temp))}, ${d(min((s) => s.temp))}, ${d(max((s) => s.temp))},
      ${d(avg((s) => s.humidity))},
      ${d(avg((s) => s.co2))}, ${d(max((s) => s.co2))},
      ${d(avg((s) => s.pressure))},
      ${d(counters.waterL)}, ${d(counters.feedKg)},
      ${d(counters.waterPerBird)}, ${d(counters.feedPerBird)},
      ${d(lastSane((s) => s.siloKg))},
      ${last((s) => s.birdCount)}, ${last((s) => s.birdAge)}, now())
    ON CONFLICT (house_id, day) DO UPDATE SET
      /* More samples means a better-informed row, so a fuller pass wins. A live
         poll writing one sample must not overwrite a backfill's whole day. */
      samples           = greatest(iot_house_day.samples, excluded.samples),
      temp_avg          = CASE WHEN excluded.samples >= iot_house_day.samples THEN excluded.temp_avg ELSE iot_house_day.temp_avg END,
      humidity_avg      = CASE WHEN excluded.samples >= iot_house_day.samples THEN excluded.humidity_avg ELSE iot_house_day.humidity_avg END,
      co2_avg           = CASE WHEN excluded.samples >= iot_house_day.samples THEN excluded.co2_avg ELSE iot_house_day.co2_avg END,
      pressure_avg      = CASE WHEN excluded.samples >= iot_house_day.samples THEN excluded.pressure_avg ELSE iot_house_day.pressure_avg END,
      /* Extremes only ever widen. */
      temp_min          = least(iot_house_day.temp_min, excluded.temp_min),
      temp_max          = greatest(iot_house_day.temp_max, excluded.temp_max),
      co2_max           = greatest(iot_house_day.co2_max, excluded.co2_max),
      /*
       * The counters were worked out from every sample held for the day, not
       * from this poll alone, so a fresh figure is always the better-informed
       * one. See dayCounters.
       */
      water_l           = coalesce(excluded.water_l, iot_house_day.water_l),
      feed_kg           = coalesce(excluded.feed_kg, iot_house_day.feed_kg),
      water_per_bird_ml = coalesce(excluded.water_per_bird_ml, iot_house_day.water_per_bird_ml),
      feed_per_bird_g   = coalesce(excluded.feed_per_bird_g, iot_house_day.feed_per_bird_g),
      silo_kg           = coalesce(excluded.silo_kg, iot_house_day.silo_kg),
      bird_count        = coalesce(excluded.bird_count, iot_house_day.bird_count),
      bird_age_days     = coalesce(excluded.bird_age_days, iot_house_day.bird_age_days),
      updated_at        = now()
  `);
}

/** The day a reading belongs to, in the farm's own timezone rather than UTC. */
const dayOf = (at: Date) =>
  new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export interface PollResult {
  houses: number;
  tags: number;
  readings: number;
  skipped: string[];
  error?: string;
}

/**
 * One pass over every house that names a controller.
 *
 * Logged whether it works or not: a silent integration is indistinguishable
 * from a working one until somebody needs the data, and by then the vendor's
 * window has closed.
 */
export async function pollOnce(): Promise<PollResult> {
  const [log] = await db.insert(iotPollLog).values({}).returning({ id: iotPollLog.id });
  const result: PollResult = { houses: 0, tags: 0, readings: 0, skipped: [] };

  try {
    const byDevice = await housesByDevice();
    if (!byDevice.size) throw new Error("no house names a bh_device_id — nothing to poll");

    const devices = await discoverDevices();
    const seen = new Set(devices.map((d) => d.houseCode));
    for (const [device, house] of byDevice) {
      if (!seen.has(device)) result.skipped.push(`${house.code} (${device}) not visible to the account`);
    }

    for (const device of devices) {
      const house = byDevice.get(device.houseCode);
      if (!house) continue;

      const tags = await tagIdsFor(device.houseCode);
      if (!tags.length) {
        result.skipped.push(`${house.code} reported no tags`);
        continue;
      }
      const readings = await fetchCurrentValues(tags);
      const at = new Date();
      const kept = await saveReadings(house.id, readings, at);
      await writeDay(house.id, dayOf(at), [readings]);

      result.houses++;
      result.tags += tags.length;
      result.readings += kept;
    }

    /**
     * Retention rides the poll cycle — a thinning that waits to be remembered
     * never runs — but at most once a day. Scanning for aged rows every five
     * minutes costs a table scan 288 times over to do what one pass would.
     */
    const thin = await thinSamples(undefined, { atMostOncePerDay: true });
    if (thin.deleted || thin.thinned) {
      result.skipped.push(
        `thinned ${thin.thinned} aged sample(s), dropped ${thin.deleted} older than ${thin.cutoff}`,
      );
    }
    // Keyed on the pass, not on what it found: a day thinning had nothing to
    // do is still a day the log grew by 288 rows. thinSamples has already
    // decided the day turned, so this costs one scan rather than a second guard.
    if (thin.ran) {
      const log = await prunePollLog();
      if (log.deleted) result.skipped.push(`pruned ${log.deleted} spent poll log row(s)`);
    }

    await db
      .update(iotPollLog)
      .set({
        finishedAt: new Date(),
        ok: true,
        houses: result.houses,
        tags: result.tags,
        readings: result.readings,
        error: result.skipped.length ? result.skipped.join("; ") : null,
      })
      .where(eq(iotPollLog.id, log!.id));
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await db
      .update(iotPollLog)
      .set({ finishedAt: new Date(), ok: false, error: result.error })
      .where(eq(iotPollLog.id, log!.id));
  }

  return result;
}

/**
 * Pull the vendor's own stored history.
 *
 * The one operation that recovers readings from before niko existed — and it
 * stops working for anything older than about six weeks, which is why it is
 * worth running early and often rather than once it is convenient.
 */
export async function backfill(
  days = 42,
  windowDays = Number(process.env.IOT_BACKFILL_WINDOW_DAYS ?? 7),
): Promise<{ houses: number; readings: number; from: string; failed: string[] }> {
  const byDevice = await housesByDevice();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  let houseCount = 0;
  let readings = 0;
  const failed: string[] = [];

  for (const device of await discoverDevices()) {
    const house = byDevice.get(device.houseCode);
    if (!house) continue;

    /**
     * A window at a time, and each house's failures kept to itself.
     *
     * Asking for all six weeks at once made the vendor's gateway answer 504,
     * and because that threw out of the whole loop, every house after the first
     * big one silently got nothing — which is exactly how four of six sheds
     * came to have no history at all. Smaller queries succeed, and a house that
     * still fails is reported rather than taking the rest down with it.
     */
    let got = 0;
    for (let cursor = from; cursor < to; ) {
      const until = new Date(Math.min(cursor.getTime() + windowDays * 86_400_000, to.getTime()));
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await fetchHistoryRows({ houseCode: device.houseCode, from: cursor, to: until });
      } catch (e) {
        failed.push(
          `${house.code} ${cursor.toISOString().slice(0, 10)}..${until.toISOString().slice(0, 10)}: ` +
            (e instanceof Error ? e.message.slice(0, 120) : String(e)),
        );
        cursor = until;
        continue;
      }
      cursor = until;
      if (!rows.length) continue;

      /**
       * Wide rows unpacked into readings, then grouped by day AND by instant.
       *
       * One instant is one sample. Folding a whole day as a single sample would
       * report its last reading as the day's average — a bug that looks
       * entirely plausible on a chart and is wrong every single day.
       */
      const byDay = new Map<string, Map<string, BhTagValue[]>>();
      const flat: BhTagValue[] = [];
      for (const row of rows) {
        for (const r of unpackHistoryRow(device.houseCode, row)) {
          flat.push(r);
          if (!r.recordedAt) continue;
          const d = dayOf(new Date(r.recordedAt));
          const instants = byDay.get(d) ?? new Map<string, BhTagValue[]>();
          byDay.set(d, instants);
          const at = instants.get(r.recordedAt) ?? [];
          instants.set(r.recordedAt, at);
          at.push(r);
        }
      }

      got += await saveReadings(house.id, flat);
      for (const [day, instants] of byDay) {
        await writeDay(house.id, day, [...instants.values()]);
      }
    }

    readings += got;
    if (got) houseCount++;
  }
  return { houses: houseCount, readings, from: from.toISOString().slice(0, 10), failed };
}

/**
 * How far apart samples of a given age are SUPPOSED to be.
 *
 * The ladder in `thinSamples` deliberately spaces old readings out, so a naive
 * gap-finder would see every thinned stretch as a hole, refetch it at five
 * minutes, and watch the next thinning delete it again — for ever. Anything
 * looking for gaps has to know what spacing to expect at that age.
 */
function expectedSpacingMs(ageDays: number): number {
  if (ageDays > 60) return 3_600_000;
  if (ageDays > 7) return 900_000;
  return 300_000;
}

export interface SampleGap {
  houseId: string;
  code: string;
  device: string;
  from: Date;
  to: Date;
  minutes: number;
}

/**
 * Stretches where a house recorded nothing.
 *
 * Includes the run from `since` up to the first sample and from the last one to
 * now, because a house that has never reported and a house that stopped
 * yesterday are both holes and neither shows up as a gap between two rows.
 *
 * A gap counts only when it is more than three times the spacing expected at
 * that age — see `expectedSpacingMs`. A missed poll or two is not worth a
 * request to the vendor; a missed night is.
 */
export async function findSampleGaps(sinceDays = 7): Promise<SampleGap[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const byDevice = await housesByDevice();
  const gaps: SampleGap[] = [];

  for (const [device, house] of byDevice) {
    const rows = await db
      .select({ at: iotHouseSample.at })
      .from(iotHouseSample)
      .where(and(eq(iotHouseSample.houseId, house.id), gte(iotHouseSample.at, since)))
      .orderBy(iotHouseSample.at);

    const times = [since, ...rows.map((r) => r.at), new Date()];
    for (let i = 1; i < times.length; i++) {
      const from = times[i - 1]!;
      const to = times[i]!;
      const ageDays = (Date.now() - from.getTime()) / 86_400_000;
      const delta = to.getTime() - from.getTime();
      if (delta <= expectedSpacingMs(ageDays) * 3) continue;
      gaps.push({
        houseId: house.id,
        code: house.code,
        device,
        from,
        to,
        minutes: Math.round(delta / 60_000),
      });
    }
  }
  return gaps;
}

/**
 * Fetch the vendor's history for the stretches niko missed.
 *
 * The poller only runs while the server does, so any restart, crash or deploy
 * leaves a hole. The vendor keeps roughly six weeks, which makes those holes
 * recoverable — but only until they age out, and only if somebody notices.
 * This is what stops it being a matter of noticing.
 *
 * Deliberately narrower than `backfill`: it asks only for the windows that are
 * actually empty, so the daily run is usually zero requests and never
 * re-downloads a month to repair an hour.
 *
 * The default look-back is a week, which is the stretch still held at full
 * five-minute detail. An outage longer than that is a job for `backfill`, not
 * something to heal quietly in the background.
 */
export async function fillGaps(
  sinceDays = Number(process.env.IOT_GAP_FILL_DAYS ?? 7),
): Promise<{ gaps: number; filled: number; readings: number; failed: string[] }> {
  const gaps = await findSampleGaps(sinceDays);
  if (!gaps.length) return { gaps: 0, filled: 0, readings: 0, failed: [] };

  let filled = 0;
  let readings = 0;
  const failed: string[] = [];

  for (const gap of gaps) {
    // Padded on both sides: the vendor's rows land on its own five-minute grid,
    // and asking from exactly the last reading can miss the one after it.
    const from = new Date(gap.from.getTime() - 600_000);
    const to = new Date(gap.to.getTime() + 600_000);

    let rows: Array<Record<string, unknown>>;
    try {
      rows = await fetchHistoryRows({ houseCode: gap.device, from, to });
    } catch (e) {
      failed.push(`${gap.code} ${gap.from.toISOString().slice(0, 16)}: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      continue;
    }
    if (!rows.length) continue;

    const byDay = new Map<string, Map<string, BhTagValue[]>>();
    const flat: BhTagValue[] = [];
    for (const row of rows) {
      for (const r of unpackHistoryRow(gap.device, row)) {
        flat.push(r);
        if (!r.recordedAt) continue;
        const d = dayOf(new Date(r.recordedAt));
        const instants = byDay.get(d) ?? new Map<string, BhTagValue[]>();
        byDay.set(d, instants);
        const at = instants.get(r.recordedAt) ?? [];
        instants.set(r.recordedAt, at);
        at.push(r);
      }
    }

    /**
     * The latest-value table is left alone.
     *
     * `saveReadings` would also touch `iot_readings`, and a gap fill carries
     * readings from the past. Its own guard would refuse to move the dial
     * backwards, but writing history through a function whose other job is
     * "what is true right now" is asking for the next person to be surprised.
     */
    readings += await writeSamples(gap.houseId, mergeInstants(byDay));
    for (const [day, instants] of byDay) {
      await writeDay(gap.houseId, day, [...instants.values()]);
    }
    filled++;
  }

  return { gaps: gaps.length, filled, readings, failed };
}

/** Every instant from every day, flattened back into one map. */
function mergeInstants(byDay: Map<string, Map<string, BhTagValue[]>>): Map<string, BhTagValue[]> {
  const all = new Map<string, BhTagValue[]>();
  for (const instants of byDay.values()) {
    for (const [at, readings] of instants) all.set(at, readings);
  }
  return all;
}

/** The latest reading per tag for a house, for the shed screen. */
export async function latestFor(houseId: string) {
  return db
    .select()
    .from(iotReadings)
    .where(eq(iotReadings.houseId, houseId))
    .orderBy(iotReadings.tagId);
}

/**
 * A house's readings over a stretch of time, oldest first.
 *
 * Served straight off the primary key, which leads with the house and then
 * orders by instant — so this is a range scan whatever the table has grown to.
 */
export async function houseSamples(houseId: string, from: Date, to = new Date()) {
  return db
    .select()
    .from(iotHouseSample)
    .where(
      and(
        eq(iotHouseSample.houseId, houseId),
        gte(iotHouseSample.at, from),
        lte(iotHouseSample.at, to),
      ),
    )
    .orderBy(iotHouseSample.at);
}

/** The day summaries, newest first. */
export async function houseDays(houseId: string | null, days = 90) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .select()
    .from(iotHouseDay)
    .where(
      houseId
        ? and(eq(iotHouseDay.houseId, houseId), gte(iotHouseDay.day, since))
        : gte(iotHouseDay.day, since),
    )
    .orderBy(desc(iotHouseDay.day));
}

/** How the last few polls went. */
export async function recentPolls(limit = 10) {
  return db.select().from(iotPollLog).orderBy(desc(iotPollLog.startedAt)).limit(limit);
}



/**
 * How much detail a sample keeps, by how old it is.
 *
 * Five-minute resolution is worth having for the week you spend chasing a
 * ventilation fault. Nobody plots five-minute CO2 from March, and the day
 * summaries — which are never thinned — already answer the questions anyone
 * actually asks of a six-month-old Tuesday.
 *
 *   0-7 days      every poll        12,096 rows
 *   8-60 days     one per 15 min    27,984
 *   61-365 days   one per hour      43,920
 *   older         gone
 *                                   ~84,000 rows in steady state, ~17 MB
 *
 * Thinning rather than averaging into buckets: every row that survives is a
 * real reading taken at a real instant, so "at 03:00 on 12 March it was 24.1"
 * stays a true sentence. The peaks that thinning drops are the one thing worth
 * keeping from the gaps, and `iot_house_day` already holds them forever.
 *
 * Amino's equivalent table reached the point where creating an index on it
 * crashed deployments. That is the lesson this tier ladder is paying forward.
 */
const TIERS = [
  { afterDays: 7, everySeconds: 900 },
  { afterDays: 60, everySeconds: 3600 },
] as const;

/**
 * Thin aged samples, and delete what is past the window entirely.
 *
 * Deleted in batches so one run never holds a long lock against the table, and
 * oldest tier first so a row is only ever examined by the coarsest rule that
 * applies to it.
 *
 * The day summaries are NEVER touched. Six rows a day is the price of being
 * able to answer for any day the farm has ever run, and it is worth paying
 * forever.
 */
let lastThinAt = 0;

export async function thinSamples(
  retentionDays = Number(process.env.IOT_SAMPLE_RETENTION_DAYS ?? 365),
  opts: { atMostOncePerDay?: boolean; onlyHouseId?: string } = {},
): Promise<{ deleted: number; thinned: number; cutoff: string; ran: boolean }> {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const cutoff = ago(retentionDays);
  if (opts.atMostOncePerDay && Date.now() - lastThinAt < 86_400_000) {
    return { deleted: 0, thinned: 0, cutoff: cutoff.slice(0, 10), ran: false };
  }
  lastThinAt = Date.now();

  /**
   * One house, or all of them.
   *
   * The scheduler wants all; a check wants only the house it made up, and a
   * check that quietly applied retention to the whole farm would be a strange
   * thing to run.
   */
  const only = opts.onlyHouseId
    ? sql` AND "house_id" = ${opts.onlyHouseId}::uuid`
    : sql``;

  /** Past the window: gone outright. */
  let deleted = 0;
  for (;;) {
    const r = await db.execute(sql`
      DELETE FROM "iot_house_sample" WHERE ctid IN (
        SELECT ctid FROM "iot_house_sample" WHERE "at" < ${cutoff}${only} LIMIT 50000
      )
    `);
    const batch = r.rowCount ?? 0;
    deleted += batch;
    if (batch < 50_000) break;
  }

  /**
   * Inside the window: keep the first row of each interval and drop the rest.
   *
   * Bucketed by floored epoch rather than by the clock, because polls do not
   * land on tidy boundaries — 17:12:14 and 17:17:14 are a real pair of them —
   * and a rule keyed on the minute would keep everything or nothing.
   */
  let thinned = 0;
  const coarsestFirst = [...TIERS].reverse();
  for (const [i, tier] of coarsestFirst.entries()) {
    // Each tier owns the stretch between its own age and the next-finer one.
    const older = i === 0 ? cutoff : ago(coarsestFirst[i - 1]!.afterDays);
    const newer = ago(tier.afterDays);
    for (;;) {
      const r = await db.execute(sql`
        DELETE FROM "iot_house_sample" WHERE ctid IN (
          SELECT ctid FROM (
            SELECT ctid, row_number() OVER (
              PARTITION BY "house_id", floor(extract(epoch FROM "at") / ${tier.everySeconds})
              ORDER BY "at"
            ) AS rn
            FROM "iot_house_sample"
            WHERE "at" >= ${older} AND "at" < ${newer}${only}
          ) ranked
          WHERE rn > 1
          LIMIT 50000
        )
      `);
      const batch = r.rowCount ?? 0;
      thinned += batch;
      if (batch < 50_000) break;
    }
  }

  return { deleted, thinned, cutoff: cutoff.slice(0, 10), ran: true };
}

/**
 * Prune the poll log, keeping the polls that said something.
 *
 * A row per poll is 288 a day and none of them expired, which made this the
 * one part of the integration with no ceiling: a year is ~105,000 rows, 97% of
 * them recording "everything was fine, again".
 *
 * What survives is the 3% worth reading later — a failed poll, or a successful
 * one carrying a note (the daily thinning report). Those answer "when did the
 * sheds stop reporting", which is the whole reason the log exists; a clean poll
 * from three months ago answers nothing the readings themselves do not.
 *
 *   0-30 days      every poll, clean or not
 *   30-365 days    only failures and notes
 *   over 365 days  gone, failures included — by then the vendor's six-week
 *                  history is long past and there is nothing left to recover
 *
 * Batched like the sample thinning, so one run never holds a long lock.
 */
export async function prunePollLog(
  keepAllDays = Number(process.env.IOT_POLL_LOG_KEEP_DAYS ?? 30),
  retentionDays = Number(process.env.IOT_POLL_LOG_RETENTION_DAYS ?? 365),
): Promise<{ deleted: number }> {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  let deleted = 0;

  // Clean polls, once they are older than the window worth browsing.
  for (;;) {
    const r = await db.execute(sql`
      DELETE FROM "iot_poll_log" WHERE ctid IN (
        SELECT ctid FROM "iot_poll_log"
        WHERE "started_at" < ${ago(keepAllDays)}
          AND "ok" AND "error" IS NULL
        LIMIT 50000
      )
    `);
    const batch = r.rowCount ?? 0;
    deleted += batch;
    if (batch < 50_000) break;
  }

  // Everything past the outer window, whatever it says.
  for (;;) {
    const r = await db.execute(sql`
      DELETE FROM "iot_poll_log" WHERE ctid IN (
        SELECT ctid FROM "iot_poll_log" WHERE "started_at" < ${ago(retentionDays)} LIMIT 50000
      )
    `);
    const batch = r.rowCount ?? 0;
    deleted += batch;
    if (batch < 50_000) break;
  }

  return { deleted };
}
