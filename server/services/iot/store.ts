/**
 * Getting readings out of the sheds and into EGGSY.
 *
 * The client in bhfarm.ts knows the vendor; this knows the farm. It maps a
 * controller to a house through `houses.bh_device_id`, writes what came back,
 * and keeps a per-house-per-day summary alongside.
 *
 * The day summary is kept apart from `placement_days` on purpose. What a person
 * wrote on the sheet and what the instrument measured are two different claims
 * about the same day, and the day they disagree is the day you want both.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  houses,
  iotHistory,
  iotHouseDay,
  iotPollLog,
  iotReadings,
} from "@shared/schema";
import { db } from "../../db";
import {
  METRIC_TAGS,
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
      });
  }

  /**
   * History, for the tags worth keeping one of.
   *
   * Everything reached `iot_readings` above; only a charted few reach here.
   * Storing all 3,469 live tags would write a million rows a day for the sake
   * of the opening angle of a curtain nobody will ever plot.
   *
   * The same instant twice is the same reading, whichever way it arrived, so a
   * backfill re-run adds nothing rather than doubling a month.
   */
  const worth = readings.filter((r) => keepHistory(r.tagId));
  let kept = 0;
  for (let i = 0; i < worth.length; i += 200) {
    const slice = worth.slice(i, i + 200);
    const rows = await db
      .insert(iotHistory)
      .values(
        slice.map((r) => ({
          houseId,
          tagId: r.tagId,
          value: r.value,
          quality: r.quality,
          unit: r.unit,
          recordedAt: r.recordedAt ? new Date(r.recordedAt) : at,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: iotHistory.id });
    kept += rows.length;
  }

  return kept;
}

/** One poll's worth of readings, reduced to the figures the day cares about. */
interface Sample {
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

function toSample(readings: BhTagValue[]): Sample | null {
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
  return {
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
export async function writeDay(houseId: string, day: string, polls: BhTagValue[][]): Promise<void> {
  const samples = polls.map(toSample).filter((s): s is Sample => s !== null);
  if (!samples.length) return;

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
  /** The controller's own daily total - the last one it reported. */
  const last = (pick: (s: Sample) => number | null) => {
    const v = vals(pick);
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
      ${d(last((s) => s.waterL))}, ${d(last((s) => s.feedKg))},
      ${d(last((s) => s.waterPerBird))}, ${d(last((s) => s.feedPerBird))},
      ${d(last((s) => s.siloKg))},
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
      /* Running daily totals: the newest reading is the whole day's figure. */
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
     * Retention rides the poll cycle — a prune that waits to be remembered
     * never runs — but at most once a day. Scanning for expired rows every
     * five minutes costs a table scan 288 times over to delete what one pass
     * would have taken.
     */
    const pruned = await pruneHistory(undefined, { atMostOncePerDay: true });
    if (pruned.deleted) {
      result.skipped.push(`pruned ${pruned.deleted} history row(s) older than ${pruned.cutoff}`);
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
 * The one operation that recovers readings from before EGGSY existed — and it
 * stops working for anything older than about six weeks, which is why it is
 * worth running early and often rather than once it is convenient.
 */
export async function backfill(days = 42): Promise<{ houses: number; readings: number; from: string }> {
  const byDevice = await housesByDevice();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  let houseCount = 0;
  let readings = 0;
  for (const device of await discoverDevices()) {
    const house = byDevice.get(device.houseCode);
    if (!house) continue;

    const rows = await fetchHistoryRows({ houseCode: device.houseCode, from, to });
    if (!rows.length) continue;

    /**
     * Wide rows unpacked into readings, then grouped by day AND by instant.
     *
     * One instant is one sample. Folding a whole day as a single sample would
     * report its last reading as the day's average — a bug that looks entirely
     * plausible on a chart and is wrong every single day.
     */
    const byDay = new Map<string, Map<string, BhTagValue[]>>();
    const flat: BhTagValue[] = [];
    for (const row of rows) {
      const unpacked = unpackHistoryRow(device.houseCode, row);
      for (const r of unpacked) {
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

    readings += await saveReadings(house.id, flat);
    for (const [day, instants] of byDay) {
      await writeDay(house.id, day, [...instants.values()]);
    }
    houseCount++;
  }
  return { houses: houseCount, readings, from: from.toISOString().slice(0, 10) };
}

/** The latest reading per tag for a house, for the shed screen. */
export async function latestFor(houseId: string) {
  return db
    .select()
    .from(iotReadings)
    .where(eq(iotReadings.houseId, houseId))
    .orderBy(iotReadings.tagId);
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
 * Trim raw history that the day summaries have already absorbed.
 *
 * `iot_history` is a working buffer, not an archive. It exists so the day
 * summaries can be rebuilt and so a recent night can be inspected reading by
 * reading — but at a five-minute poll over a few hundred live tags it grows by
 * roughly 170,000 rows a day, and nothing anyone asks of a six-month-old
 * Tuesday needs more than the day summary that was folded from it. Amino's
 * copy of this table reached the point where creating an index on it crashed
 * deployments; the pruning is ported from there along with the lesson.
 *
 * Deleted in batches so one run never holds a long lock against a table this
 * size — each batch is its own statement, and a run that finds nothing to
 * delete costs one cheap probe.
 *
 * The day summaries are NEVER pruned. Six rows a day is the price of being
 * able to answer for any day the farm has ever run, and it is worth paying
 * forever.
 */
let lastPruneAt = 0;

export async function pruneHistory(
  retentionDays = Number(process.env.IOT_HISTORY_RETENTION_DAYS ?? 365),
  opts: { atMostOncePerDay?: boolean } = {},
): Promise<{ deleted: number; cutoff: string }> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  if (opts.atMostOncePerDay && Date.now() - lastPruneAt < 86_400_000) {
    return { deleted: 0, cutoff: cutoff.toISOString().slice(0, 10) };
  }
  lastPruneAt = Date.now();
  let deleted = 0;
  for (;;) {
    const r = await db.execute(sql`
      DELETE FROM iot_history WHERE ctid IN (
        SELECT ctid FROM iot_history WHERE recorded_at < ${cutoff.toISOString()} LIMIT 50000
      )
    `);
    const batch = r.rowCount ?? 0;
    deleted += batch;
    if (batch < 50_000) break;
  }
  return { deleted, cutoff: cutoff.toISOString().slice(0, 10) };
}
