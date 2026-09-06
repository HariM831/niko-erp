/**
 * What the birds feel: Amino's bird feels-like temperature, ported.
 *
 * A house at 29°C and 90% humidity with two metres a second of air over the
 * cages is a different place from one at 29°C, 60% and still air, and a
 * dry-bulb thermometer cannot tell them apart. This model can. It was built
 * in the Amino app against these same sheds (client/src/pages/birds/bft.ts
 * and server/feels-like.ts there) and is kept in step with it: same fan
 * curve, same wiring, same wet-bulb, same penalties, same bands.
 *
 *   wet-bulb        from dry-bulb and humidity (Stull)
 *   velocity        fans running × airflow per fan at the measured negative
 *                   pressure (the BESS curve for the farm's 50-inch fans),
 *                   over the tunnel cross-section
 *   feels-like      dry-bulb + a humidity penalty that grows as the wet-bulb
 *                   nears the point where panting stops working, less an
 *                   airflow credit with diminishing returns
 *   band            worst of the feels-like band, the wet-bulb band, and the
 *                   birds' own confirmation in their water-to-feed ratio
 *
 * The per-zone version (THVI, Tao–Xin) reads the 13 probes as a three-by-two
 * grid along and up the house and alarms on the worst cell, because the
 * exhaust end is always hotter than the average and it is the exhaust end
 * that kills birds.
 */

/** Tunnel cross-section: 18.3 m wide by 7.4 m average height. */
export const A_CROSS = 135.4;
/** Fans per controller group: groups 1–20 hold two, 21 and 22 hold four. 48 in all. */
export const fansInGroup = (group: number) => (group === 21 || group === 22 ? 4 : 2);
export const FAN_KW = 1.5;

/** BESS certified curve for the Qingdao 9FJ50GC07 50-inch 1.5 kW direct-drive fan: [Pa, m³/h]. */
const BESS: Array<[number, number]> = [
  [0, 52500], [12, 50500], [25, 48400], [37, 46300], [50, 44000],
  [62, 41100], [75, 37900], [87, 33800], [100, 28200],
];

/** Airflow of one fan against the house's negative pressure, m³/h. */
export function perFanAirflow(pa: number): number {
  if (pa <= BESS[0]![0]) return BESS[0]![1];
  const last = BESS[BESS.length - 1]!;
  if (pa >= last[0]) return last[1];
  for (let i = 0; i < BESS.length - 1; i++) {
    const [a, qa] = BESS[i]!;
    const [b, qb] = BESS[i + 1]!;
    if (pa >= a && pa <= b) return qa + ((pa - a) / (b - a)) * (qb - qa);
  }
  return last[1];
}

/** Air speed over the birds, m/s, from fans running and the pressure they work against. */
export function velocity(fans: number, pa: number | null): number | null {
  if (pa == null) return null;
  return (fans * perFanAirflow(pa)) / 3600 / A_CROSS;
}

