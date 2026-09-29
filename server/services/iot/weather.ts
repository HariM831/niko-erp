/**
 * The air outside, from a weather service, and how niko reads it.
 *
 * Every house has an outside probe, and every one of them hangs on the
 * shed's wall: in the sun it reads the sun. On 17 September 2026 at noon
 * they read 32 to 35 while the service said 28; on 29 September the service
 * said 31.8 while the coolest probe, L3's, in shade, read 34.7 — and the user
 * took the coolest live probe as the outside temperature (see the board).
 *
 * The service's moisture is trusted where its temperature is not: its dew
 * point is read at the shade probe's temperature to estimate the outside
 * humidity, because no shed has a humidity sensor outside. Without a live
 * probe the service's own humidity stands.
 *
 * Fetched at most every ten minutes; a failure keeps the last answer and
 * says how old it is.
 */
const LAT = process.env.FARM_LAT ?? "26.80";
const LON = process.env.FARM_LON ?? "92.70";

export interface Weather {
  at: string;
  tempC: number;
  humidityPct: number;
  /** The forecast's dew point: its moisture, whatever the temperature. */
  dewPointC: number | null;
  feelsLikeC: number;
  cloudPct: number;
  /** When niko fetched it; older than an hour means the service has been unreachable. */
  fetchedAt: string;
}

let cache: { w: Weather; at: number } | null = null;

/** The forecast's air for an hour: its humidity, and its dew point to read that moisture at another temperature. */
export interface HourAir {
  rh: number | null;
  dewPointC: number | null;
}

/**
 * Outside air hour by hour, yesterday and today, so a shed's humidity can be
 * judged against the air that came in at that hour rather than a fixed line.
 * Fetched at most every thirty minutes.
 */
let rhCache: { hours: Map<number, HourAir>; at: number } | null = null;
export async function outsideAirByHour(): Promise<Map<number, HourAir>> {
  if (rhCache && Date.now() - rhCache.at < 30 * 60_000) return rhCache.hours;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=relative_humidity_2m,dew_point_2m&past_days=1&forecast_days=1&timezone=Asia%2FKolkata`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const j = (await res.json()) as {
      hourly: { time: string[]; relative_humidity_2m: Array<number | null>; dew_point_2m?: Array<number | null> };
    };
    const hours = new Map<number, HourAir>();
    j.hourly.time.forEach((t, i) => {
      // the service stamps IST wall-clock time; keyed on the UTC millisecond of that hour
      hours.set(new Date(`${t}:00+05:30`).getTime(), {
        rh: j.hourly.relative_humidity_2m[i] ?? null,
        dewPointC: j.hourly.dew_point_2m?.[i] ?? null,
      });
    });
    rhCache = { hours, at: Date.now() };
    return hours;
  } catch (e) {
    console.warn(`[weather] air by hour: ${e instanceof Error ? e.message : e}`);
    return rhCache?.hours ?? new Map();
  }
}

/** The key of the forecast hour a moment falls in. The service's hours begin on the IST hour, the UTC half-hour. */
export function istHourKey(at: Date): number {
  const IST = 5.5 * 3_600_000;
  return Math.floor((at.getTime() + IST) / 3_600_000) * 3_600_000 - IST;
}

/**
 * Relative humidity of air holding the moisture of `dewPointC`, at `tempC`
 * (Magnus). 31.8 degrees and 68% at the service became 58% at L3's 34.7 on
 * 29 Sep 2026: the same water in warmer air.
 */
export function rhFromDewPoint(dewPointC: number, tempC: number): number {
  const a = 17.62;
  const b = 243.12;
  const rh = 100 * Math.exp((a * dewPointC) / (b + dewPointC) - (a * tempC) / (b + tempC));
  return Math.round(Math.min(100, Math.max(0, rh)));
}

/**
 * Outside humidity for the hour a reading was taken: the forecast hour's dew
 * point read at the shade probe's temperature when both are known, else the
 * forecast's own humidity for the hour, else null.
 */
export function outsideHumidityAt(hours: Map<number, HourAir>, at: Date, shadeTempC: number | null = null): number | null {
  const air = hours.get(istHourKey(at));
  if (!air) return null;
  if (air.dewPointC != null && shadeTempC != null) return rhFromDewPoint(air.dewPointC, shadeTempC);
  return air.rh;
}

export async function outsideWeather(): Promise<Weather | null> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.w;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,cloud_cover&timezone=Asia%2FKolkata`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const j = (await res.json()) as {
      current: { time: string; temperature_2m: number; relative_humidity_2m: number; dew_point_2m?: number; apparent_temperature: number; cloud_cover: number };
    };
    const w: Weather = {
      at: j.current.time,
      tempC: j.current.temperature_2m,
      humidityPct: j.current.relative_humidity_2m,
      dewPointC: j.current.dew_point_2m ?? null,
      feelsLikeC: j.current.apparent_temperature,
      cloudPct: j.current.cloud_cover,
      fetchedAt: new Date().toISOString(),
    };
    cache = { w, at: Date.now() };
    return w;
  } catch (e) {
    console.warn(`[weather] ${e instanceof Error ? e.message : e}`);
    return cache?.w ?? null;
  }
}
