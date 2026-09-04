/**
 * Rebuild the counters in iot_house_day from the samples they were summarised
 * from.
 *
 * The day summary used to store a daily counter's highest reading since IST
 * midnight. The controllers reset their counters once a day but not at
 * midnight, and not at the same hour as each other — L5's feed around 21:30
 * IST, L3's around 02:00, the water meters a few minutes past twelve — so the
 * highest reading carried yesterday's closing figure into today until today
 * overtook it, and put a shed's evening feed in the day after it was eaten.
 *
 * The summary now stores what each counter CLIMBED between one midnight and
 * the next (see `dayCounters` in the store). Only days we hold samples for
 * can be rebuilt; older days keep what they have.
 *
 *   npx tsx scripts/repair-iot-days.ts                (dry, every day held)
 *   npx tsx scripts/repair-iot-days.ts --days 60      (dry, the last 60)
 *   npx tsx scripts/repair-iot-days.ts --apply
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { countersOf, recountDay } from "../server/services/iot/store";

const APPLY = process.argv.includes("--apply");
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : null;

const since = DAYS ? sql` AND s.at >= now() - (${DAYS} || ' days')::interval` : sql``;
const held = (
  await db.execute(sql`
    SELECT DISTINCT s.house_id AS "houseId", h.code,
           ((s.at AT TIME ZONE 'Asia/Kolkata')::date)::text AS day
      FROM iot_house_sample s JOIN houses h ON h.id = s.house_id
     WHERE TRUE${since}
     ORDER BY day DESC, h.code`)
).rows as Array<{ houseId: string; code: string; day: string }>;

const stored = new Map<string, { feedKg: number | null; waterL: number | null }>();
for (const r of (
  await db.execute(sql`SELECT house_id AS "houseId", day::text AS day, feed_kg AS "feedKg", water_l AS "waterL" FROM iot_house_day`)
).rows as Array<Record<string, unknown>>) {
  const n = (v: unknown) => (v == null ? null : Number(v));
  stored.set(`${r.houseId}|${r.day}`, { feedKg: n(r.feedKg), waterL: n(r.waterL) });
}

const fmt = (v: number | null) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const differs = (a: number | null, b: number | null) =>
  a == null || b == null ? a !== b : Math.abs(a - b) >= 1;

const changes: Array<{ houseId: string; code: string; day: string; line: string }> = [];
let missing = 0;
for (const h of held) {
  const c = await countersOf(h.houseId, h.day);
  const was = stored.get(`${h.houseId}|${h.day}`);
  if (!was) {
    missing++;
    continue;
  }
  if (differs(was.feedKg, c.feedKg) || differs(was.waterL, c.waterL)) {
    changes.push({
      ...h,
      line: `  ${h.code} ${h.day}  feed ${fmt(was.feedKg)} -> ${fmt(c.feedKg)} kg   water ${fmt(was.waterL)} -> ${fmt(c.waterL)} L`,
    });
  }
}

console.log(`\n  ${held.length} house-day(s) held as samples, ${changes.length} would change` + (missing ? `, ${missing} with no summary row` : "") + "\n");
for (const c of changes.slice(0, 40)) console.log(c.line);
if (changes.length > 40) console.log(`  ... and ${changes.length - 40} more`);

if (!APPLY) {
  console.log("\n  dry run — add --apply to write\n");
  process.exit(0);
}

let repaired = 0;
for (const c of changes) if (await recountDay(c.houseId, c.day)) repaired++;
console.log(`\n  repaired ${repaired} day(s)\n`);
process.exit(0);
