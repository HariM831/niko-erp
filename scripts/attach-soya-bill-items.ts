/**
 * Name the material on three soya purchases that were billed without one.
 *
 * Three ~42 tonne loads came in as description-only lines against Feed &
 * Additives, so they existed in the ledger and nowhere in the item history —
 * which is why Soybean Meal read as a material that had never been bought,
 * and why a costing would have fallen back on a year-old spreadsheet figure.
 *
 * Which is which is settled by the price, not by the wording. On 10 August
 * hi-pro cost ₹70.50; the two Feedkart loads a fortnight later cost ₹60.50,
 * and that ₹10 is the gap between 50% protein and 46%. The user confirmed two
 * vehicles of the 46% on 18 Sep 2026.
 *
 * No accounting moves. A bill line posts by its ACCOUNT, and every account,
 * amount, quantity and date here is left exactly as it was; only the material
 * the line refers to is filled in. Neither item carries a stock movement, so
 * there is no inventory to disturb either.
 *
 * Each line is matched on its bill number AND its description AND the fact
 * that it still has no item, so a second run does nothing and a line somebody
 * has since corrected is left alone.
 *
 *   npx tsx scripts/attach-soya-bill-items.ts
 *   npx tsx scripts/attach-soya-bill-items.ts --write
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { billLines, bills, items } from "@shared/schema";
import { db, pool } from "../server/db";

const write = process.argv.includes("--write");

const ATTACH: Array<{ bill: string; description: string; item: string; why: string }> = [
  { bill: "BILL-001936", description: "Hypro Soya", item: "Soya Hipro (DOC)", why: "₹70.50, the hi-pro price that week" },
  { bill: "BILL-002015", description: "Normal Soya DOC", item: "Soybean Meal", why: "₹60.50 — 'normal', not hi-pro" },
  { bill: "BILL-002061", description: "Soybean Meal", item: "Soybean Meal", why: "₹60.50, and named outright" },
];

async function main() {
  console.log(`\n  Naming the material on three soya bills — ${write ? "WRITING" : "dry run"}\n`);
  let done = 0;
  const planned: Array<{ id: string; itemId: string; label: string }> = [];

  for (const a of ATTACH) {
    const [item] = await db.select({ id: items.id }).from(items).where(eq(items.name, a.item));
    if (!item) { console.log(`  ! no item called ${a.item}`); continue; }
    const rows = await db
      .select({ id: billLines.id, qty: billLines.quantity, rate: billLines.rate, itemId: billLines.itemId, date: bills.billDate })
      .from(billLines)
      .innerJoin(bills, eq(bills.id, billLines.billId))
      .where(and(eq(bills.number, a.bill), sql`${billLines.description} ILIKE ${"%" + a.description + "%"}`));
    if (!rows.length) { console.log(`  ! ${a.bill}: no line describing "${a.description}"`); continue; }
    if (rows.length > 1) { console.log(`  ! ${a.bill}: ${rows.length} lines match "${a.description}" — left alone`); continue; }
    const line = rows[0]!;
    if (line.itemId) { console.log(`  = ${a.bill} already names a material; left alone`); done++; continue; }
    console.log(`  ${a.bill}  ${line.date}  ${Math.round(Number(line.qty)).toLocaleString("en-IN")} kg at ₹${Number(line.rate).toFixed(2)}  ->  ${a.item}`);
    console.log(`      ${a.why}`);
    planned.push({ id: line.id, itemId: item.id, label: a.bill });
  }

  if (!write) {
    console.log(`\n  ${planned.length} line(s) would be named. Dry run — nothing written.\n`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const p of planned) {
      // Still without a material at the moment of writing, not merely when it
      // was read: nothing of anybody else's gets overwritten.
      const r = await tx.update(billLines).set({ itemId: p.itemId })
        .where(and(eq(billLines.id, p.id), isNull(billLines.itemId))).returning({ id: billLines.id });
      if (r.length) done++;
    }
  });
  console.log(`\n  Named ${done} line(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
