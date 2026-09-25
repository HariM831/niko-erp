/**
 * One word per shed: is it all right in there?
 *
 * The board answers with fifteen numbers a house; this folds them into a
 * verdict and the reasons for it, so the home page can say "all four fine" or
 * "L3 severe: feels-like 31.8 °C" in one line, and the controls page can show
 * how the last day went before anyone opens a settings page.
 *
 * The verdict uses the feels-like bands (ok / watch / severe / critical), and
 * the instrument checks on the house card — temperature against target, CO2,
 * humidity — can only push it up. THI is shown but can raise a house only to
 * watch: it ignores the air moving over the birds, and on a tunnel-ventilated
 * summer day it would call every shed severe while the feels-like model, which
 * counts the fans, says they are comfortable.
 */
import { and, gte, inArray } from "drizzle-orm";
import { iotHouseSample } from "@shared/schema";
import { db } from "../../db";
import { heatIndex, ladderFans } from "./controls";
import { houseFeelsLike, LEVELS, type Level, type LevelName } from "./feels-like";
import { outsideHumidityAt, outsideHumidityByHour } from "./weather";

export type Verdict = LevelName | "offline";

/** A reading older than this is not "now". The poll runs every five minutes. */
const STALE_MS = 20 * 60_000;

/**
 * How much wetter than the outside air a shed may be before it is a watch.
 * The birds breathe water into the air and the pads add more: over the week
 * to 25 September 2026 the sheds ran a median 12 to 17 points above the
 * outside air with the pads off and 3 to 8 with them on, and the 90th
 * percentile was about 25. Twenty catches the unusual tenth — a shed not
 * carrying its moisture out — and leaves the rest to the wet-bulb check,
 * which is where humidity actually hurts the birds. The old fixed 82% line
 * was a watch on every monsoon afternoon.
 */
const RH_OVER_OUTSIDE = 20;
/** When the weather service has no figure for the hour, the old fixed line. */
const RH_FIXED = 82;

/** The instrument checks, as a level and a reason. Shared by "now" and the 24-hour replay. */
function instrumentChecks(t: number | null, target: number | null, rh: number | null, co2: number | null, outsideRh: number | null = null): Array<{ level: Level; reason: string }> {
  const out: Array<{ level: Level; reason: string }> = [];
  if (t != null && target != null) {
    const d = t - target;
    if (d > 4) out.push({ level: 2, reason: `${d.toFixed(1)} °C over target ${target}` });
    else if (d > 2) out.push({ level: 1, reason: `${d.toFixed(1)} °C over target ${target}` });
    else if (d < -3) out.push({ level: 1, reason: `${(-d).toFixed(1)} °C under target ${target}` });
  }
  if (co2 != null) {
    if (co2 > 2500) out.push({ level: 2, reason: `CO₂ ${Math.round(co2)} ppm` });
    else if (co2 > 1500) out.push({ level: 1, reason: `CO₂ ${Math.round(co2)} ppm` });
  }
  if (rh != null) {
    if (outsideRh != null) {
      if (rh > outsideRh + RH_OVER_OUTSIDE) out.push({ level: 1, reason: `humidity ${Math.round(rh)}%, outside ${Math.round(outsideRh)}%` });
    } else if (rh > RH_FIXED) out.push({ level: 1, reason: `humidity ${Math.round(rh)}%` });
  }
  return out;
}

export interface NowInput {
  tempC: number | null;
  targetTempC: number | null;
  humidityPct: number | null;
  co2Ppm: number | null;
  fetchedAt: Date | null;
  controllerLive: boolean | null;
  feelsLike: { bft: number; band: LevelName; wetBulbC: number } | null;
}

