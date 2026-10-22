/**
 * Reopen a submitted egg stock day.
 *
 *   npx tsx scripts/reopen-egg-day.ts 2026-10-08
 *   npx tsx scripts/reopen-egg-day.ts 2026-10-08 --commit
 *
 * A submitted statement locks its day: nothing may move stock into or out of
 * it, which is the point — it is somebody's signature on a day's grading,
 * packing and loading. The screen lets an Admin or a Director lift that, and
 * this is the same act from the command line, for when a day has to be
 * reopened to finish something the catch-up started.
 *
 * It is done the way the screen does it, by recording a reopening rather than
 * erasing the submission: the day stays signed, and the record shows it was
 * opened again afterwards and by whom.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const day = process.argv.slice(2).find((a) => !a.startsWith("--"));
const COMMIT = process.argv.includes("--commit");

async function main() {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error("Usage: reopen-egg-day.ts YYYY-MM-DD [--commit]");
    process.exitCode = 1;
    return;
  }
  const [row] = (
    await db.execute(sql`
      SELECT d.day::text, d.submitted_at::text AS submitted, s.name AS submitted_by,
             d.reopened_at::text AS reopened, r.name AS reopened_by
        FROM egg_stock_days d
        LEFT JOIN users s ON s.id = d.submitted_by
        LEFT JOIN users r ON r.id = d.reopened_by
       WHERE d.day = ${day}::date
    `)
  ).rows as Array<{ day: string; submitted: string | null; submitted_by: string | null;
                    reopened: string | null; reopened_by: string | null }>;

  if (!row) {
    console.log(`\n  ${day} was never submitted — it is already open.\n`);
    await pool.end();
    return;
  }
  const locked = !!row.submitted && !(row.reopened && row.reopened > row.submitted);
  console.log(`\n  ${day}`);
  console.log(`    submitted ${row.submitted?.slice(0, 16) ?? "never"}${row.submitted_by ? ` by ${row.submitted_by}` : ""}`);
  if (row.reopened) console.log(`    reopened  ${row.reopened.slice(0, 16)}${row.reopened_by ? ` by ${row.reopened_by}` : ""}`);
  console.log(`    ${locked ? "LOCKED — stock cannot move in or out of it" : "open"}\n`);

  if (!locked || !COMMIT) {
    console.log(`  ${locked ? "Dry run — nothing written. Re-run with --commit." : "Nothing to do."}\n`);
    await pool.end();
    return;
  }
  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'admin' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("no admin user to record the reopening against");

  await db.execute(sql`
    UPDATE egg_stock_days SET reopened_by = ${user.id}::uuid, reopened_at = now()
     WHERE day = ${day}::date
  `);
  console.log(`  ${day} is open again. The submission stays on the record.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
