/**
 * Turn raw feed materials into inventory items.
 *
 * Gate In only increases stock for an item that TRACKS stock, so this is the
 * switch that makes the whole chain visible. Every raw material capitalises to
 * 1072 Inventory; the mill's own output already capitalises to 1073 Feed Stock,
 * which is what keeps "what we bought" and "what we made" apart on the balance
 * sheet.
 *
 * Deliberately not retrospective. Past bills expensed what they bought and
 * their journals are posted; turning tracking on does not reach back and
 * re-post them, so every item starts at zero and the first real count is an
 * opening balance somebody enters. Rewriting posted history to invent an
 * opening stock would be worse than starting from nothing.
 *
 * Idempotent: run it twice and the second run changes nothing.
 *
 * Run: npx tsx scripts/enable-raw-material-stock.ts
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { accounts, items } from "@shared/schema";
import { db } from "../server/db";

const [stock] = await db
  .select({ id: accounts.id, code: accounts.code, name: accounts.name })
  .from(accounts)
  .where(eq(accounts.code, "1072"));
if (!stock) throw new Error("No account 1072 — pick the raw material stock account first");

const before = await db
  .select({ id: items.id, name: items.name })
  .from(items)
  .where(
    and(
      eq(items.category, "feed"),
      eq(items.isActive, true),
      or(eq(items.trackInventory, false), isNull(items.inventoryAccountId)),
    ),
  );

console.log(`\n  ${before.length} raw material(s) to switch on, into ${stock.code} ${stock.name}\n`);
for (const i of before) console.log(`    ${i.name}`);

if (before.length) {
  await db
    .update(items)
    .set({ trackInventory: true, inventoryAccountId: stock.id, updatedAt: new Date() })
    .where(
      and(
        eq(items.category, "feed"),
        eq(items.isActive, true),
        or(eq(items.trackInventory, false), isNull(items.inventoryAccountId)),
      ),
    );
}

const after = await db.execute(sql`
  SELECT category, count(*)::int AS n, count(*) FILTER (WHERE track_inventory)::int AS tracked
  FROM items WHERE is_active GROUP BY category ORDER BY category`);
console.log("\n  AFTER\n");
for (const r of after.rows as Array<{ category: string; n: number; tracked: number }>) {
  console.log(`    ${(r.category ?? "—").padEnd(16)} ${r.tracked}/${r.n} tracked`);
}
console.log("");
process.exit(0);
