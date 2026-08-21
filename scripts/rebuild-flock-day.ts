/**
 * Rebuild `flock_day` for every flock, or for named ones.
 *
 * The writers keep the rollup current on their own, so this is not part of
 * normal operation. It is for the two cases where rows arrive without passing
 * through a service: a bulk import (the Amino data), and a change to a
 * derivation in `refreshFlockDay` itself, which restates every existing row.
 *
 * Each flock is its own transaction, so a bad one fails alone and the rest of
 * the farm still gets rebuilt.
 *
 * Run:  npx tsx scripts/rebuild-flock-day.ts
 *       npx tsx scripts/rebuild-flock-day.ts AMN-2026-01 AMN-2026-02
 */
import { asc, inArray } from "drizzle-orm";
import { flocks } from "@shared/schema";
import { db } from "../server/db";
import { refreshFlockDay } from "../server/services/rollup";

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const list = await db
  .select({ id: flocks.id, code: flocks.code })
  .from(flocks)
  .where(wanted.length ? inArray(flocks.code, wanted) : undefined)
  .orderBy(asc(flocks.code));

if (wanted.length && list.length !== wanted.length) {
  const found = new Set(list.map((f) => f.code));
  console.log(`  no such batch: ${wanted.filter((c) => !found.has(c)).join(", ")}`);
}

console.log(`\n  rebuilding ${list.length} batch(es)\n`);
let rows = 0;
let failed = 0;
for (const f of list) {
  try {
    const n = await db.transaction((tx) => refreshFlockDay(tx, f.id));
    rows += n;
    console.log(`  ✓ ${f.code.padEnd(14)} ${String(n).padStart(5)} days`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${f.code.padEnd(14)} ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\n  ${rows.toLocaleString("en-IN")} rows${failed ? `, ${failed} batch(es) failed` : ""}\n`);
process.exit(failed ? 1 : 0);
