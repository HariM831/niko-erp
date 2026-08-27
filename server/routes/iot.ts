/**
 * What the sheds' instruments say, for the screens.
 *
 * Reads only. The poller writes; nothing here does.
 */
import { Router } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { houses, iotHouseDay, iotReadings } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { SINGLE_TAGS, METRIC_TAGS, nameOf, tokenExpiry } from "../services/iot/bhfarm";
import { houseSamples, recentPolls } from "../services/iot/store";

export const iotRouter = Router();

/**
 * The live board: one row per house, latest reading of the tags worth naming.
 *
 * Read from `iot_readings` — the dial on the wall — rather than from history,
 * so the query is one small table scan however many years are stored.
 */
iotRouter.get("/board", requirePermission("farms", "view"), async (_req, res) => {
  const rows = await db
    .select({
      houseId: houses.id,
      code: houses.code,
      purpose: houses.purpose,
      displayOrder: houses.displayOrder,
      device: houses.bhDeviceId,
      tagId: iotReadings.tagId,
      value: iotReadings.value,
      unit: iotReadings.unit,
      fetchedAt: iotReadings.fetchedAt,
    })
    .from(houses)
    .leftJoin(iotReadings, eq(iotReadings.houseId, houses.id))
    .where(sql`${houses.isActive}`)
    .orderBy(houses.displayOrder, houses.code);

  interface Board {
    houseId: string;
    code: string;
    purpose: string;
    device: string | null;
    fetchedAt: Date | null;
    tempC: number | null;
    targetTempC: number | null;
    humidityPct: number | null;
    co2Ppm: number | null;
    pressurePa: number | null;
    siloKg: number | null;
    waterL: number | null;
    feedKg: number | null;
    birdCount: number | null;
    birdAgeDays: number | null;
    /**
     * When each consumption figure last actually changed, and whether it is
     * therefore still today's. See `staleness` below.
     */
    feedChangedAt: Date | null;
    waterChangedAt: Date | null;
    siloChangedAt: Date | null;
    feedStale: boolean;
    waterStale: boolean;
    siloStale: boolean;
  }

  const byHouse = new Map<string, Board>();
  const named = new Map<string, Map<string, number>>();

  for (const r of rows) {
    let b = byHouse.get(r.houseId);
    if (!b) {
      b = {
        houseId: r.houseId,
        code: r.code,
        purpose: r.purpose,
        device: r.device,
        fetchedAt: null,
        tempC: null,
        targetTempC: null,
        humidityPct: null,
        co2Ppm: null,
        pressurePa: null,
        siloKg: null,
        waterL: null,
        feedKg: null,
        birdCount: null,
        birdAgeDays: null,
        feedChangedAt: null,
        waterChangedAt: null,
        siloChangedAt: null,
        feedStale: false,
        waterStale: false,
        siloStale: false,
      };
      byHouse.set(r.houseId, b);
      named.set(r.houseId, new Map());
    }
    if (!r.tagId) continue;
    if (r.fetchedAt && (!b.fetchedAt || r.fetchedAt > b.fetchedAt)) b.fetchedAt = r.fetchedAt;
    const v = r.value == null ? null : Number(r.value);
    if (v == null || !Number.isFinite(v)) continue;
    // Keyed on the last segment — the one grain a live poll and the vendor's
    // history rows agree on. See bhfarm.ts.
    named.get(r.houseId)!.set(nameOf(r.tagId), v);
  }

  /** Aggregate tag first, else the sum of the per-line tags — never the frozen name. */
  const metric = (m: Map<string, number>, spec: { total: string; lines: readonly string[] }) => {
    const total = m.get(spec.total);
    if (total != null) return total;
    const parts = spec.lines.map((l) => m.get(l)).filter((x): x is number => x != null);
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  };

  for (const [houseId, b] of byHouse) {
    const m = named.get(houseId)!;
    b.tempC = m.get(SINGLE_TAGS.tempC) ?? null;
    b.targetTempC = m.get(SINGLE_TAGS.targetTempC) ?? null;
    b.humidityPct = m.get(SINGLE_TAGS.humidityPct) ?? null;
    b.co2Ppm = m.get(SINGLE_TAGS.co2Ppm) ?? null;
    b.pressurePa = m.get(SINGLE_TAGS.pressurePa) ?? null;
    b.birdCount = m.get(SINGLE_TAGS.birdCount) ?? null;
    b.birdAgeDays = m.get(SINGLE_TAGS.birdAgeDays) ?? null;
    b.siloKg = metric(m, METRIC_TAGS.siloKg);
    b.waterL = metric(m, METRIC_TAGS.waterL);
    b.feedKg = metric(m, METRIC_TAGS.feedKg);
  }

  /**
   * Is each consumption figure still TODAY's, or a number that stopped moving?
   *
   * On 2026-08-27 every tag in the controller's water-and-feed category had
   * frozen farm-wide while the environment category kept flowing: L5 read the
   * same 289 kg, 4,900 L and 15,260 kg silo for thirteen days straight, and L3
   * held 7,004 kg across midnight. The values still arrive on every poll, so
   * nothing looks broken — the panel just shows July's number as today's.
   *
   * The test is not a staleness threshold, which would have to guess how long a
   * shed may legitimately go without feeding. These are DAILY counters: they
   * reset to zero at midnight. So a figure that has not changed since the start
   * of the current day cannot be today's, and one that has, is. No threshold to
   * tune, and no false positive from a quiet night.
   *
   * `*ChangedAt` is the last instant the value was seen DIFFERENT, so the figure
   * has held since roughly one sample after it. NULL means it never differed in
   * everything retained — stale for certain.
   */
  const nowIst = new Date(Date.now() + 5.5 * 3_600_000);
  const istMidnight = new Date(
    Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - 5.5 * 3_600_000,
  );

  const changed = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (house_id) house_id, feed_kg, water_l, silo_kg
        FROM iot_house_sample ORDER BY house_id, at DESC
    )
    SELECT l.house_id AS "houseId",
           (SELECT max(s.at) FROM iot_house_sample s
             WHERE s.house_id = l.house_id AND s.feed_kg IS DISTINCT FROM l.feed_kg)  AS "feedChangedAt",
           (SELECT max(s.at) FROM iot_house_sample s
             WHERE s.house_id = l.house_id AND s.water_l IS DISTINCT FROM l.water_l)  AS "waterChangedAt",
           (SELECT max(s.at) FROM iot_house_sample s
             WHERE s.house_id = l.house_id AND s.silo_kg IS DISTINCT FROM l.silo_kg)  AS "siloChangedAt"
      FROM latest l`);

  for (const row of changed.rows as Array<Record<string, unknown>>) {
    const b = byHouse.get(String(row.houseId));
    if (!b) continue;
    const at = (v: unknown) => (v == null ? null : new Date(String(v)));
    b.feedChangedAt = at(row.feedChangedAt);
    b.waterChangedAt = at(row.waterChangedAt);
    b.siloChangedAt = at(row.siloChangedAt);
    // Null was never read at all — missing, not stale. Zero is excluded too: an
    // empty shed's meter sits at 0 forever and that is the truth, not a frozen
    // number, and flagging it would put a warning on every idle house.
    const held = (v: number | null, at: Date | null) =>
      v != null && v !== 0 && !(at && at >= istMidnight);
    b.feedStale = held(b.feedKg, b.feedChangedAt);
    b.waterStale = held(b.waterL, b.waterChangedAt);
    b.siloStale = held(b.siloKg, b.siloChangedAt);
  }

  const board = [...byHouse.values()].sort((a, b) => {
    const n = (c: string) => Number(c.match(/(\d+)/)?.[1] ?? 9999);
    return a.purpose.localeCompare(b.purpose) || n(a.code) - n(b.code);
  });

  const exp = tokenExpiry();
  const [last] = await recentPolls(1);
  res.json({
    board,
    poll: last
      ? { at: last.startedAt, ok: last.ok, houses: last.houses, readings: last.readings, error: last.error }
      : null,
    tokenExpires: exp ? exp.toISOString().slice(0, 10) : null,
  });
});

/**
 * Everything the controller says about one house RIGHT NOW, for the drawings.
 *
 * The board above answers "how is the farm"; this answers "show me the shed" —
 * the per-probe temperatures the house drawing lays out, the 22 fan groups the
 * fan wall lights up, the curtains and the cooling pump. All of it is already
 * in `iot_readings`, because that table keeps every tag the controller
 * reports; only the charted few get history, but "now" costs nothing.
 */
iotRouter.get("/house/:id/live", requirePermission("farms", "view"), async (req, res) => {
  const rows = await db
    .select()
    .from(iotReadings)
    .where(eq(iotReadings.houseId, req.params.id!));

  /**
   * One value per tag NAME, newest fetch wins.
   *
   * The same tag sits in this table twice — the live poll writes the full
   * `category.subcategory.name` path and the backfill's wide rows write the
   * bare name — and the two can disagree by hours. The reader wants the tag,
   * not the spelling.
   */
  const newest = new Map<string, { value: string | null; at: Date }>();
  for (const r of rows) {
    const name = nameOf(r.tagId);
    const held = newest.get(name);
    if (!held || r.fetchedAt > held.at) newest.set(name, { value: r.value, at: r.fetchedAt });
  }
  const num = (name: string): number | null => {
    const v = newest.get(name)?.value;
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (name: string): string | null => newest.get(name)?.value ?? null;
  const metric = (spec: { total: string; lines: readonly string[] }) => {
    const total = num(spec.total);
    if (total != null) return total;
    const parts = spec.lines.map(num).filter((x): x is number => x != null);
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  };

  /** The 13 numbered probes the house drawing lays out. */
  const temps: Record<string, number> = {};
  for (let i = 1; i <= 13; i++) {
    const id = String(i).padStart(2, "0");
    const v = num(`温度${id}`);
    if (v != null) temps[id] = v;
  }

  /** The controller reports each fan group as its own boolean-ish tag. */
  const fanStatus: Record<string, boolean> = {};
  for (let i = 1; i <= 22; i++) {
    const id = String(i).padStart(2, "0");
    const v = str(`风机组${id}`) ?? "";
    fanStatus[id] = v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "on";
  }

  let fetchedAt: Date | null = null;
  for (const { at } of newest.values()) {
    if (!fetchedAt || at > fetchedAt) fetchedAt = at;
  }

  res.json({
    temps,
    fanStatus,
    tempC: num(SINGLE_TAGS.tempC),
    targetTempC: num(SINGLE_TAGS.targetTempC),
    humidityPct: num(SINGLE_TAGS.humidityPct),
    co2Ppm: num(SINGLE_TAGS.co2Ppm),
    pressurePa: num(SINGLE_TAGS.pressurePa),
    birdCount: num(SINGLE_TAGS.birdCount),
    birdAgeDays: num(SINGLE_TAGS.birdAgeDays),
    waterPerBirdMl: num(SINGLE_TAGS.waterPerBirdMl),
    feedPerBirdG: num(SINGLE_TAGS.feedPerBirdG),
    siloKg: metric(METRIC_TAGS.siloKg),
    ventLevel: num("通风级别"),
    ventMin: num("当前最小通风级别"),
    ventMax: num("当前最大通风级别"),
    airVolume: num("通风量"),
    speedFanPct: num("调速风机"),
    curtain1: num("幕帘1开启角度"),
    curtain2: num("幕帘2开启角度"),
    coolingPump: str("冷却水泵1"),
    fetchedAt,
  });
});

/**
 * A house's readings over a stretch of hours, for plotting.
 *
 * Capped at 14 days because the samples thin with age — past a week the rows
 * are a quarter-hour apart and past two months an hour, so a longer window
 * would draw a chart whose resolution changes halfway across it without saying
 * so. Anything older is a question for the day summaries.
 */
iotRouter.get("/house/:id/samples", requirePermission("farms", "view"), async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours ?? 24), 1), 24 * 14);
  const from = new Date(Date.now() - hours * 3_600_000);
  res.json({ from: from.toISOString(), samples: await houseSamples(req.params.id!, from) });
});

/** A house's day summaries, for its own page. */
iotRouter.get("/house/:id/days", requirePermission("farms", "view"), async (req, res) => {
  const days = Math.min(Number(req.query.days ?? 60), 400);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(iotHouseDay)
    .where(and(eq(iotHouseDay.houseId, req.params.id!), gte(iotHouseDay.day, since)))
    .orderBy(desc(iotHouseDay.day));
  res.json({ days: rows });
});
