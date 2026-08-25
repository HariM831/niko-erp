/**
 * Restate historical egg stock movements at the agreed valuation.
 *
 * Egg stock is valued at the benchmark in force on the movement's date plus
 * ₹0.50 an egg (see `eggStockRatePerBoxP`). The code now writes that on every
 * new movement, but rows written before the fix carry the old figures: boxes
 * graded IN at ₹0.00 and boxes invoiced OUT at their selling price, which is
 * what drove on-hand value negative while quantity stayed positive.
 *
 * This rewrites `inventory_transactions.value` for egg items so every row is
 * quantity × the rate for its own date, and sets each egg item's
 * `opening_stock_rate` to the same valuation. Quantities are never touched —
 * the count was always right, only the money was wrong.
 *
 * Opening stock matters as much as the movements: an egg item opening at
 * ₹0.00 a box still reads as worth nothing, and where later movements are net
 * negative that alone drives on-hand value below zero.
 *
 * Dry by default; pass --commit to write. Run against a restored copy first.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { eggStockRatePerBoxP } from "../server/services/egg-sales";

async function main() {
  const commit = process.argv.includes("--commit");
  // The valuation an opening balance is carried at. The org's migration date
  // is when those boxes came on the books, so that is the rate they take.
  const [org] = (
    await db.execute(sql`SELECT migration_date::text AS d FROM org_profile LIMIT 1`)
  ).rows as Array<{ d: string | null }>;
  const openingDate = org?.d ?? new Date().toISOString().slice(0, 10);
  const openingRateP = await eggStockRatePerBoxP(db, openingDate);
  console.log(
    `Opening stock valued as at ${openingDate}: ₹${(openingRateP / 100).toFixed(2)} a box.\n`,
  );

  const rows = (
    await db.execute(sql`
      SELECT t.id, t.transaction_date::text AS on_date, t.quantity::text AS qty,
             t.value::text AS val, t.source_type, i.name AS item
      FROM inventory_transactions t
      JOIN items i ON i.id = t.item_id
      JOIN egg_size_items e ON e.item_id = i.id
      ORDER BY t.transaction_date, i.name
    `)
  ).rows as Array<{
    id: string;
    on_date: string;
    qty: string;
    val: string;
    source_type: string;
    item: string;
  }>;

  if (!rows.length) {
    console.log("No egg stock movements found — nothing to restate.");
    await pool.end();
    return;
  }

  // One rate lookup per distinct date rather than per row.
  const rateByDate = new Map<string, number>();
  for (const r of rows) {
    if (!rateByDate.has(r.on_date)) {
      rateByDate.set(r.on_date, await eggStockRatePerBoxP(db, r.on_date));
    }
  }

  let changed = 0;
  let deltaP = 0;
  const updates: Array<{ id: string; value: string }> = [];

  for (const r of rows) {
    const rateP = rateByDate.get(r.on_date)!;
    const wantP = Math.round(Number(r.qty) * rateP);
    const haveP = Math.round(Number(r.val) * 100);
    if (wantP === haveP) continue;
    changed++;
    deltaP += wantP - haveP;
    updates.push({ id: r.id, value: (wantP / 100).toFixed(2) });
    console.log(
      `  ${r.on_date}  ${r.item.padEnd(16)} ${r.source_type.padEnd(20)} ` +
        `qty ${r.qty.padStart(10)}   ₹${(haveP / 100).toFixed(2).padStart(12)} → ₹${(wantP / 100).toFixed(2).padStart(12)}`,
    );
  }

  console.log(
    `\n${rows.length} egg movements examined, ${changed} to restate, ` +
      `net value change ₹${(deltaP / 100).toFixed(2)}.`,
  );

  // Opening balances, which the movements above sit on top of.
  const openings = (
    await db.execute(sql`
      SELECT i.id, i.name, i.opening_stock::text AS qty, i.opening_stock_rate::text AS rate
      FROM items i
      JOIN egg_size_items e ON e.item_id = i.id
      WHERE i.opening_stock <> 0
      ORDER BY i.name
    `)
  ).rows as Array<{ id: string; name: string; qty: string; rate: string }>;

  const openingFixes = openings.filter(
    (o) => Math.round(Number(o.rate) * 100) !== openingRateP,
  );
  if (openingFixes.length) {
    console.log("\nOpening stock rates to restate:");
    for (const o of openingFixes) {
      console.log(
        `  ${o.name.padEnd(16)} ${o.qty.padStart(10)} boxes @ ₹${Number(o.rate).toFixed(2)} → ₹${(openingRateP / 100).toFixed(2)}`,
      );
    }
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const u of updates) {
      await tx.execute(sql`
        UPDATE inventory_transactions SET value = ${u.value}::numeric WHERE id = ${u.id}::uuid
      `);
    }
    for (const o of openingFixes) {
      await tx.execute(sql`
        UPDATE items SET opening_stock_rate = ${(openingRateP / 100).toFixed(2)}::numeric
        WHERE id = ${o.id}::uuid
      `);
    }
  });
  console.log(
    `\nRestated ${updates.length} movements and ${openingFixes.length} opening rates.`,
  );
  await pool.end();
}

main();
