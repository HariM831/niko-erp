/**
 * Put the stored samples' totals right against their lines.
 *
 * Until 2026-09-04 the sample store took a family's aggregate tag as read. At
 * 16:33 IST that day every computed tag on every controller read 0 for one
 * poll — the water and feed totals, the silo, the per-bird figures — while
 * the numbered lines carried on, and the sample stored the blink. The store
 * now takes the larger of the total and the sum of its lines (see
 * `resolveMetric` in bhfarm.ts); this applies the same rule to what was
 * written before, and blanks a per-bird figure of 0 against a real total.
 *
 *   npx tsx scripts/repair-iot-samples.ts          (dry)
 *   npx tsx scripts/repair-iot-samples.ts --apply
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");

const FAMILIES = [
  { total: "water_l", lines: ["water_l_1", "water_l_2", "water_l_3", "water_l_4"], perBird: "water_per_bird_ml" },
  { total: "feed_kg", lines: ["feed_kg_1", "feed_kg_2", "feed_kg_3", "feed_kg_4"], perBird: "feed_per_bird_g" },
  { total: "silo_kg", lines: ["silo_kg_1", "silo_kg_2", "silo_kg_3", "silo_kg_4"], perBird: null },
] as const;

/** Sum of the lines, treating a missing line as nothing rather than as unknown. */
const sumOf = (lines: readonly string[]) => sql.raw(lines.map((l) => `coalesce("${l}", 0)`).join(" + "));
/** True when at least one line answered. */
const anyLine = (lines: readonly string[]) => sql.raw(lines.map((l) => `"${l}" IS NOT NULL`).join(" OR "));

for (const f of FAMILIES) {
  const total = sql.raw(`"${f.total}"`);
  const where = sql`(${anyLine(f.lines)}) AND (${total} IS NULL OR ${total} < ${sumOf(f.lines)})`;
  const [n] = (await db.execute(sql`SELECT count(*)::int AS n FROM iot_house_sample WHERE ${where}`)).rows as Array<{ n: number }>;
  console.log(`  ${f.total}: ${n!.n} sample(s) below the sum of their lines`);
  if (APPLY && n!.n) {
    const r = await db.execute(sql`UPDATE iot_house_sample SET ${total} = ${sumOf(f.lines)} WHERE ${where}`);
    console.log(`    -> updated ${r.rowCount ?? 0}`);
  }

  if (f.perBird) {
    const pb = sql.raw(`"${f.perBird}"`);
    const pbWhere = sql`${pb} = 0 AND ${total} > 0`;
    const [m] = (await db.execute(sql`SELECT count(*)::int AS n FROM iot_house_sample WHERE ${pbWhere}`)).rows as Array<{ n: number }>;
    console.log(`  ${f.perBird}: ${m!.n} sample(s) at 0 against a real total`);
    if (APPLY && m!.n) {
      const r = await db.execute(sql`UPDATE iot_house_sample SET ${pb} = NULL WHERE ${pbWhere}`);
      console.log(`    -> blanked ${r.rowCount ?? 0}`);
    }
  }
}

console.log(APPLY ? "\n  done\n" : "\n  dry run — add --apply to write\n");
process.exit(0);
