/**
 * A week of one house, reduced to the numbers a rule can reason about.
 *
 * The same arithmetic the settings audit of 6 September was written from,
 * kept as code so every proposal carries the evidence it was made on:
 * temperature, humidity and wet-bulb; the air the fans moved and what the
 * birds felt by Amino's model; how the controller behaved on its ladder; and
 * the restarts — the moments power dropped, the fans stopped, and the
 * controller climbed back up from the bottom step by step.
 */
import { and, eq, gte } from "drizzle-orm";
import { iotHouseSample } from "@shared/schema";
import { db } from "../../db";
import { feelsLike, velocity, wetBulb } from "./feels-like";

export interface WeekStats {
  from: Date;
  to: Date;
  hours: number;
  samples: number;
  tempMean: number | null;
  tempMin: number | null;
  tempMax: number | null;
  rhMean: number | null;
  rhMax: number | null;
  wetBulbMean: number | null;
  wetBulbMax: number | null;
  wetBulbHoursOver29: number;
  velocityMean: number | null;
  feelsLikeMean: number | null;
  feelsLikeNightMean: number | null;
  feelsLikeHoursOk: number;
  feelsLikeHoursWatch: number;
  feelsLikeHoursSevere: number;
  feelsLikeHoursCritical: number;
  co2Mean: number | null;
  co2Max: number | null;
  stepMean: number | null;
  stepChangesPerHour: number | null;
  hoursInTunnel: number;
  hoursAtOrBelowStep: (step: number) => number;
  /** Power came back and the controller climbed from the bottom: level fell by six or more steps inside fifteen minutes, then climbed four or more inside the hour. */
  restarts: number;
  restartMinutesUnderVentilated: number;
  fanKwhPerDay: number | null;
  /** The week's mean static pressure at each ladder step, with the sample count. */
  pressureByStep: Record<number, { n: number; mean: number }>;
  /** Every pressure reading with its time and step, for a fit that must know which ladder was in force. */
  pressureSamples: Array<[atMs: number, step: number, pa: number]>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const IST = 5.5 * 3_600_000;

/**
 * @param fansAtStep fans running at each ladder step (index = step), from the
 *   kept ladder; used for air speed and energy. Null when no snapshot exists.
 * @param tunnelStep the step at which tunnel mode begins.
 */
export async function weekStats(houseId: string, fansAtStep: number[] | null, tunnelStep: number | null, days = 7): Promise<WeekStats> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const rows = await db
    .select({
      at: iotHouseSample.at,
      t: iotHouseSample.tempC,
      rh: iotHouseSample.humidityPct,
      co2: iotHouseSample.co2Ppm,
      pa: iotHouseSample.pressurePa,
      step: iotHouseSample.ventLevel,
    })
    .from(iotHouseSample)
    .where(and(eq(iotHouseSample.houseId, houseId), gte(iotHouseSample.at, from)))
    .orderBy(iotHouseSample.at);

  const temps: number[] = [];
  const rhs: number[] = [];
  const wbs: number[] = [];
  const vels: number[] = [];
  const fls: number[] = [];
  const flNight: number[] = [];
  const co2s: number[] = [];
  const steps: number[] = [];
  let kwh = 0;
  const stepHours = new Map<number, number>();
  const paByStep = new Map<number, number[]>();
  const paSamples: Array<[number, number, number]> = [];
  const h5 = 5 / 60;

  for (const r of rows) {
    if (r.t != null) temps.push(r.t);
    if (r.rh != null) rhs.push(r.rh);
    if (r.co2 != null) co2s.push(r.co2);
    let v: number | null = null;
    if (r.step != null) {
      const s = Math.round(r.step);
      steps.push(s);
      stepHours.set(s, (stepHours.get(s) ?? 0) + h5);
      if (r.pa != null) {
        paByStep.set(s, [...(paByStep.get(s) ?? []), r.pa]);
        paSamples.push([r.at.getTime(), s, r.pa]);
      }
      const fans = fansAtStep?.[s] ?? null;
      if (fans != null) {
        kwh += fans * 1.5 * h5;
        v = velocity(fans, r.pa);
        if (v != null) vels.push(v);
      }
    }
    if (r.t != null && r.rh != null) {
      const { bft, wetBulbC } = feelsLike(r.t, r.rh, v);
      wbs.push(wetBulbC);
      fls.push(bft);
      const hour = new Date(r.at.getTime() + IST).getUTCHours();
      if (hour >= 22 || hour < 5) flNight.push(bft);
    }
  }

  // restarts: a fall of six or more steps within three samples, then a climb of four within twelve
  let restarts = 0;
  let underMinutes = 0;
  for (let i = 3; i < steps.length; i++) {
    const before = Math.max(steps[i - 3]!, steps[i - 2]!, steps[i - 1]!);
    if (before - steps[i]! >= 6) {
      const later = steps.slice(i + 1, i + 13);
      const climbed = later.findIndex((s) => s - steps[i]! >= 4);
      if (climbed >= 0) {
        restarts++;
        underMinutes += (climbed + 1) * 5;
        i += climbed + 1;
      }
    }
  }

  const hours = rows.length * h5;
  const changes = steps.reduce((n, s, i) => (i > 0 && s !== steps[i - 1] ? n + 1 : n), 0);
  const count = (pred: (x: number) => boolean, xs: number[]) => Math.round(xs.filter(pred).length * h5 * 10) / 10;
  return {
    from,
    to,
    hours: Math.round(hours * 10) / 10,
    samples: rows.length,
    tempMean: r1(mean(temps)),
    tempMin: temps.length ? Math.min(...temps) : null,
    tempMax: temps.length ? Math.max(...temps) : null,
    rhMean: r1(mean(rhs)),
    rhMax: rhs.length ? Math.max(...rhs) : null,
    wetBulbMean: r1(mean(wbs)),
    wetBulbMax: r1(wbs.length ? Math.max(...wbs) : null),
    wetBulbHoursOver29: count((x) => x >= 29, wbs),
    velocityMean: vels.length ? Math.round(mean(vels)! * 100) / 100 : null,
    feelsLikeMean: r1(mean(fls)),
    feelsLikeNightMean: r1(mean(flNight)),
    feelsLikeHoursOk: count((x) => x < 29, fls),
    feelsLikeHoursWatch: count((x) => x >= 29 && x < 31, fls),
    feelsLikeHoursSevere: count((x) => x >= 31 && x < 32.5, fls),
    feelsLikeHoursCritical: count((x) => x >= 32.5, fls),
    co2Mean: co2s.length ? Math.round(mean(co2s)!) : null,
    co2Max: co2s.length ? Math.max(...co2s) : null,
    stepMean: r1(mean(steps)),
    stepChangesPerHour: hours ? Math.round((changes / hours) * 100) / 100 : null,
    hoursInTunnel: tunnelStep ? count((s) => s >= tunnelStep, steps) : 0,
    hoursAtOrBelowStep: (step) => Math.round([...stepHours].filter(([s]) => s <= step).reduce((a, [, h]) => a + h, 0) * 10) / 10,
    restarts,
    restartMinutesUnderVentilated: underMinutes,
    fanKwhPerDay: hours ? Math.round(kwh / (hours / 24)) : null,
    pressureByStep: Object.fromEntries([...paByStep].map(([s, xs]) => [s, { n: xs.length, mean: Math.round(mean(xs)! * 10) / 10 }])),
    pressureSamples: paSamples,
  };
}
