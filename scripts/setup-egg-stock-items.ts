/**
 * Point each egg size at the item its stock lands in.
 *
 * Grading writes boxes into one pool per size, and `egg_size_items` is the
 * map that says which item each pool is. Without it the Egg stock screen
 * reads zero for everything, and a grading entry has nowhere to put what the
 * packing room counted.
 *
 * The row is reference data seeded by a migration, so a books reset takes it
 * and nothing puts it back — the same way egg_sales_preferences went.
 *
 * The mapping is to the item master that came from Zoho rather than to a
 * second set of egg items created here, so an egg is one item whether it is
 * being sold or counted. Dirty eggs are the exception: nobody invoices them,
 * so Zoho never had the item and it is created here.
 *
 * Sizes are matched to items by name, and every name is spelled out rather
 * than guessed at from a similarity score — "Egg's Large" and "Eggs — Large"
 * are the same egg, and no amount of string distance would tell you whether
 * "Eggs — Extra Large" is XL or jumbo. Somebody has to say.
 *
 *   npx tsx scripts/setup-egg-stock-items.ts            # report
 *   npx tsx scripts/setup-egg-stock-items.ts --write
 */
import { eq } from "drizzle-orm";
import { accounts, eggSizeItems, items } from "@shared/schema";
import { db, pool } from "../server/db";

/** size → the item name holding that pool. */
const MAP: Array<[size: string, itemName: string]> = [
  ["small", "Egg's Small"],
  ["medium", "Egg's Medium"],
  ["large", "Egg's Large"],
  ["xl", "Eggs — Extra Large"],
  ["jumbo", "Egg's Jumbo"],
  ["dirty", "Eggs — Dirty"],
];

/** Never invoiced, so Zoho has no such item; niko still has to count them. */
const CREATE = "Eggs — Dirty";

const SALES_ACCOUNT = "4009"; // Eggs (Sales)

async function main() {
  const write = process.argv.includes("--write");

  const [sales] = await db.select().from(accounts).where(eq(accounts.code, SALES_ACCOUNT));
  if (!sales) throw new Error(`No account ${SALES_ACCOUNT} — the egg sales account must exist first`);

  const all = await db.select().from(items);
  const byName = new Map(all.map((i) => [i.name, i]));

  const missing = MAP.filter(([, n]) => n !== CREATE && !byName.has(n)).map(([s, n]) => `${s} → ${n}`);
  if (missing.length) {
    console.log("No item by these names — fix the mapping rather than let it guess:");
    missing.forEach((m) => console.log(`  ${m}`));
    throw new Error("Unresolved egg size mapping");
  }

  const existing = await db.select().from(eggSizeItems);
  const mapped = new Set(existing.map((e) => e.size));

  console.log("Egg size → item");
  for (const [size, name] of MAP) {
    const item = byName.get(name);
    const state = mapped.has(size) ? "already mapped" : item ? "will map" : "will create + map";
    console.log(`  ${size.padEnd(7)} → ${name.padEnd(20)} ${state}`);
  }
  console.log(`\n  stock items are counted in boxes, tracked, and sell to ${sales.code} ${sales.name}`);

  if (!write) {
    console.log("\nReport only — nothing written. Re-run with --write.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const [size, name] of MAP) {
      let item = byName.get(name);
      if (!item) {
        const [row] = await tx
          .insert(items)
          .values({
            name,
            category: "eggs",
            unit: "boxes",
            trackInventory: true,
            isSold: true,
            salesAccountId: sales.id,
          })
          .returning();
        item = row!;
      } else {
        // Grading moves stock, which only happens for an item that tracks it.
        // The unit is boxes because that is what the packing room counts; a
        // pool measured in pieces would silently be 210x wrong.
        await tx
          .update(items)
          .set({
            trackInventory: true,
            unit: "boxes",
            category: "eggs",
            salesAccountId: item.salesAccountId ?? sales.id,
            updatedAt: new Date(),
          })
          .where(eq(items.id, item.id));
      }
      await tx
        .insert(eggSizeItems)
        .values({ size, itemId: item.id })
        .onConflictDoNothing();
    }
  });

  console.log(`\nMapped ${MAP.length} sizes.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  await pool.end();
  process.exit(1);
});
