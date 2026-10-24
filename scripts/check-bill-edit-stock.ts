/**
 * Editing a bill's quantity moves Stock on Hand with it — then rolls back.
 *
 * Mixiblend premix was billed as 5,000 kg, corrected on the bill to 1,250
 * packets, and Stock on Hand still read 5,000: the edit re-posted the journal
 * but never touched the bill's stock rows (24 Oct 2026). This walks the same
 * steps the edit route takes — the bill as it stood, the bill as edited,
 * restateBillStock between them — on an item made inside the transaction.
 *
 * Run: npx tsx scripts/check-bill-edit-stock.ts
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { accounts, contacts, inventoryTransactions, items, officeReceipts, users } from "@shared/schema";
import { db } from "../server/db";
import { advanceSeriesPast } from "../server/lib/numbering";
import { computeBill, createBill, loadVendor, restateBillStock } from "../server/services/purchases";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};

class Rollback extends Error {}

async function main() {
  const [vendor] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(inArray(contacts.type, ["vendor", "both"]), eq(contacts.isActive, true)))
    .limit(1);
  if (!vendor) throw new Error("No active vendor in the database to test against");
  const [stockAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.type, "asset"), eq(accounts.isActive, true), eq(accounts.isGroup, false)))
    .limit(1);
  if (!stockAccount) throw new Error("No postable asset account found");
  const [actor] = await db.select({ id: users.id }).from(users).limit(1);
  if (!actor) throw new Error("No user to attribute the documents to");

  try {
    await db.transaction(async (tx) => {
      // A database whose bill counter trails bills loaded directly would hand
      // createBill a number already taken. Moved past them here, rolled back.
      const [{ top }] = (await tx.execute(
        sql`SELECT coalesce(max(substring(number from '[0-9]+$')::int), 0) AS top FROM bills WHERE number ~ '^BILL-[0-9]+$'`,
      )).rows as Array<{ top: number }>;
      await advanceSeriesPast(tx, "bill", "BILL-", Number(top) + 1);

      const [item] = await tx
        .insert(items)
        .values({ name: "Zt Premix fixture", unit: "pcs", trackInventory: true, inventoryAccountId: stockAccount.id })
        .returning();
      const v = await loadVendor(tx, vendor.id);
      const line = (quantity: string, rate: string) => ({ itemId: item!.id, name: "Zt Premix fixture", quantity, rate });

      const stockOf = async (billId: string) => {
        const rows = await tx
          .select({ q: inventoryTransactions.quantity, v: inventoryTransactions.value, d: inventoryTransactions.transactionDate })
          .from(inventoryTransactions)
          .where(and(eq(inventoryTransactions.sourceType, "bill"), eq(inventoryTransactions.sourceId, billId)));
        return {
          qty: rows.reduce((s, r) => s + Number(r.q), 0),
          valueP: rows.reduce((s, r) => s + Math.round(Number(r.v) * 100), 0),
          dates: [...new Set(rows.map((r) => r.d))],
        };
      };

      // Keyed wrong: 5,000 at ₹169.75, arrived three days after the bill date.
      const bill = await createBill(tx, {
        vendor: v,
        billDate: "2026-09-25",
        stockDate: "2026-09-28",
        lines: [line("5000", "169.75")],
        postedBy: actor.id,
      });
      const first = await stockOf(bill.id);
      check("bill puts its quantity into stock", first.qty === 5000, String(first.qty));

      // Corrected: 1,250 packets at ₹679 — the same money, a quarter the count.
      const before = await computeBill(tx, v, [line("5000", "169.75")], "0", undefined, "0");
      const after = await computeBill(tx, v, [line("1250", "679")], "0", undefined, "0");
      await restateBillStock(tx, bill.id, before, after);
      const edited = await stockOf(bill.id);
      check("edit brings stock to the new quantity", edited.qty === 1250, String(edited.qty));
      check("value unchanged when the money is", edited.valueP === first.valueP, `${edited.valueP} vs ${first.valueP}`);
      check("difference lands on the arrival day", edited.dates.length === 1 && edited.dates[0] === "2026-09-28", edited.dates.join(","));

      // A price change alone moves the value, not the count.
      const repriced = await computeBill(tx, v, [line("1250", "680")], "0", undefined, "0");
      await restateBillStock(tx, bill.id, after, repriced);
      const r = await stockOf(bill.id);
      check("repricing keeps the count", r.qty === 1250, String(r.qty));
      check("repricing moves the value by the difference", r.valueP - edited.valueP === 125000, String(r.valueP - edited.valueP));

      // A gate-settled bill's stock is the weighed net: an edit leaves it alone.
      const [receipt] = await tx.select({ id: officeReceipts.id }).from(officeReceipts).limit(1);
      if (receipt) {
        const gate = await createBill(tx, {
          vendor: v,
          billDate: "2026-09-25",
          lines: [line("100", "10")],
          postedBy: actor.id,
        });
        await tx.update(officeReceipts).set({ billId: gate.id }).where(eq(officeReceipts.id, receipt.id));
        await restateBillStock(
          tx,
          gate.id,
          await computeBill(tx, v, [line("100", "10")], "0", undefined, "0"),
          await computeBill(tx, v, [line("80", "10")], "0", undefined, "0"),
        );
        check("gate-settled bill keeps its stock", (await stockOf(gate.id)).qty === 100);
      }

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(failed ? `\n${failed} failed` : "\nall passed (rolled back)");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