/** The verdict on a house from its board row. */
export function verdictNow(b: NowInput, now = Date.now(), outsideRh: number | null = null): { verdict: Verdict; reasons: string[]; thi: { thi: number; band: string } | null } {
  const thi = heatIndex(b.tempC, b.humidityPct);
  if (b.controllerLive === false) return { verdict: "offline", reasons: ["controller switched off or not reachable"], thi };
  if (!b.fetchedAt || now - b.fetchedAt.getTime() > STALE_MS) {
    const mins = b.fetchedAt ? Math.round((now - b.fetchedAt.getTime()) / 60_000) : null;
    return { verdict: "offline", reasons: [mins == null ? "no readings yet" : `no reading for ${mins} min`], thi };
  }
  if (b.tempC == null) return { verdict: "offline", reasons: ["no temperature reading"], thi };

  let level: Level = 0;
  const reasons: string[] = [];
  if (b.feelsLike) {
    level = LEVELS.indexOf(b.feelsLike.band) as Level;
    if (level > 0) reasons.push(`feels-like ${b.feelsLike.bft} °C, wet-bulb ${b.feelsLike.wetBulbC} °C`);
  }
  for (const c of instrumentChecks(b.tempC, b.targetTempC, b.humidityPct, b.co2Ppm, outsideRh)) {
    level = Math.max(level, c.level) as Level;
    reasons.push(c.reason);
  }
  if (thi?.band === "severe") {
    level = Math.max(level, 1) as Level;
    reasons.push(`THI ${thi.thi}`);
  }
  return { verdict: LEVELS[level], reasons, thi };
}

/* ── The last 24 hours ──────────────────────────────────────────────────── */

export interface HourCell {
  /** Start of the hour, ISO. */
  start: string;
  samples: number;
  tempAvg: number | null;
  rhAvg: number | null;
  bftMax: number | null;
  /** The worst level any sample in the hour reached; null when the hour has no samples. */
  level: LevelName | null;
}

export interface DayStatus {
  from: string;
  to: string;
  samples: number;
  /** Hours the samples cover; the rest of the 24 is missing data, not a quiet shed. */
  hoursCovered: number;
  hoursByLevel: Record<LevelName, number>;
  /** The worst level held for at least a quarter of an hour in total, so one odd sample does not colour the day. */
  worst: LevelName;
  worstAt: string | null;
  worstReason: string | null;
  tempAvg: number | null;
  tempMin: number | null;
  tempMax: number | null;
  overTargetMax: number | null;
  rhAvg: number | null;
  rhMax: number | null;
  wetBulbMax: number | null;
  bftMax: number | null;
  thiMax: number | null;
  co2Max: number | null;
  ventMax: number | null;
  padsHours: number | null;
  /** Whether air speed came from the kept fan ladder; without it feels-like assumes still air and reads high. */
  airSpeedKnown: boolean;
  mortalityToday: number | null;
  waterPerBirdMl: number | null;
  feedPerBirdG: number | null;
  birdAgeDays: number | null;
  hours: HourCell[];
}

const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

