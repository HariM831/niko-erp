/**
 * The vendor's tax is part of what the goods cost, and a wrong settlement can
 * be undone.
 *
 * Two things that cost real money on one truck.
 *
 * The tax first. We claim no GST input, so what the vendor charges is what the
 * material cost: settlement bills the all-in figure and posts it to the
 * purchase account, with no tax line anywhere. On the G K load that is
 * ₹1,08,974.95 on ₹21,79,499 — bill the goods alone and the payable is short
 * by more than a lakh, which is what happened to GR-00001 because the gate
 * never captured the printed tax.
 *
 * Then the undo. "Settled" is terminal, and should be, but the freeze belongs
 * to the bill rather than to a flag: void the bill and the truck is back at
 * gated-out-unpaid, ready to be settled again on the right figures.
 *
 * Rolled back; nothing survives.
 *
 * Run: npx tsx scripts/check-settlement-tax.ts
 */
import { eq, sql } from "drizzle-orm";
import { bills, contacts, items, procurementReceipts } from "@shared/schema";
import { db } from "../server/db";
import { createBill, loadVendor } from "../server/services/purchases";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

class Rollback extends Error {}

// The real bill, read off the paper stored against GR-00001.
const QTY = 43330;
const GOODS = 2179499;
const IGST = 108974.95;
const WITH_TAX = 2288474; // the vendor's printed "Net Amount (With Tax)", incl. 0.05 roundoff

try {
  await db.transaction(async (tx) => {
    console.log("\n  THE ALL-IN RATE\n");

    // What settlementContext does: spread the printed tax across the lines by
    // value, and bill the result.
    const taxShare = IGST; // single line, so it takes all of it
    const allIn = (GOODS + taxShare) / QTY;
    check("goods alone understate the payable", GOODS < WITH_TAX, `${inr(GOODS)} vs ${inr(WITH_TAX)}`);
    check(
      "the all-in rate carries the tax",
      Math.abs(allIn - 52.815) < 0.001,
      `${inr(GOODS + taxShare)} ÷ ${QTY.toLocaleString("en-IN")} kg = ₹${allIn.toFixed(4)}/kg`,
    );
    check(
      "it ties to the vendor's printed total",
      Math.abs(allIn * QTY - WITH_TAX) < 1,
      `within a rupee of ${inr(WITH_TAX)} — the rest is their roundoff`,
    );
    // The shortage comes off at the same all-in rate: we do not pay the tax on
    // kilos that never arrived either.
    const shortKg = 150;
    check(
      "a shortage is deducted at the all-in rate too",
      Math.abs(shortKg * allIn - 7922.25) < 0.02,
      `${shortKg} kg × ₹${allIn.toFixed(3)} = ${inr(shortKg * allIn)}`,
    );

    console.log("\n  VOIDING THE BILL REOPENS THE TRUCK\n");

    const [acct] = (
      await tx.execute(sql`SELECT id FROM accounts WHERE type = 'expense' LIMIT 1`)
    ).rows as Array<{ id: string }>;
    const [user] = (await tx.execute(sql`SELECT id FROM users LIMIT 1`)).rows as Array<{ id: string }>;
    const [loc] = (await tx.execute(sql`SELECT id FROM locations LIMIT 1`)).rows as Array<{ id: string }>;

    const [vendor] = await tx
      .insert(contacts)
      .values({ displayName: "TEST TAX VENDOR", type: "vendor" })
      .returning();
    const [item] = await tx
      .insert(items)
      .values({ name: "TEST TAX MATERIAL", unit: "kg", isSold: false, purchaseAccountId: acct!.id, category: "feed" })
      .returning();

    const vend = await loadVendor(tx, vendor!.id);
    const bill = await createBill(tx, {
      vendor: vend,
      billDate: "2026-08-18",
      reference: "TEST-GR",
      lines: [
        { itemId: item!.id, accountId: acct!.id, name: item!.name, quantity: String(QTY), unit: "kg", rate: allIn.toFixed(6) },
      ],
      postedBy: user!.id,
    });
    check("the bill posts at the all-in figure", Math.abs(Number(bill.total) - WITH_TAX) < 1, inr(Number(bill.total)));

    const [receipt] = await tx
      .insert(procurementReceipts)
      .values({
        number: "TEST-GR-TAX",
        locationId: loc!.id,
        vendorId: vendor!.id,
        vehicleNumber: "TESTTAX01",
        status: "settled",
        billId: bill.id,
        settledAt: new Date(),
        settledBy: user!.id,
        gateInBy: user!.id,
        arrivalAt: new Date(),
      })
      .returning();
    check("the truck starts settled", receipt!.status === "settled", `bill ${bill.number}`);

    // What the void handler does, in the same order.
    await tx.update(bills).set({ status: "void", balanceDue: "0.00" }).where(eq(bills.id, bill.id));
    const reopened = await tx
      .update(procurementReceipts)
      .set({ status: "gate_out", billId: null, settledAt: null, settledBy: null })
      .where(eq(procurementReceipts.billId, bill.id))
      .returning();

    check("voiding reopens exactly this truck", reopened.length === 1, reopened[0]?.number ?? "—");
    const [after] = await tx.select().from(procurementReceipts).where(eq(procurementReceipts.id, receipt!.id));
    check("it is gated out and unpaid again", after!.status === "gate_out");
    check("it no longer points at the void bill", after!.billId === null);
    check("and carries no settlement stamp", after!.settledAt === null && after!.settledBy === null);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const strays = await db
  .select({ id: procurementReceipts.id })
  .from(procurementReceipts)
  .where(eq(procurementReceipts.number, "TEST-GR-TAX"));
check("nothing survives the run", strays.length === 0);

console.log(failed === 0 ? "\n  All settlement-tax checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
