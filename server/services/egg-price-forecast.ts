/**
 * The egg benchmark, a month ahead.
 *
 * Reads the rates the sales desk has set, hands them to TimesFM 2.5, and
 * stores what comes back in `egg_price_forecasts` for the home page to draw.
 * Nothing that prices anything reads this table: an invoice takes the
 * benchmark and only the benchmark.
 *
 * The model runs in Python, in its own venv, as a short-lived child process —
 * TimesFM holds about 1.5 GB while it works and the droplet has 4 GB shared
 * with staging, so it is spawned, used and gone rather than resident. The
 * database stays on this side of the pipe: one language owns the schema.
 *
 * Anchored to the last actual rate rather than to the clock. That is what
 * makes one tick cover every case that should refresh a forecast — a restart,
 * a new day, and this evening's rate being typed in — because all three show
 * up as the anchor having moved.
 */
import { spawn } from "node:child_process";
import { asc, desc, eq, lte, sql } from "drizzle-orm";
import { eggBenchmarkPrices, eggPriceForecasts } from "@shared/schema";
import { db as defaultDb, type Db } from "../db";
import { istDate } from "./day-resolution";

/** Days ahead. The tile offers 7, 14 and 28 out of this one run. */
export const HORIZON_DAYS = 28;
/**
 * Below this there is nothing to forecast from: the Python differences the
 * series against a year earlier before taking its context, so a year plus a
 * few months is the floor. Kept in step with MIN_HISTORY there.
 */
const MIN_HISTORY_DAYS = 364 + 120;
/** Past this, the newest rate is history and there is nothing ahead to draw. */
const STALE_AFTER_DAYS = 7;
const SCRIPT = "scripts/forecast/egg_price_forecast.py";
/** Cold start loads 800 MB of weights; a warm one is seconds. */
const TIMEOUT_MS = 300_000;

export interface ForecastPoint {
  date: string;
  p10: number;
  p50: number;
  p90: number;
}

export interface StoredForecast {
  anchorDate: string;
  generatedAt: string;
  model: string;
  points: ForecastPoint[];
}

const n = (v: string | number) => Number(v);
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Every rate up to today, as a dense daily series.
 *
 * The gaps are filled by carrying the last rate forward, which is not a
 * modelling choice — it is the rule the rest of the system already reads a
 * rate-less day by, so the model sees the series the business sees. TimesFM
 * needs even spacing and would otherwise read a hole as a day that never was.
 */
export async function benchmarkSeries(db: Db, until = istDate()): Promise<{ date: string; value: number }[]> {
  const rows = await db
    .select({ on: eggBenchmarkPrices.effectiveFrom, rate: eggBenchmarkPrices.ratePerEgg })
    .from(eggBenchmarkPrices)
    .where(lte(eggBenchmarkPrices.effectiveFrom, until))
    .orderBy(asc(eggBenchmarkPrices.effectiveFrom));
  if (!rows.length) return [];

  const out: { date: string; value: number }[] = [];
  let i = 0;
  let carried = n(rows[0]!.rate);
  for (let day = rows[0]!.on; day <= rows[rows.length - 1]!.on; day = addDays(day, 1)) {
    while (i < rows.length && rows[i]!.on === day) carried = n(rows[i++]!.rate);
    out.push({ date: day, value: carried });
  }
  return out;
}

/** The model, as a child process. Rejects on anything that is not clean JSON. */
export function forecastWith(
  series: { date: string; value: number }[],
  horizon = HORIZON_DAYS,
): Promise<{ model: string; contextDays: number; anchorDate: string; points: ForecastPoint[] }> {
  const python = process.env.FORECAST_PYTHON;
  if (!python) throw new Error("FORECAST_PYTHON is not set");

  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`unreadable output: ${out.slice(0, 200)}`));
      }
    });

    child.stdin.end(
      JSON.stringify({
        // The whole series, not the model's context window: the seasonal
        // framing differences against a year ago before it takes its 2,048.
        series,
        horizon,
        // Off unless asked for. Measured at 0.7% over 180 origins — see the
        // plan doc; worth re-testing against a raw NECC quote rather than
        // this averaged one.
        calendar: process.env.FORECAST_CALENDAR === "1",
      }),
    );
  });
}

/**
 * Forecast from the newest rate and store it, unless that has been done.
 *
 * Returns what it did, so the tick can stay quiet and the script that calls
 * this by hand can say something.
 */
