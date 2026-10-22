/**
 * Make one day's physical count the only count there is.
 *
 *   npx tsx scripts/set-egg-closing-stock.ts --on 2026-10-15 \
 *     --medium 6 --large 442 --niko 128 --brown 42 --jumbo 8 --dirty 423
 *   ... --commit
 *
 * The user, 22 Oct 2026, giving the closing stock of 15 October: "this is the
 * only fact we will base on. clear closing stock for all other days."
 *
 * Stock here is periodic — it is whatever somebody counted, carried forward by
 * what moved since — so every count is an anchor, and a wrong one drags every
 * day after it. Where the counts disagree with each other the way to settle it
 * is not to average them but to keep the one that was actually counted and
 * drop the rest.
 *
 * Boxes for every grade except Dirty, which the packing room counts in trays
 * of 30. A grade the sheet does not mention is zero: the sheet is the count,
 * and a grade absent from it is a grade with none left.
 *
 * It does not touch the day locks. A submitted statement stays submitted —
 * that is a person's signature on a day's work, not a figure.
 */
import { sql } from "drizzle-orm";
import { EGG_SIZES, EGG_UNIT, type EggSize } from "@shared/egg-sizes";
import { db, pool } from "../server/db";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const ON = arg("on");
const COMMIT = process.argv.includes("--commit");

async function main() {
  if (!ON || !/^\d{4}-\d{2}-\d{2}$/.test(ON)) {
    console.error("Usage: set-egg-closing-stock.ts --on YYYY-MM-DD [--large 442 ...] [--commit]");
    process.exitCode = 1;
    return;
  }
  const counts = Object.fromEntries(
    EGG_SIZES.map((s) => [s, Math.max(0, Math.trunc(Number(arg(s) ?? 0)))]),
  ) as Record<EggSize, number>;

  const existing = (
    await db.execute(sql`
      SELECT counted_on::text AS day, small, medium, large, xl, jumbo, brown, niko, dirty,
             (SELECT count(*)::int FROM egg_stock_days d
               WHERE d.day = c.counted_on AND d.submitted_at IS NOT NULL) AS locked
        FROM egg_stock_count c ORDER BY counted_on
    `)
  ).rows as Array<Record<string, number | string>>;

  console.log(`\n  ${existing.length} day(s) carry a count — ${COMMIT ? "CLEARING" : "dry run"}\n`);
  for (const r of existing) {
    const kept = r.day === ON;
    console.log(
      `    ${kept ? "keep " : "clear"} ${String(r.day)}  ` +
        EGG_SIZES.filter((s) => Number(r[s]) > 0)
          .map((s) => `${s} ${r[s]}`)
          .join(", ") +
        `${r.locked ? "   (day submitted)" : ""}`,
    );
  }

  console.log(`\n  ${ON} becomes:`);
  for (const s of EGG_SIZES) {
    if (!counts[s]) continue;
    console.log(`    ${s.padEnd(8)}${String(counts[s]).padStart(6)} ${EGG_UNIT[s][counts[s] === 1 ? "one" : "many"]}`);
  }
  const silent = EGG_SIZES.filter((s) => !counts[s]);
  console.log(`    ${silent.join(", ")}: nothing left`);

  if (!COMMIT) {
    console.log(`\n  Dry run — nothing written. Re-run with --commit.\n`);
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'admin' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("no admin user to record the count against");

  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM egg_stock_count WHERE counted_on <> ${ON}::date`);
    await tx.execute(sql`
      INSERT INTO egg_stock_count
             (counted_on, small, medium, large, xl, jumbo, brown, niko, dirty, recorded_by, updated_at)
      VALUES (${ON}::date, ${counts.small}, ${counts.medium}, ${counts.large}, ${counts.xl},
              ${counts.jumbo}, ${counts.brown}, ${counts.niko}, ${counts.dirty}, ${user.id}::uuid, now())
      ON CONFLICT (counted_on) DO UPDATE SET
        small = excluded.small, medium = excluded.medium, large = excluded.large,
        xl = excluded.xl, jumbo = excluded.jumbo, brown = excluded.brown,
        niko = excluded.niko, dirty = excluded.dirty, updated_at = now()
    `);
  });
  console.log(`\n  ${ON} is now the only count. ${existing.filter((r) => r.day !== ON).length} other(s) cleared.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
