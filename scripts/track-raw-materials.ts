/**
 * Every raw material tracks stock, so a settled gate receipt takes it in.
 *
 * The user's call on 26 Sep 2026: "every gate in should cause a stock uptake",
 * after settlement, for all 24 raw materials. Settlement already put a tracked
 * item into stock — but on staging only Broken Rice and Soybean Meal were
 * tracked, so every other lorry that came through the gate left Stock on Hand
 * exactly where it was.
 *
 * For each item in the Feed category that does not yet track stock:
 *
 *   - tracking goes on, with 1073 Feed Stock as its inventory account — the
 *     account the two already-tracked raw materials carry, and the one
 *     production takes raw material out of;
 *   - a material counted in packs gets its bag weight, where the pack weight
 *     is printed in its own name ("Acidomix (20kg)") and none is set. The gate
 *     weighs kilos and the mill consumes kilos; without a bag weight neither can
 *     book a kilo against an item counted in packs, and both refuse by name.
 *
 * Opening stock is left alone: it comes from a physical count, later.
 *
 * Idempotent. Run it again after the Zoho item load on production.
 *
 *   npx tsx scripts/track-raw-materials.ts            (what would change)
 *   npx tsx scripts/track-raw-materials.ts --apply    (change it)
 */
import { and, eq, sql } from "drizzle-orm";
import { accounts, items } from "@shared/schema";
import { db, pool } from "../server/db";
import { stockUnitsPerKg } from "../server/services/inventory";

const APPLY = process.argv.includes("--apply");

/** "Acidomix (20kg)" → 20. Only a weight printed in the name, in kilos. */
function packKgFromName(name: string): number | null {
  const m = name.match(/\(\s*(\d+(?:\.\d+)?)\s*kg\s*\)/i);
  return m ? Number(m[1]) : null;
}

async function main() {
  const [feedStock] = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.code, "1073"), eq(accounts.isActive, true)));
  if (!feedStock) throw new Error("No active account 1073 (Feed Stock) — nothing to capitalise raw material to");

  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      unit: items.unit,
      unitBagWeightKg: items.unitBagWeightKg,
      tracked: items.trackInventory,
      inventoryAccountId: items.inventoryAccountId,
    })
    .from(items)
    .where(sql`${items.category}::text = 'feed'`)
    .orderBy(items.name);

  console.log(`\n  ${rows.length} raw material(s) in the Feed category; stock account ${feedStock.code} ${feedStock.name}\n`);
  const plan = rows.map((r) => {
    const track = !r.tracked;
    const account = !r.inventoryAccountId;
    const needsBag = stockUnitsPerKg(r) == null;
    const bag = needsBag ? packKgFromName(r.name) : null;
    return { r, track, account, needsBag, bag };
  });

  for (const p of plan) {
    const what = [
      p.track ? "track stock" : null,
      p.account ? `stock account ${feedStock.code}` : null,
      p.bag != null ? `bag weight ${p.bag} kg (from its name)` : null,
      p.needsBag && p.bag == null ? `NO BAG WEIGHT — counted in ${p.r.unit}, none in its name; set it by hand` : null,
    ].filter(Boolean);
    console.log(`  ${p.r.name.padEnd(34)} ${what.length ? what.join(", ") : "already set"}`);
  }

  const changes = plan.filter((p) => p.track || p.account || p.bag != null);
  if (!APPLY) {
    console.log(`\n  ${changes.length} to change. Dry run — nothing written. Re-run with --apply.\n`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const p of changes) {
      await tx
        .update(items)
        .set({
          trackInventory: true,
          ...(p.account ? { inventoryAccountId: feedStock.id } : {}),
          ...(p.bag != null ? { unitBagWeightKg: p.bag.toFixed(3) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(items.id, p.r.id));
    }
  });
  console.log(`\n  Written: ${changes.length} item(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