/** Wet-bulb temperature, °C (Stull's approximation), from dry-bulb and relative humidity. */
export function wetBulb(t: number, rh: number): number {
  return (
    t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(t + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

/* Model knobs, as calibrated in Amino. */
const ALPHA = 0.55; // humidity penalty scale
const K_HUM = 2.0; // penalty sharpness near saturation
const EPS = 0.5; // depression softener, °C
const PANT = 27; // wet-bulb at which panting starts to fail, °C

/** The house feels-like, °C: dry-bulb, plus the humidity penalty, less the airflow credit. */
export function feelsLike(t: number, rh: number, v: number | null): { bft: number; wetBulbC: number } {
  const tw = wetBulb(t, rh);
  const den = Math.max(0.1, t - tw + EPS);
  const pen = Math.max(0, ALPHA * (tw - PANT) * (1 + K_HUM / den));
  const cool = 1.6 * Math.log(1 + (v ?? 0));
  return { bft: t + pen - cool, wetBulbC: tw };
}

export type Level = 0 | 1 | 2 | 3;
export const LEVELS = ["ok", "watch", "severe", "critical"] as const;
export type LevelName = (typeof LEVELS)[number];

const bftBand = (b: number): Level => (b >= 32.5 ? 3 : b >= 31 ? 2 : b >= 29 ? 1 : 0);
const wbBand = (tw: number): Level => (tw >= 29.5 ? 3 : tw >= 29 ? 2 : tw >= 27 ? 1 : 0);
/** Provisional THVI band, to be calibrated to this flock's panting and mortality. */
const thviBand = (x: number): Level => (x >= 31 ? 3 : x >= 29.5 ? 2 : x >= 27.5 ? 1 : 0);

export interface FeelsLike {
  bft: number;
  wetBulbC: number;
  velocity: number | null;
  fans: number;
  level: Level;
  band: LevelName;
}

/**
 * The house number: feels-like and its band, with the wet-bulb risk and the
 * birds' water-to-feed ratio folded in. Above 2.5 the birds are drinking to
 * cool and the band steps up; above 3.5 they are in trouble whatever the air
 * says.
 */
export function houseFeelsLike(
  t: number | null,
  rh: number | null,
  pa: number | null,
  fans: number,
  waterToFeed: number | null = null,
): FeelsLike | null {
  if (t == null || rh == null) return null;
  const v = velocity(fans, pa);
  const { bft, wetBulbC } = feelsLike(t, rh, v);
  let level: Level = Math.max(bftBand(bft), wbBand(wetBulbC)) as Level;
  if (waterToFeed != null) {
    if (waterToFeed > 3.5) level = 3;
    else if (waterToFeed > 2.5) level = Math.min(3, level + 1) as Level;
  }
  return { bft: Math.round(bft * 10) / 10, wetBulbC: Math.round(wetBulbC * 10) / 10, velocity: v == null ? null : Math.round(v * 100) / 100, fans, level, band: LEVELS[level] };
}

/* ── Per-zone: the exhaust end is what matters ──────────────────────────── */

export type Zone = "inlet" | "mid" | "exhaust";
export type Tier = "lower" | "upper";
/** Probe 06 is outside and excluded. Grouping confirmed against live readings in Amino. */
export const ZONE_PROBES: Record<Zone, Record<Tier, string[]>> = {
  inlet: { lower: ["01", "04"], upper: ["08", "11"] },
  mid: { lower: ["02", "05"], upper: ["09", "12"] },
  exhaust: { lower: ["03", "07"], upper: ["10", "13"] },
};

/** Tao–Xin velocity-corrected temperature-humidity index, °C; v floored at 0.2 m/s. */
export const thvi = (tDb: number, tWb: number, v: number) => (0.85 * tDb + 0.15 * tWb) * Math.pow(Math.max(0.2, v), -0.058);

export interface ZoneCell {
  zone: Zone;
  tier: Tier;
  tDb: number | null;
  feelsLike: number | null;
  level: Level;
}

/**
 * Six cells from the thirteen probes, and the worst of them. `probe` answers a
 * probe's temperature by its two-digit id, or null when it did not report.
 */
export function zoneFeelsLike(probe: (id: string) => number | null, rh: number | null, v: number | null): { cells: ZoneCell[]; worst: ZoneCell | null } {
  const cells: ZoneCell[] = [];
  for (const zone of Object.keys(ZONE_PROBES) as Zone[]) {
    for (const tier of ["lower", "upper"] as Tier[]) {
      const ts = ZONE_PROBES[zone][tier].map(probe).filter((x): x is number => x != null);
      const tDb = ts.length ? ts.reduce((a, b) => a + b, 0) / ts.length : null;
      let fl: number | null = null;
      let level: Level = 0;
      if (tDb != null && rh != null) {
        const tw = wetBulb(tDb, rh);
        fl = Math.round(thvi(tDb, tw, v ?? 0) * 10) / 10;
        level = Math.max(thviBand(fl), wbBand(tw)) as Level;
      }
      cells.push({ zone, tier, tDb, feelsLike: fl, level });
    }
  }
  const valid = cells.filter((c) => c.feelsLike != null);
  const worst = valid.length
    ? valid.reduce((w, c) => (c.level > w.level || (c.level === w.level && (c.feelsLike ?? 0) > (w.feelsLike ?? 0)) ? c : w))
    : null;
  return { cells, worst };
}
