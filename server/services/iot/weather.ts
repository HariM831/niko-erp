/**
 * The air outside, from a weather service rather than the sheds' own probes.
 *
 * Every house has an outside probe, and every one of them hangs on the
 * shed's wall: in the sun it reads the sun. On 17 September 2026 at noon
 * they read 32 to 35 while the shade air at Thelamara was 28. So the board's
 * outside figure comes from Open-Meteo for the farm's own coordinates —
 * Nabil Kacharigaon, Thelamara, Sonitpur — and the wall probes are shown
 * beside it for what they are.
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
  feelsLikeC: number;
  cloudPct: number;
  /** When niko fetched it; older than an hour means the service has been unreachable. */
  fetchedAt: string;
}

let cache: { w: Weather; at: number } | null = null;

export async function outsideWeather(): Promise<Weather | null> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.w;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,apparent_temperature,cloud_cover&timezone=Asia%2FKolkata`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const j = (await res.json()) as { current: { time: string; temperature_2m: number; relative_humidity_2m: number; apparent_temperature: number; cloud_cover: number } };
    const w: Weather = { at: j.current.time, tempC: j.current.temperature_2m, humidityPct: j.current.relative_humidity_2m, feelsLikeC: j.current.apparent_temperature, cloudPct: j.current.cloud_cover, fetchedAt: new Date().toISOString() };
    cache = { w, at: Date.now() };
    return w;
  } catch (e) {
    console.warn(`[weather] ${e instanceof Error ? e.message : e}`);
    return cache?.w ?? null;
  }
}
