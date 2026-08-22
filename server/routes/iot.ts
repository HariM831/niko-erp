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
    .where(sql`${houses.isActive}`);

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
