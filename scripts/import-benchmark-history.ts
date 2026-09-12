/**
 * Seven years of the egg benchmark, brought in from Zoho.
 *
 * fixtures/egg-benchmark-history.csv is Zoho's *Average Price by Invoice
 * Date* report, 01 Apr 2019 → 30 Jan 2026, converted once from the workbook
 * it was exported as. It is the market rate as this business actually
 * realised it, and it is the only long series of that number there is — the
 * forecast on the home page has nothing to learn from without it.
 *
 * It lands in `egg_benchmark_prices`, the same table the sales desk types
 * into each evening, because there is one egg rate in this system and a
 * second table holding the same number would only raise the question of which
 * one is true. Imported rows carry `source = 'zoho-history'` so they are
 * always distinguishable from `'sales'`.
 *
 * A day that already has a rate is never touched. Somebody typed that, and
 * the unique index on effective_from makes leaving it alone a single clause
 * rather than a rule to remember.
 *
 *   npx tsx scripts/import-benchmark-history.ts            # report
 *   npx tsx scripts/import-benchmark-history.ts --write    # apply
 */
import { readFileSync } from "node:fs";
import { eggBenchmarkPrices } from "@shared/schema";

const FILE = "fixtures/egg-benchmark-history.csv";
const SOURCE = "zoho-history";

/**
 * The database is reached only after the file has been read and reported.
 *
 * A dry run exists to answer "is this file right?", and importing the db
 * module at the top of this one makes that question unanswerable on a machine
 * with no DATABASE_URL — the process dies on a stack trace before printing a
 * word about the file. So the connection is opened late, and its absence is
 * a sentence rather than a throw.
 */
async function connect() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      /* no .env here either */
    }
  }
  if (!process.env.DATABASE_URL) return null;
  return import("../server/db");
}

async function main() {
  const write = process.argv.includes("--write");

  const lines = readFileSync(FILE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const header = lines.shift();
  if (header !== "date,rate_per_egg") throw new Error(`${FILE}: unexpected header ${header}`);

  const rows = lines.map((l, i) => {
    const [date, rate] = l.split(",");
    const n = Number(rate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(n) || n <= 0) {
      throw new Error(`${FILE}:${i + 2}: cannot read "${l}"`);
    }
    return { effectiveFrom: date!, ratePerEgg: n.toFixed(4), source: SOURCE };
  });
  rows.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  const first = rows[0]!.effectiveFrom;
  const last = rows[rows.length - 1]!.effectiveFrom;
  console.log(`${FILE}: ${rows.length} rate(s), ${first} → ${last}`);
  console.log(`  ₹${Math.min(...rows.map((r) => Number(r.ratePerEgg))).toFixed(4)} – ₹${Math.max(...rows.map((r) => Number(r.ratePerEgg))).toFixed(4)} per egg`);

  // The gaps are worth printing: they are days the market had no rate of its
  // own and they stay that way, carrying the last rate before them, exactly
  // as billing already reads them.
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = Date.parse(rows[i - 1]!.effectiveFrom);
    const days = (Date.parse(rows[i]!.effectiveFrom) - prev) / 86_400_000;
    if (days > 1) gaps += days - 1;
  }
  if (gaps) console.log(`  ${gaps} day(s) missing inside the span — left missing`);

  const mod = await connect();
  if (!mod) {
    console.log("\nDATABASE_URL is not set, so nothing was compared and nothing written.");
    console.log("The file above is sound; point DATABASE_URL at the books and run this again.");
    process.exitCode = 1;
    return;
  }
  const { db, pool } = mod;
  closePool = () => pool.end();

  const existing = new Set(
    (await db.select({ on: eggBenchmarkPrices.effectiveFrom }).from(eggBenchmarkPrices)).map((r) => r.on),
  );
  const fresh = rows.filter((r) => !existing.has(r.effectiveFrom));
  console.log(`\n  ${existing.size} day(s) already priced; ${rows.length - fresh.length} of the file's days among them`);
  console.log(`  ${fresh.length} to insert`);

  if (!write) {
    console.log("\nNothing written. Re-run with --write to apply.");
    return;
  }

  // Chunked: 2,458 rows is four parameters each, comfortably inside the
  // driver's limit in one statement, but a chunk keeps it that way if the
  // file grows.
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500);
    const done = await db
      .insert(eggBenchmarkPrices)
      .values(chunk)
      .onConflictDoNothing({ target: eggBenchmarkPrices.effectiveFrom })
      .returning({ on: eggBenchmarkPrices.effectiveFrom });
    inserted += done.length;
  }
  console.log(`\nInserted ${inserted} rate(s).`);
}

/** Set once a pool exists, so a run that never opened one still exits. */
let closePool: (() => Promise<void>) | null = null;

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool?.());