/** The last 24 hours of each house, replayed sample by sample through the same checks as the verdict. */
export async function dayStatus(houseIds: string[], now = new Date()): Promise<Map<string, DayStatus>> {
  const outsideRh = await outsideHumidityByHour();
  const out = new Map<string, DayStatus>();
  if (!houseIds.length) return out;
  const from = new Date(now.getTime() - 24 * 3_600_000);
  const rows = await db
    .select()
    .from(iotHouseSample)
    .where(and(inArray(iotHouseSample.houseId, houseIds), gte(iotHouseSample.at, from)))
    .orderBy(iotHouseSample.houseId, iotHouseSample.at);

  const byHouse = new Map<string, typeof rows>();
  for (const r of rows) byHouse.set(r.houseId, [...(byHouse.get(r.houseId) ?? []), r]);

  for (const houseId of houseIds) {
    const samples = byHouse.get(houseId) ?? [];
    const fansAtStep = await ladderFans(houseId);
    const hoursByLevel: Record<LevelName, number> = { ok: 0, watch: 0, severe: 0, critical: 0 };
    const temps: number[] = [];
    const rhs: number[] = [];
    const wbs: number[] = [];
    const bfts: number[] = [];
    const thiVals: number[] = [];
    const co2s: number[] = [];
    const vents: number[] = [];
    const over: number[] = [];
    let padsH = 0;
    let padsKnown = false;
    let covered = 0;
    // The peak of each level — its hottest sample — kept for the reason line.
    const peak: Array<{ at: Date; reason: string; bft: number } | null> = [null, null, null, null];

    const hourStart = (d: Date) => Math.floor((d.getTime() - from.getTime()) / 3_600_000);
    const cells = Array.from({ length: 24 }, (_, i) => ({
      start: new Date(from.getTime() + i * 3_600_000).toISOString(),
      t: [] as number[],
      rh: [] as number[],
      bft: [] as number[],
      level: -1 as -1 | Level,
    }));

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      // A sample stands for the time until the next, capped so a gap is not credited to it.
      const next = samples[i + 1]?.at ?? now;
      const h = Math.min(next.getTime() - s.at.getTime(), 15 * 60_000) / 3_600_000;
      covered += h;

      let level: Level = 0;
      let reason = "";
      if (s.tempC != null) temps.push(s.tempC);
      if (s.humidityPct != null) rhs.push(s.humidityPct);
      if (s.co2Ppm != null) co2s.push(s.co2Ppm);
      if (s.ventLevel != null) vents.push(s.ventLevel);
      if (s.tempC != null && s.targetTempC != null) over.push(s.tempC - s.targetTempC);
      if (s.pumpOn != null) {
        padsKnown = true;
        if (s.pumpOn >= 0.5) padsH += h;
      }
      const fans = s.ventLevel != null ? (fansAtStep?.[Math.round(s.ventLevel)] ?? 0) : 0;
      const fl = houseFeelsLike(s.tempC, s.humidityPct, s.pressurePa, fans);
      if (fl) {
        bfts.push(fl.bft);
        wbs.push(fl.wetBulbC);
        level = fl.level;
        if (level > 0) reason = `feels-like ${fl.bft} °C, wet-bulb ${fl.wetBulbC} °C`;
      }
      const thi = heatIndex(s.tempC, s.humidityPct);
      if (thi) thiVals.push(thi.thi);
      for (const c of instrumentChecks(s.tempC, s.targetTempC, s.humidityPct, s.co2Ppm, outsideHumidityAt(outsideRh, s.at))) {
        if (c.level > level) reason = c.reason;
        level = Math.max(level, c.level) as Level;
      }
      hoursByLevel[LEVELS[level]] += h;
      const held = peak[level];
      if (!held || (fl?.bft ?? 0) > held.bft) peak[level] = { at: s.at, reason, bft: fl?.bft ?? 0 };

      const cell = cells[hourStart(s.at)];
      if (cell) {
        if (s.tempC != null) cell.t.push(s.tempC);
        if (s.humidityPct != null) cell.rh.push(s.humidityPct);
        if (fl) cell.bft.push(fl.bft);
        cell.level = Math.max(cell.level, level) as Level;
      }
    }

    let worst: Level = 0;
    for (const l of [3, 2, 1] as Level[]) {
      const held = LEVELS.slice(l).reduce((a, n) => a + hoursByLevel[n], 0);
      if (held >= 0.25) {
        worst = l;
        break;
      }
    }
    const last = samples[samples.length - 1];
    out.set(houseId, {
      from: from.toISOString(),
      to: now.toISOString(),
      samples: samples.length,
      hoursCovered: r1(covered)!,
      hoursByLevel: Object.fromEntries(Object.entries(hoursByLevel).map(([k, v]) => [k, r1(v)!])) as Record<LevelName, number>,
      worst: LEVELS[worst],
      worstAt: worst > 0 ? (peak[worst]?.at.toISOString() ?? null) : null,
      worstReason: worst > 0 ? (peak[worst]?.reason ?? null) : null,
      tempAvg: r1(mean(temps)),
      tempMin: r1(temps.length ? Math.min(...temps) : null),
      tempMax: r1(maxOf(temps)),
      overTargetMax: r1(maxOf(over)),
      rhAvg: r1(mean(rhs)),
      rhMax: r1(maxOf(rhs)),
      wetBulbMax: r1(maxOf(wbs)),
      bftMax: r1(maxOf(bfts)),
      thiMax: r1(maxOf(thiVals)),
      co2Max: maxOf(co2s) == null ? null : Math.round(maxOf(co2s)!),
      ventMax: maxOf(vents),
      padsHours: padsKnown ? r1(padsH) : null,
      airSpeedKnown: fansAtStep != null,
      mortalityToday: last?.mortalityToday ?? null,
      waterPerBirdMl: last?.waterPerBirdMl == null ? null : Math.round(last.waterPerBirdMl),
      feedPerBirdG: last?.feedPerBirdG == null ? null : Math.round(last.feedPerBirdG),
      birdAgeDays: last?.birdAgeDays ?? null,
      hours: cells.map((c) => ({
        start: c.start,
        samples: c.t.length,
        tempAvg: r1(mean(c.t)),
        rhAvg: r1(mean(c.rh)),
        bftMax: r1(maxOf(c.bft)),
        level: c.level < 0 ? null : LEVELS[c.level as Level],
      })),
    });
  }
  return out;
}