export async function refreshForecast(
  db: Db = defaultDb,
  opts: { force?: boolean } = {},
): Promise<{ ran: boolean; reason?: string; anchorDate?: string }> {
  const series = await benchmarkSeries(db);
  if (series.length < MIN_HISTORY_DAYS) {
    return { ran: false, reason: `${series.length} day(s) of benchmark history; the seasonal framing needs ${MIN_HISTORY_DAYS}` };
  }

  const anchorDate = series[series.length - 1]!.date;
  // A forecast anchored to a rate nobody has refreshed in a week is a
  // forecast of days that have already happened. The home page declines to
  // draw one; there is no reason to spend fifteen seconds of model making it.
  if (anchorDate < addDays(istDate(), -STALE_AFTER_DAYS)) {
    return { ran: false, reason: `benchmark last set ${anchorDate}`, anchorDate };
  }

  const [have] = await db
    .select({ anchor: eggPriceForecasts.anchorDate })
    .from(eggPriceForecasts)
    .orderBy(desc(eggPriceForecasts.anchorDate))
    .limit(1);
  if (!opts.force && have?.anchor === anchorDate) return { ran: false, reason: "already forecast", anchorDate };

  const result = await forecastWith(series);
  if (result.anchorDate !== anchorDate) {
    throw new Error(`model anchored to ${result.anchorDate}, expected ${anchorDate}`);
  }

  await db
    .insert(eggPriceForecasts)
    .values(
      result.points.map((p) => ({
        anchorDate,
        forDate: p.date,
        p10: p.p10.toFixed(4),
        p50: p.p50.toFixed(4),
        p90: p.p90.toFixed(4),
        model: result.model,
        contextDays: result.contextDays,
      })),
    )
    // Re-running the same anchor is a correction, not an error.
    .onConflictDoUpdate({
      target: [eggPriceForecasts.anchorDate, eggPriceForecasts.forDate],
      set: {
        p10: sql`excluded."p10"`,
        p50: sql`excluded."p50"`,
        p90: sql`excluded."p90"`,
        model: sql`excluded."model"`,
        contextDays: sql`excluded."context_days"`,
        generatedAt: new Date(),
      },
    });

  return { ran: true, anchorDate };
}

/** The newest run, for the home page. Null before the first one. */
export async function latestForecast(db: Db): Promise<StoredForecast | null> {
  const [newest] = await db
    .select({ anchor: eggPriceForecasts.anchorDate })
    .from(eggPriceForecasts)
    .orderBy(desc(eggPriceForecasts.anchorDate))
    .limit(1);
  if (!newest) return null;

  const rows = await db
    .select({
      forDate: eggPriceForecasts.forDate,
      p10: eggPriceForecasts.p10,
      p50: eggPriceForecasts.p50,
      p90: eggPriceForecasts.p90,
      model: eggPriceForecasts.model,
      generatedAt: eggPriceForecasts.generatedAt,
    })
    .from(eggPriceForecasts)
    .where(eq(eggPriceForecasts.anchorDate, newest.anchor))
    .orderBy(asc(eggPriceForecasts.forDate));
  if (!rows.length) return null;

  return {
    anchorDate: newest.anchor,
    generatedAt: rows[0]!.generatedAt.toISOString(),
    model: rows[0]!.model,
    points: rows.map((r) => ({ date: r.forDate, p10: n(r.p10), p50: n(r.p50), p90: n(r.p90) })),
  };
}

/* ── The tick ──────────────────────────────────────────────────────────── */

const EVERY_MS = 1_800_000;
/** Behind the migrations and the first requests, as the other schedulers are. */
const FIRST_DELAY_MS = 120_000;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
/** The last reason printed, so a standing condition is said once, not hourly. */
let saidWhy: string | null = null;

async function tick() {
  if (running) return; // a slow run holds the next back rather than stacking
  running = true;
  try {
    const r = await refreshForecast();
    // Silent when the anchor has not moved, which is most half-hours.
    if (r.ran) console.log(`[price] forecast refreshed from ${r.anchorDate}`);
    // But not silent about a reason there is no forecast at all. A blank tile
    // and an empty log is the combination nobody can diagnose — and "the
    // benchmark has not been set since January" is the answer.
    else if (r.reason && r.reason !== "already forecast" && r.reason !== saidWhy) {
      saidWhy = r.reason;
      console.log(`[price] no forecast — ${r.reason}`);
    }
  } catch (e) {
    // The last forecast stays on the tile. A model that cannot run is not a
    // reason to draw a worse line — it is a reason to draw the old one.
    console.error(`[price] forecast failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    running = false;
  }
}

/**
 * Started at boot, and only where it is wanted.
 *
 * Production and staging share one 4 GB droplet, so both loading a 200M model
 * is the same hazard the deploy notes flag for the IoT poller running twice.
 * `FORECAST_ENABLED=1` belongs in prod.env alone.
 */
export function startPriceForecast() {
  if (timer) return;
  if (process.env.FORECAST_ENABLED !== "1") {
    console.log("[price] forecast off (FORECAST_ENABLED is not 1)");
    return;
  }
  if (!process.env.FORECAST_PYTHON) {
    console.warn("[price] FORECAST_ENABLED is set but FORECAST_PYTHON is not — no forecast will run");
    return;
  }
  const first = setTimeout(() => void tick(), FIRST_DELAY_MS);
  first.unref?.();
  timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref?.(); // never the reason the process cannot exit
}
