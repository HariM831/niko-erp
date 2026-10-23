/**
 * Freight agreed on a PO, paid to the transporter by us (22 Oct 2026).
 *
 * What has to hold:
 *   - a truck settled against a per-ton order owes rate × the vendor's billed
 *     tonnes, debited to the material's own stock account and credited to
 *     Freight Payable, on the day the truck arrived;
 *   - the vendor's bill is untouched by it — the freight is not theirs;
 *   - stock goes in at goods + freight, and Feed Stock agrees with it, while
 *     Goods in Transit carries the goods alone and is clear once arrived;
 *   - the bill line's landed cost includes the freight, for the formulator;
 *   - a payment clears the truck out of a bank account; the bill cannot be
 *     voided while its freight is paid; deleting the payment owes it again;
 *   - voiding the bill reverses the freight and leaves Freight Payable clear;
 *   - a lump sum is split across the truck's materials by value, and per ton
 *     refuses a line with no kilos.
 *
 * Every row it needs is made here, inside one transaction that is rolled back:
 * vendor, materials, accounts, bank account, order and truck. Nothing of the
 * database's own is changed. Only a location and a user are looked up, to
 * point the fixtures at.
 *
 * Run: npx tsx scripts/check-po-freight.ts
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  billLines,
  contacts,
  freightCharges,
  inventoryTransactions,
  items,
  officeReceiptLines,
  officeReceipts,
  purchaseOrderLines,
  purchaseOrders,
} from "@shared/schema";
import { db, pool } from "../server/db";
import { settleReceipt } from "../server/routes/office";
import { voidBill } from "../server/routes/purchases";
import { deleteFreightPayment, payFreight, planFreight } from "../server/services/freight";
import { istDate } from "../server/services/day-resolution";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`);
};
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;
class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const [user] = (await tx.execute(sql`SELECT id FROM users ORDER BY created_at LIMIT 1`)).rows as Array<{ id: string }>;
    const [location] = (await tx.execute(sql`SELECT id FROM locations ORDER BY created_at LIMIT 1`)).rows as Array<{ id: string }>;
    const [payable] = await tx.select().from(accounts).where(eq(accounts.systemKey, "freight_payable"));
    if (!payable) throw new Error("No freight_payable account — migration 0134 has not run");
    const userId = user!.id;

    // ── Fixtures ──
    const [stockAcct] = await tx
      .insert(accounts)
      .values({ code: "FXF-STK", name: "FX Freight Stock", type: "asset", subtype: "stock" })
      .returning();
    const [expAcct] = await tx
      .insert(accounts)
      .values({ code: "FXF-EXP", name: "FX Freight Supplies", type: "expense", subtype: "expense" })
      .returning();
    const [bankGl] = await tx
      .insert(accounts)
      .values({ code: "FXF-BNK", name: "FX Freight Bank", type: "asset", subtype: "bank" })
      .returning();
    const [bank] = await tx
      .insert(bankAccounts)
      .values({ name: "FX Freight Bank", glAccountId: bankGl!.id } as typeof bankAccounts.$inferInsert)
      .returning();
    const [vendor] = await tx
      .insert(contacts)
      .values({ type: "vendor", displayName: "FX Soya Traders" } as typeof contacts.$inferInsert)
      .returning();
    const [soya] = await tx
      .insert(items)
      .values({
        name: "FX Soybean Meal",
        unit: "kg",
        trackInventory: true,
        inventoryAccountId: stockAcct!.id,
        purchaseAccountId: expAcct!.id,
      } as typeof items.$inferInsert)
      .returning();
    const [pallet] = await tx
      .insert(items)
      .values({ name: "FX Pallet", unit: "pcs", trackInventory: false, purchaseAccountId: expAcct!.id } as typeof items.$inferInsert)
      .returning();

    const arrived = istDate();
    const vendorDate = new Date(Date.parse(`${arrived}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        number: "FX-PO-FRT-1",
        vendorId: vendor!.id,
        status: "issued",
        orderDate: vendorDate,
        freightBasis: "per_ton",
        freightRate: "5700",
        createdBy: userId,
      } as typeof purchaseOrders.$inferInsert)
      .returning();
    const [poLine] = await tx
      .insert(purchaseOrderLines)
      .values({ purchaseOrderId: po!.id, itemId: soya!.id, name: "FX Soybean Meal", quantity: "20000", unit: "kg", rate: "40", amount: "800000" })
      .returning();

    const [receipt] = await tx
      .insert(officeReceipts)
      .values({
        number: "FX-GR-FRT-1",
        status: "gate_out",
        locationId: location!.id,
        vendorId: vendor!.id,
        vendorBillNumber: "FX-INV-1",
        vendorBillDate: vendorDate,
        vehicleNumber: "AS12FX0001",
        arrivalAt: new Date(`${arrived}T06:00:00Z`),
      } as typeof officeReceipts.$inferInsert)
      .returning();
    await tx.insert(officeReceiptLines).values({
      receiptId: receipt!.id,
      lineNo: 1,
      status: "unloaded",
      purchaseOrderId: po!.id,
      poLineId: poLine!.id,
      itemId: soya!.id,
      itemName: "FX Soybean Meal",
      billQuantityKg: "20000",
      agreedRatePerKg: "40",
      billAmount: "800000",
      allocatedNetKg: "19950",
    } as typeof officeReceiptLines.$inferInsert);

    // Net on an account from every entry, optionally only before the arrival day.
    const netOn = async (accountId: string, before = false) =>
      Number(
        (
          (
            await tx.execute(sql`
              SELECT coalesce(sum(jl.debit - jl.credit), 0) AS net FROM journal_entry_lines jl
                JOIN journal_entries je ON je.id = jl.entry_id
               WHERE jl.account_id = ${accountId}
                 ${before ? sql`AND je.entry_date < ${arrived}` : sql``}`)
          ).rows[0] as { net: string }
        ).net,
      );
    const payableBefore = await netOn(payable.id);

    // ── Settle the truck ──
    console.log("\n  Per ton: 20 t billed at ₹5,700/t\n");
    const { bill } = await settleReceipt(tx, receipt!.id, {}, userId);
    const charges = await tx.select().from(freightCharges).where(eq(freightCharges.billId, bill.id));
    check("one freight charge for the truck", charges.length === 1, `${charges.length}`);
    const charge = charges[0]!;
    check("rate × the vendor's billed tonnes", near(Number(charge.amount), 114000), `₹${charge.amount}`);
    check("dated the day the truck arrived", charge.chargeDate === arrived, charge.chargeDate);
    check("carries the truck's number", charge.vehicleNumber === "AS12FX0001", charge.vehicleNumber ?? "—");
    check("the vendor's bill is the goods alone", near(Number(bill.total), 800000), `₹${bill.total}`);
    const payableAfter = await netOn(payable.id);
    check("Freight Payable owes the transporter", near(payableAfter - payableBefore, -114000), `₹${(payableBefore - payableAfter).toFixed(2)}`);

    const moves = await tx
      .select()
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.sourceType, "bill"), eq(inventoryTransactions.sourceId, bill.id)));
    const moveValue = moves.reduce((s, m) => s + Number(m.value ?? 0), 0);
    check("stock goes in at goods + freight", near(moveValue, 914000), `₹${moveValue.toFixed(2)}`);
    const onStock = await netOn(stockAcct!.id);
    check("the stock account agrees with the stock value", near(onStock, moveValue), `₹${onStock.toFixed(2)}`);
    const stockEarly = await netOn(stockAcct!.id, true);
    check("nothing on the stock account before the truck arrived", near(stockEarly, 0), `₹${stockEarly.toFixed(2)}`);
    const [git] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.systemKey, "goods_in_transit"));
    const transitEarly = Number(
      (
        (
          await tx.execute(sql`
            SELECT coalesce(sum(jl.debit - jl.credit), 0) AS net FROM journal_entry_lines jl
              JOIN journal_entries je ON je.id = jl.entry_id
             WHERE jl.account_id = ${git!.id} AND je.source_id = ${bill.id} AND je.entry_date < ${arrived}`)
        ).rows[0] as { net: string }
      ).net,
    );
    check("Goods in Transit carries the goods alone meanwhile", near(transitEarly, 800000), `₹${transitEarly.toFixed(2)}`);

    const [line] = await tx.select().from(billLines).where(and(eq(billLines.billId, bill.id), eq(billLines.itemId, soya!.id)));
    check("the bill line's landed cost includes the freight", near(Number(line!.landedUnitCost), 45.7), `₹${line!.landedUnitCost}/kg`);
    check("and its allocated freight is the charge", near(Number(line!.allocatedFreight), 114000), `₹${line!.allocatedFreight}`);

    // ── Pay it ──
    const payment = await payFreight(tx, {
      chargeIds: [charge.id],
      paymentDate: arrived,
      bankAccountId: bank!.id,
      transporter: "FX Roadways",
      userId,
    });
    check("a payment for the truck's freight", near(Number(payment.amount), 114000), `${payment.number} ₹${payment.amount}`);
    check("Freight Payable is clear once paid", near(await netOn(payable.id), payableBefore), `₹${(await netOn(payable.id)).toFixed(2)}`);
    check("the money left the bank account", near(await netOn(bankGl!.id), -114000), `₹${(await netOn(bankGl!.id)).toFixed(2)}`);
    let twice = "";
    try {
      await tx.transaction((sp) => payFreight(sp, { chargeIds: [charge.id], paymentDate: arrived, bankAccountId: bank!.id, userId }));
    } catch (e) {
      twice = e instanceof Error ? e.message : String(e);
    }
    check("a truck cannot be paid twice", twice.includes("already paid"), twice.slice(0, 70));
    let voidRefused = "";
    try {
      await tx.transaction((sp) => voidBill(sp, bill.id, arrived, userId));
    } catch (e) {
      voidRefused = e instanceof Error ? e.message : String(e);
    }
    check("the bill cannot be voided while its freight is paid", voidRefused.includes(payment.number), voidRefused.slice(0, 70));

    await deleteFreightPayment(tx, payment.id, userId);
    const [again] = await tx.select().from(freightCharges).where(eq(freightCharges.id, charge.id));
    check("deleting the payment owes the truck again", again!.freightPaymentId === null);
    check("and puts the money back in the bank", near(await netOn(bankGl!.id), 0), `₹${(await netOn(bankGl!.id)).toFixed(2)}`);

    // ── Void the bill ──
    await voidBill(tx, bill.id, arrived, userId);
    const live = await tx.select().from(freightCharges).where(and(eq(freightCharges.billId, bill.id), isNull(freightCharges.voidedAt)));
    check("voiding the bill voids its freight", live.length === 0);
    check("Freight Payable is back where it started", near(await netOn(payable.id), payableBefore), `₹${(await netOn(payable.id)).toFixed(2)}`);
    check("the stock account is clear", near(await netOn(stockAcct!.id), 0), `₹${(await netOn(stockAcct!.id)).toFixed(2)}`);

    // ── A lump sum, and the per-ton refusal ──
    console.log("\n  Lump sum and refusals\n");
    await tx.update(purchaseOrders).set({ freightBasis: "per_truck", freightRate: "68000" }).where(eq(purchaseOrders.id, po!.id));
    const [plan] = await planFreight(tx, [
      {
        purchaseOrderId: po!.id,
        lines: [
          { key: "a", itemId: pallet!.id, accountId: expAcct!.id, name: "FX Pallet", kg: null, value: 300000 },
          { key: "b", itemId: soya!.id, accountId: stockAcct!.id, name: "FX Soybean Meal", kg: 1000, value: 100000 },
        ],
      },
    ]);
    check("a lump sum is the agreed amount", plan?.amountP === 6800000, `₹${(plan!.amountP / 100).toFixed(2)}`);
    check(
      "split across the materials by value",
      plan!.lines[0]!.amountP === 5100000 && plan!.lines[1]!.amountP === 1700000,
      plan!.lines.map((l) => `₹${(l.amountP / 100).toFixed(2)}`).join(" + "),
    );
    await tx.update(purchaseOrders).set({ freightBasis: "per_ton", freightRate: "5700" }).where(eq(purchaseOrders.id, po!.id));
    let unweighed = "";
    try {
      await planFreight(tx, [
        { purchaseOrderId: po!.id, lines: [{ key: "a", itemId: pallet!.id, accountId: expAcct!.id, name: "FX Pallet", kg: null, value: 1 }] },
      ]);
    } catch (e) {
      unweighed = e instanceof Error ? e.message : String(e);
    }
    check("per ton refuses a line with no kilos", unweighed.includes("no kilos"), unweighed.slice(0, 70));
    await tx.update(purchaseOrders).set({ freightBasis: "none" }).where(eq(purchaseOrders.id, po!.id));
    const none = await planFreight(tx, [
      { purchaseOrderId: po!.id, lines: [{ key: "a", itemId: soya!.id, accountId: stockAcct!.id, name: "x", kg: 1000, value: 1 }] },
    ]);
    check("an order with no freight terms charges nothing", none.length === 0);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(`\n  ${e instanceof Error ? e.stack ?? e.message : e}\n`);
    failed++;
  }
} finally {
  await pool.end().catch(() => {});
}

console.log(failed === 0 ? "\n  All PO freight checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exitCode = failed ? 1 : 0;
