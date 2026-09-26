/**
 * Nightly clear-out of the face vectors the roster no longer serves.
 *
 * Every scan at the gate leaves an embedding on its punch, so this grows by
 * roughly two rows per worker per day and each row is about 5 KB. Left alone
 * that is a few hundred megabytes a year of vectors nobody will ever match
 * against, because the gallery only ever offers the newest few days.
 *
 * The prune is keyed on exactly what the gallery read returns, so it cannot
 * delete something the gate is about to be offered — the two share their
 * constants rather than agreeing by eye.
 *
 * Hourly rather than at a fixed hour: a gate runs all day and the server is
 * restarted often enough that a once-a-day slot is missed as often as it is
 * hit. The work is a single UPDATE over an indexed predicate, and after the
 * first pass of any day it finds almost nothing to do.
 */
import { sql } from "drizzle-orm";
import { PHOTO_RETENTION_DAYS } from "@shared/canteen";
import { db } from "../db";
import { pruneTaughtCaptures, taughtCaptureCount } from "./face-gallery";
import { buildFaceHealth, formatFaceHealth } from "./face-health";
import { syncNightShiftBreakfast } from "./canteen";
import { istDate } from "./day-resolution";
import { ensureFaceModel } from "./face-model";

const EVERY_MS = 3_600_000;
/** Long enough after boot to be behind the migrations and the first requests. */
const FIRST_DELAY_MS = 120_000;

/**
 * The evening's face-health report rides the same tick.
 *
 * A fixed 21:30 timer is missed entirely by a server that restarts at 21:29,
 * and this one runs often enough to catch the hour whenever it comes round.
 * Keyed on the IST date so it says its piece once a day and not once an hour.
 */
const REPORT_HOUR_IST = 21;
const REPORT_DAYS = 30;
let reportedOn: string | null = null;
/** Night-shift breakfast is a statement about today, so it is re-asked each day. */
let breakfastSyncedOn: string | null = null;
/** The day the mean face was last checked; ensureFaceModel rebuilds when a day old. */
let faceModelCheckedOn: string | null = null;

const istHourAndDate = () => {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const at = (t: string) => f.find((x) => x.type === t)!.value;
  return { date: `${at("year")}-${at("month")}-${at("day")}`, hour: Number(at("hour")) };
};

/**
 * Punch and plate photographs older than the retention the devices are told
 * about. That figure was only ever told: nothing here cleared a photo, so the
 * one column that holds 30–60 KB a row grew for ever. The row stays — it is the
 * attendance — and only the picture goes.
 */
export async function pruneOldPhotos(conn: typeof db): Promise<number> {
  const cutoff = sql`((now() AT TIME ZONE 'Asia/Kolkata')::date - ${PHOTO_RETENTION_DAYS}::int)`;
  const a = await conn.execute(sql`UPDATE punches SET photo_url = NULL WHERE photo_url IS NOT NULL AND punch_date < ${cutoff}`);
  const b = await conn.execute(sql`UPDATE canteen_servings SET photo_url = NULL WHERE photo_url IS NOT NULL AND meal_date < ${cutoff}`);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick() {
  if (running) return; // a slow pass holds the next back rather than stacking
  running = true;
  try {
    const cleared = await pruneTaughtCaptures(db);
    // Silent when there was nothing to do, which is most hours. A log line
    // every hour saying "0" is a log nobody reads by the second week.
    if (cleared > 0) {
      console.log(`[faces] cleared ${cleared} aged-out capture(s); ${await taughtCaptureCount(db)} in the galleries`);
    }

    // An assignment that starts today grants breakfast today, and one that
    // ended yesterday takes it back, without anybody saving anything.
    const today = istDate();
    if (breakfastSyncedOn !== today) {
      breakfastSyncedOn = today;
      const r = await syncNightShiftBreakfast(db, undefined, today);
      if (r.granted || r.withdrawn) console.log(`[canteen] night-shift breakfast: ${r.granted} granted, ${r.withdrawn} withdrawn`);
    }

    // The mean face for centred matching, once a day (docs/face-matching-centred-plan.md).
    if (faceModelCheckedOn !== today) {
      faceModelCheckedOn = today;
      const { model, built } = await ensureFaceModel(db);
      if (built && model) console.log(`[faces] mean face rebuilt over ${model.people} enrolment(s)`);
    }

    const photos = await pruneOldPhotos(db);
    if (photos > 0) console.log(`[faces] cleared ${photos} photograph(s) older than ${PHOTO_RETENTION_DAYS} days`);

    const { date, hour } = istHourAndDate();
    if (hour >= REPORT_HOUR_IST && reportedOn !== date) {
      reportedOn = date;
      const report = await buildFaceHealth(db, REPORT_DAYS);
      // Only when there was something to measure. A nightly wall of zeroes is
      // a log nobody reads by the second week.
      if (report.gate.scans > 0) console.log(formatFaceHealth(report));
    }
  } catch (e) {
    console.error("[faces] nightly pass failed:", e);
  } finally {
    running = false;
  }
}

export function startFacePrune() {
  if (timer) return;
  const first = setTimeout(() => void tick(), FIRST_DELAY_MS);
  first.unref?.();
  timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref?.(); // never the reason the process cannot exit
}
