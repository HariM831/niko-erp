/**
 * Bring a market's daily egg rates into egg_market_rates — Kolkata first, from
 * the user's "KOL Rates.xlsx" (2 Oct 2026), May 2020 to date.
 *
 * The file is a JSON object of ISO date → ₹ per egg, made from the workbook
 * beforehand: its dates are a mix of real dates with day and month swapped,
 * dd/mm/yyyy text, and one year typed wrong, so they are read as a running
 * daily sequence (each row the candidate nearest the day after the last) before
 * they get here. A rate somebody has typed on the Benchmark page is never
 * overwritten by the import.
 *
 *   npx tsx scripts/import-market-rates.ts --market kolkata --file kol.json            (dry)
 *   npx tsx scripts/import-market-rates.ts --market kolkata --file kol.json --apply
 */
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { eggMarketRates } from "@shared/schema";
import { db } from "../server/db";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const market = arg("market");
const file = arg("file");
const APPLY = process.argv.includes("--apply");
if (!market || !file) {
  console.error("\n  --market <name> --file <date→rate JSON> are required\n");
  process.exit(1);
}

const rates = JSON.parse(await readFile(file, "utf8")) as Record<string, number>;
const rows = Object.entries(rates)
  .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v) && v > 0 && v < 100)
  .sort(([a], [b]) => a.localeCompare(b));

const typed = new Set(
  (
    await db
      .select({ d: eggMarketRates.rateDate })
      .from(eggMarketRates)
      .where(and(eq(eggMarketRates.market, market), sql`coalesce(${eggMarketRates.source}, '') <> 'kol-sheet'`))
  ).map((r) => r.d),
);
const toWrite = rows.filter(([d]) => !typed.has(d));

console.log(`\n  ${market}: ${rows.length} day(s) in the file, ${rows[0]?.[0]} to ${rows[rows.length - 1]?.[0]}`);
console.log(`  ${typed.size} day(s) already typed on the Benchmark page — left alone`);
console.log(`  ${toWrite.length} to write`);

if (!APPLY) {
  console.log("\n  Dry run — nothing written. Re-run with --apply.\n");
  process.exit(0);
}
await db.transaction(async (tx) => {
  for (let i = 0; i < toWrite.length; i += 500) {
    const chunk = toWrite.slice(i, i + 500);
    await tx
      .insert(eggMarketRates)
      .values(chunk.map(([d, v]) => ({ market, rateDate: d, ratePerEgg: v.toFixed(4), source: "kol-sheet" })))
      .onConflictDoUpdate({
        target: [eggMarketRates.market, eggMarketRates.rateDate],
        set: { ratePerEgg: sql`excluded.rate_per_egg`, source: "kol-sheet" },
        where: sql`coalesce(${eggMarketRates.source}, '') = 'kol-sheet'`,
      });
  }
});
console.log(`\n  Written.\n`);
process.exit(0);
