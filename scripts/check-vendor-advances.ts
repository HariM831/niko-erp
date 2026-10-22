/**
 * Checks advances against a purchase order and paying a bank batch
 * (docs/vendor-advances-and-batches-plan.md): request, send, Mark paid, the
 * order's bill taking the advance, deleting a payment the batch recorded, and
 * an older niko payment coming across to Vendor Advances on edit. At every step
 * the ledger must say what the documents say. Against the real database, then
 * rolled back.
 *
 * Every contact, account, order, bill and payment it touches is made here,
 * inside the transaction, with made-up names and numbers.
 *
 * Run: npx tsx scripts/check-vendor-advances.ts
 */
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  bills,
  contacts,
  expenses,
  paymentBatchLines,
  paymentBatches,
  purchaseOrders,
  users,
  vendorAdvanceRequests,
  vendorPayments,
} from "@shared/schema";
import { db, type Tx } from "../server/db";
import { PostingError, postJournal } from "../server/services/posting";
import { applyCredits } from "../server/services/apply-credits";
import { listPayables } from "../server/services/payment-file";
import { cancelAdvanceRequest, createAdvanceRequest } from "../server/services/vendor-advances";
import {
  createPaymentBatch,
  createVendorPayment,
  deleteVendorPayment,
  deleteVendorRefund,
  editVendorPayment,
  markBatchPaid,
  refundVendorPayment,
} from "../server/routes/purchases";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};
const refuses = async (name: string, fn: () => Promise<unknown>, needle: string) => {
  try {
    await fn();
    check(name, false, "was allowed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, err instanceof PostingError && msg.includes(needle), msg);
  }
};

class Rollback extends Error {}

/** Debit less credit on a system account, over the journals one document owns. */
async function moved(tx: Tx, key: string, sourceId: string): Promise<number> {
  const r = await tx.execute(sql`
    SELECT coalesce(sum(l.debit - l.credit), 0)::float8 AS v
      FROM journal_entry_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN accounts a ON a.id = l.account_id
     WHERE a.system_key = ${key} AND e.source_id = ${sourceId}`);
  return Number((r.rows[0] as { v: number }).v);
}

async function main() {
  const [actor] = await db.select({ id: users.id }).from(users).limit(1);
  if (!actor) throw new Error("No user to attribute the documents to");

  await db
    .transaction(async (tx) => {
      const tag = `ZA${Date.now() % 100000}`;
      const day = "2026-10-20";
      const [gl] = await tx
        .insert(accounts)
        .values({ code: `${tag}B`, name: `Check ${tag}B`, type: "asset", subtype: "bank" as never })
        .returning({ id: accounts.id });
      const [cost] = await tx
        .insert(accounts)
        .values({ code: `${tag}E`, name: `Check ${tag}E`, type: "expense", subtype: "expense" as never })
        .returning({ id: accounts.id });
      const [bank] = await tx
        .insert(bankAccounts)
        .values({ name: `${tag} Bank`, glAccountId: gl!.id, accountNumber: "99887766", ifsc: "SBIN0000001" })
        .returning();
      const [vendor] = await tx
        .insert(contacts)
        .values({
          type: "vendor",
          displayName: `${tag} Suppliers`,
          bankBeneficiaryName: `${tag} SUPPLIERS`,
          bankAccountNumber: "123456789",
          bankIfsc: "HDFC0000001",
          bankName: "HDFC Bank",
        })
        .returning();
      const [po] = await tx
        .insert(purchaseOrders)
        .values({ number: `${tag}-PO`, vendorId: vendor!.id, status: "issued", orderDate: day, total: "1000.00", createdBy: actor.id })
        .returning();
      const [draft] = await tx
        .insert(purchaseOrders)
        .values({ number: `${tag}-PD`, vendorId: vendor!.id, status: "draft", orderDate: day, total: "500.00", createdBy: actor.id })
        .returning();
      /** A bill as Record Bill leaves it: open, and payables credited. */
      const bill = async (n: string, total: string, purchaseOrderId?: string) => {
        const [b] = await tx
          .insert(bills)
          .values({ number: `${tag}-${n}`, vendorId: vendor!.id, status: "open", billDate: day, dueDate: day, total, balanceDue: total, purchaseOrderId, createdBy: actor.id } as never)
          .returning();
        await postJournal(tx, {
          entryDate: day,
          narration: tag,
          sourceType: "bill",
          sourceId: b!.id,
          postedBy: actor.id,
          lines: [{ accountId: cost!.id, debit: total }, { systemKey: "ap", credit: total }] as never,
        });
        return b!;
      };

      console.log("Advance request");
      await refuses("a draft order cannot take an advance", () =>
        createAdvanceRequest(tx, { purchaseOrderId: draft!.id, amount: "100.00" }, actor.id), "still a draft");
      const req = await createAdvanceRequest(
        tx,
        { purchaseOrderId: po!.id, amount: "400.00", proformaNumber: `${tag}-PF1`, proformaDate: day },
        actor.id,
      );
      check("request is open, on the order's vendor", req.status === "open" && req.vendorId === vendor!.id);
      await refuses("nor more than the order is worth", () =>
        createAdvanceRequest(tx, { purchaseOrderId: po!.id, amount: "700.00" }, actor.id), "at most 600.00 more");
      const spare = await createAdvanceRequest(tx, { purchaseOrderId: po!.id, amount: "50.00" }, actor.id);
      await cancelAdvanceRequest(tx, spare.id, "not needed", actor.id);
      const spareAfter = (await tx.select().from(vendorAdvanceRequests).where(eq(vendorAdvanceRequests.id, spare.id)))[0]!;
      check("an unsent request can be cancelled, and is kept", spareAfter.status === "cancelled" && spareAfter.cancelReason === "not needed");

      const open = await listPayables(tx, { vendorId: vendor!.id });
      const advRow = open.find((r) => r.kind === "advance");
      check("the advance is on the sheet with its order and proforma",
        advRow?.id === req.id && advRow.purchaseOrderNumber === po!.number && advRow.billNumber === `${tag}-PF1`,
        JSON.stringify(advRow));
      check("the cancelled one is not", !open.some((r) => r.id === spare.id));

      console.log("Send to bank");
      const other = await bill("B2", "250.00");
      const [exp] = await tx
        .insert(expenses)
        .values({ number: `${tag}-E1`, expenseDate: day, expenseAccountId: cost!.id, vendorId: vendor!.id, amount: "80.00", createdBy: actor.id })
        .returning();
      const expJe = await postJournal(tx, {
        entryDate: day,
        narration: tag,
        sourceType: "expense",
        sourceId: exp!.id,
        postedBy: actor.id,
        lines: [{ accountId: cost!.id, debit: "80.00" }, { systemKey: "ap", credit: "80.00" }] as never,
      });
      await tx.update(expenses).set({ journalEntryId: expJe }).where(eq(expenses.id, exp!.id));
      await refuses("an advance cannot go in part", () =>
        createPaymentBatch(tx, { bankAccountId: bank!.id, batchDate: day, items: [{ kind: "advance", id: req.id, amount: "100.00" }] }, actor.id),
        "no more than the outstanding");
      const batch = await createPaymentBatch(
        tx,
        {
          bankAccountId: bank!.id,
          batchDate: day,
          items: [
            { kind: "advance", id: req.id },
            { kind: "bill", id: other.id },
            { kind: "expense", id: exp!.id },
          ],
        },
        actor.id,
      );
      check("a batch of three, 730", batch.lineCount === 3 && batch.total === "730.00", JSON.stringify(batch));
      const lines = await tx.select().from(paymentBatchLines).where(eq(paymentBatchLines.batchId, batch.id));
      const advLine = lines.find((l) => l.advanceRequestId === req.id);
      check("the advance's remark is its proforma", advLine?.remarks === `${tag}-PF1`, advLine?.remarks ?? "");
      const after = await listPayables(tx, { vendorId: vendor!.id });
      check("sent documents leave the sheet", after.length === 0, after.map((r) => r.number).join(", "));
      await refuses("an advance in a live batch cannot be cancelled", () =>
        cancelAdvanceRequest(tx, req.id, "x", actor.id), "cancel that transfer");
      check("sending posts nothing", (await moved(tx, "ap", other.id)) === -250);

      console.log("Mark paid");
      const paid = await markBatchPaid(tx, batch.id, {}, actor.id);
      check("three recorded, two payments", paid.recorded === 3 && paid.payments.length === 2, JSON.stringify(paid));
      const reqPaid = (await tx.select().from(vendorAdvanceRequests).where(eq(vendorAdvanceRequests.id, req.id)))[0]!;
      check("the request is paid, with its payment", reqPaid.status === "paid" && !!reqPaid.vendorPaymentId);
      const advPay = (await tx.select().from(vendorPayments).where(eq(vendorPayments.id, reqPaid.vendorPaymentId!)))[0]!;
      check("the advance payment is all unapplied, in advances",
        advPay.unappliedAmount === "400.00" && advPay.advancesInLedger && advPay.paymentDate === day,
        `${advPay.unappliedAmount} ${advPay.advancesInLedger} ${advPay.paymentDate}`);
      check("vendor advances +400, payables untouched",
        (await moved(tx, "vendor_advances", advPay.id)) === 400 && (await moved(tx, "ap", advPay.id)) === 0);
      const otherPaid = (await tx.select().from(bills).where(eq(bills.id, other.id)))[0]!;
      check("the bill is paid", otherPaid.status === "paid" && otherPaid.balanceDue === "0.00", `${otherPaid.status} ${otherPaid.balanceDue}`);
      const expPaid = (await tx.select().from(expenses).where(eq(expenses.id, exp!.id)))[0]!;
      check("the expense is paid from the batch's bank", expPaid.paidThroughId === bank!.id && expPaid.dueDate === null);
      check("the expense's payable is gone", (await moved(tx, "ap", exp!.id)) === 0, String(await moved(tx, "ap", exp!.id)));
      const b = (await tx.select().from(paymentBatches).where(eq(paymentBatches.id, batch.id)))[0]!;
      check("the batch is paid on its value date", !!b.paidAt && b.paidOn === day);
      await refuses("twice is refused", () => markBatchPaid(tx, batch.id, {}, actor.id), "already marked paid");

      console.log("The order's bill takes the advance");
      const main = await bill("B1", "1000.00", po!.id);
      await applyCredits(tx, "vendor", main.id, [{ kind: "advance", id: advPay.id, amount: "400.00" }], actor.id);
      const mainAfter = (await tx.select().from(bills).where(eq(bills.id, main.id)))[0]!;
      check("bill owes 600", mainAfter.balanceDue === "600.00" && mainAfter.status === "partially_paid", `${mainAfter.balanceDue} ${mainAfter.status}`);
      check("advance moved from vendor advances to payables",
        (await moved(tx, "vendor_advances", advPay.id)) === 0 && (await moved(tx, "ap", advPay.id)) === 400);

      console.log("Deleting a payment the batch recorded");
      const otherPayId = lines.find((l) => l.billId === other.id)!.id;
      const otherLine = (await tx.select().from(paymentBatchLines).where(eq(paymentBatchLines.id, otherPayId)))[0]!;
      await deleteVendorPayment(tx, otherLine.vendorPaymentId!, actor.id);
      const lineAgain = (await tx.select().from(paymentBatchLines).where(eq(paymentBatchLines.id, otherPayId)))[0]!;
      const batchAgain = (await tx.select().from(paymentBatches).where(eq(paymentBatches.id, batch.id)))[0]!;
      check("its transfer is waiting again", lineAgain.recordedAt === null && lineAgain.vendorPaymentId === null);
      check("and so is the batch", batchAgain.paidAt === null);
      const again = await markBatchPaid(tx, batch.id, {}, actor.id);
      check("Mark paid again records only that one", again.recorded === 1, JSON.stringify(again));

      console.log("An older niko payment");
      const [old] = await tx
        .insert(vendorPayments)
        .values({ number: `${tag}-OLD`, vendorId: vendor!.id, paymentDate: day, amount: "100.00", unappliedAmount: "100.00", bankAccountId: bank!.id, createdBy: actor.id })
        .returning();
      const oldJe = await postJournal(tx, {
        entryDate: day,
        narration: tag,
        sourceType: "vendor_payment",
        sourceId: old!.id,
        postedBy: actor.id,
        lines: [{ systemKey: "ap", debit: "100.00" }, { accountId: gl!.id, credit: "100.00" }] as never,
      });
      await tx.update(vendorPayments).set({ journalEntryId: oldJe }).where(eq(vendorPayments.id, old!.id));
      await applyCredits(tx, "vendor", main.id, [{ kind: "advance", id: old!.id, amount: "60.00" }], actor.id);
      check("applying it moves nothing — its advance was inside payables",
        (await moved(tx, "ap", old!.id)) === 100 && (await moved(tx, "vendor_advances", old!.id)) === 0);
      await editVendorPayment(tx, old!.id, { notes: "edited" }, actor.id);
      const oldAfter = (await tx.select().from(vendorPayments).where(eq(vendorPayments.id, old!.id)))[0]!;
      check("an edit brings it across", oldAfter.advancesInLedger && oldAfter.unappliedAmount === "40.00");
      check("payables 60, vendor advances 40",
        (await moved(tx, "ap", old!.id)) === 60 && (await moved(tx, "vendor_advances", old!.id)) === 40,
        `${await moved(tx, "ap", old!.id)} ${await moved(tx, "vendor_advances", old!.id)}`);

      console.log("A payment made by hand ahead of a bill");
      const ahead = await createVendorPayment(
        tx,
        { vendorId: vendor!.id, paymentDate: day, amount: "300.00", bankAccountId: bank!.id, applications: [{ billId: main.id, amount: "100.00" }] },
        actor.id,
      );
      check("payables 100, vendor advances 200",
        (await moved(tx, "ap", ahead.id)) === 100 && (await moved(tx, "vendor_advances", ahead.id)) === 200);

      console.log("The vendor refunds part of it");
      await refuses("not more than is spare", () =>
        refundVendorPayment(tx, ahead.id, { refundDate: day, amount: "250.00", bankAccountId: bank!.id }, actor.id), "only 200.00 spare");
      const refund = await refundVendorPayment(tx, ahead.id, { refundDate: day, amount: "150.00", bankAccountId: bank!.id }, actor.id);
      const afterRefund = (await tx.select().from(vendorPayments).where(eq(vendorPayments.id, ahead.id)))[0]!;
      check("50 left spare", afterRefund.unappliedAmount === "50.00", afterRefund.unappliedAmount);
      check("vendor advances 50, the bank back 150",
        (await moved(tx, "vendor_advances", ahead.id)) === 50, String(await moved(tx, "vendor_advances", ahead.id)));
      await refuses("the payment cannot be deleted under a refund", () => deleteVendorPayment(tx, ahead.id, actor.id), "has refunds");
      await refuses("nor edited to apply refunded money", () =>
        // In its own savepoint, as a refused request rolls back whole in the app.
        tx.transaction((sp) => editVendorPayment(sp, ahead.id, { applications: [{ billId: main.id, amount: "200.00" }] }, actor.id)),
        "after 150.00 refunded");
      await editVendorPayment(tx, ahead.id, { notes: "edited" }, actor.id);
      const edited = (await tx.select().from(vendorPayments).where(eq(vendorPayments.id, ahead.id)))[0]!;
      check("an edit keeps the refund off", edited.unappliedAmount === "50.00" && (await moved(tx, "vendor_advances", ahead.id)) === 50,
        `${edited.unappliedAmount} ${await moved(tx, "vendor_advances", ahead.id)}`);
      await deleteVendorRefund(tx, refund.id);
      const back = (await tx.select().from(vendorPayments).where(eq(vendorPayments.id, ahead.id)))[0]!;
      check("deleting the refund puts 200 back", back.unappliedAmount === "200.00" && (await moved(tx, "vendor_advances", ahead.id)) === 200);

      throw new Rollback();
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed (rolled back)");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
