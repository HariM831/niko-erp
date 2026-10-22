/**
 * Checks Zoho's "Delete Recorded Payment?" from an invoice and a bill —
 * Dissociate & Add As Credit, and Delete Payment — and the rule behind it
 * (services/payment-ledger.ts): whatever changes a payment's applications, in
 * whatever order, the ledger moves with the documents. Against the real
 * database, then rolled back.
 *
 * Every contact, document and payment it touches is made here, inside the
 * transaction, with made-up names and numbers.
 *
 * Run: npx tsx scripts/check-dissociate-payment.ts
 */
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  bankTransactionLinks,
  bankTransactions,
  bills,
  contacts,
  customerPayments,
  invoices,
  paymentApplications,
  users,
  vendorPaymentApplications,
  vendorPayments,
  zohoIdMap,
} from "@shared/schema";
import { db, type Tx } from "../server/db";
import { PostingError, postJournal } from "../server/services/posting";
import { linkStatementLine } from "../server/services/bank-links";
import { applyCredits, dissociatePayment } from "../server/services/apply-credits";
import { applyAdvancesToInvoice, unapplyInvoicePayments } from "../server/services/egg-sales";
import { deleteCustomerPayment, editCustomerPayment } from "../server/routes/sales";
import { deleteVendorPayment, editVendorPayment } from "../server/routes/purchases";

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
      const tag = `ZQ${Date.now() % 100000}`;
      const [gl] = await tx
        .insert(accounts)
        .values({ code: `${tag}B`, name: `Check ${tag}B`, type: "asset", subtype: "bank" as never })
        .returning({ id: accounts.id });
      const [bank] = await tx.insert(bankAccounts).values({ name: `${tag} Bank`, glAccountId: gl!.id }).returning();
      const day = "2026-10-20";

      console.log("Invoice");
      const [customer] = await tx.insert(contacts).values({ type: "customer", displayName: `${tag} Traders` }).returning();
      const [inv] = await tx
        .insert(invoices)
        .values({ number: `${tag}-I1`, customerId: customer!.id, status: "paid", invoiceDate: day, dueDate: day, total: "1000.00", balanceDue: "0.00", createdBy: actor.id })
        .returning();
      const receipt = async (n: string, amount: string) => {
        const [p] = await tx
          .insert(customerPayments)
          .values({ number: `${tag}-${n}`, customerId: customer!.id, paymentDate: day, amount, unappliedAmount: "0.00", bankAccountId: bank!.id, createdBy: actor.id })
          .returning();
        const je = await postJournal(tx, {
          entryDate: day,
          narration: tag,
          sourceType: "customer_payment",
          sourceId: p!.id,
          postedBy: actor.id,
          lines: [{ accountId: gl!.id, debit: amount }, { systemKey: "ar", credit: amount }] as never,
        });
        await tx.update(customerPayments).set({ journalEntryId: je }).where(eq(customerPayments.id, p!.id));
        await tx.insert(paymentApplications).values({ paymentId: p!.id, invoiceId: inv!.id, amountApplied: amount });
        return { ...p!, je };
      };
      const p1 = await receipt("P1", "600.00");
      const p2 = await receipt("P2", "400.00");
      // P1 is matched in Banking: dissociating leaves the bank alone, so it is allowed.
      const [line] = await tx
        .insert(bankTransactions)
        .values({ bankAccountId: bank!.id, txnDate: day, direction: "credit", amount: "600.00", description: tag })
        .returning();
      await linkStatementLine(tx, { bankTransactionId: line!.id, journalEntryIds: [p1.je], kind: "categorized" });

      const out = await dissociatePayment(tx, "customer", inv!.id, p1.id, actor.id);
      const invAfter = (await tx.select().from(invoices).where(eq(invoices.id, inv!.id)))[0]!;
      const p1After = (await tx.select().from(customerPayments).where(eq(customerPayments.id, p1.id)))[0]!;
      check("matched payment can still be dissociated", out.returned === "600.00", JSON.stringify(out));
      check("invoice owed again by 600", invAfter.balanceDue === "600.00", invAfter.balanceDue);
      check("still partly paid by P2", invAfter.status === "partially_paid", invAfter.status);
      check("P1 kept, 600 unapplied", p1After?.unappliedAmount === "600.00", p1After?.unappliedAmount);
      check("receivables back to nothing from P1", (await moved(tx, "ar", p1.id)) === 0, String(await moved(tx, "ar", p1.id)));
      check("customer advances holds 600", (await moved(tx, "customer_advances", p1.id)) === -600, String(await moved(tx, "customer_advances", p1.id)));
      await refuses("twice is refused", () => dissociatePayment(tx, "customer", inv!.id, p1.id, actor.id), "is not applied to");
      await refuses("matched payment still cannot be deleted", () => deleteCustomerPayment(tx, p1.id, actor.id), "matched to a bank statement line");

      const gone = await deleteCustomerPayment(tx, p2.id, actor.id);
      const invEnd = (await tx.select().from(invoices).where(eq(invoices.id, inv!.id)))[0]!;
      check("Delete Payment reopens the invoice", gone.invoicesReopened.includes(inv!.number));
      check("invoice owed in full, sent", invEnd.balanceDue === "1000.00" && invEnd.status === "sent", `${invEnd.balanceDue} ${invEnd.status}`);

      // Deleting P1 later takes its dissociation journal with it.
      await tx.delete(bankTransactionLinks).where(eq(bankTransactionLinks.bankTransactionId, line!.id));
      await deleteCustomerPayment(tx, p1.id, actor.id);
      check("deleting P1 leaves no ledger trace", (await moved(tx, "customer_advances", p1.id)) === 0 && (await moved(tx, "ar", p1.id)) === 0);

      console.log("Bill");
      const [vendor] = await tx.insert(contacts).values({ type: "vendor", displayName: `${tag} Suppliers` }).returning();
      const [bill] = await tx
        .insert(bills)
        .values({ number: `${tag}-B1`, vendorId: vendor!.id, status: "paid", billDate: day, dueDate: day, total: "1000.00", balanceDue: "0.00", createdBy: actor.id } as never)
        .returning();
      const payout = async (n: string, amount: string) => {
        const [p] = await tx
          .insert(vendorPayments)
          .values({ number: `${tag}-${n}`, vendorId: vendor!.id, paymentDate: day, amount, unappliedAmount: "0.00", bankAccountId: bank!.id, createdBy: actor.id })
          .returning();
        await tx.insert(vendorPaymentApplications).values({ paymentId: p!.id, billId: bill!.id, amountApplied: amount });
        return p!;
      };
      const own = await payout("V1", "700.00");
      const imported = await payout("V2", "300.00");
      await tx.insert(zohoIdMap).values({ entity: "vendor_payment", zohoId: `${tag}-zoho`, eggsyId: imported.id });
      // What migration 0131 set on every imported payment.
      await tx.update(vendorPayments).set({ advancesInLedger: true }).where(eq(vendorPayments.id, imported.id));

      await dissociatePayment(tx, "vendor", bill!.id, own.id, actor.id);
      const b1 = (await tx.select().from(bills).where(eq(bills.id, bill!.id)))[0]!;
      check("bill owed again by 700, partly paid", b1.balanceDue === "700.00" && b1.status === "partially_paid", `${b1.balanceDue} ${b1.status}`);
      check("niko's own payment posts nothing", (await moved(tx, "ap", own.id)) === 0);
      await dissociatePayment(tx, "vendor", bill!.id, imported.id, actor.id);
      const b2 = (await tx.select().from(bills).where(eq(bills.id, bill!.id)))[0]!;
      check("bill owed in full, open", b2.balanceDue === "1000.00" && b2.status === "open", `${b2.balanceDue} ${b2.status}`);
      const v2 = (await tx.select().from(vendorPayments).where(eq(vendorPayments.id, imported.id)))[0]!;
      check("imported payment 300 unapplied", v2.unappliedAmount === "300.00", v2.unappliedAmount);
      check("imported: vendor advances +300, payables -300",
        (await moved(tx, "vendor_advances", imported.id)) === 300 && (await moved(tx, "ap", imported.id)) === -300);
      const gv = await deleteVendorPayment(tx, own.id, actor.id);
      check("Delete Payment on a dissociated payment reopens nothing", gv.billsReopened.length === 0, JSON.stringify(gv));

      console.log("Any order: the ledger follows the documents");
      // Every journal the fixtures own, across receivables and customer
      // advances, must say what their documents say: no invoice journals are
      // posted here, so receivables nets to minus what is applied and
      // advances to minus what is unapplied.
      const owned: string[] = [];
      const ids = () => sql.join(owned.map((id) => sql`${id}::uuid`), sql`, `);
      const agree = async (name: string) => {
        const r = await tx.execute(sql`
          SELECT a.system_key AS k, coalesce(sum(l.debit - l.credit), 0)::float8 AS v
            FROM journal_entry_lines l
            JOIN journal_entries e ON e.id = l.entry_id
            JOIN accounts a ON a.id = l.account_id
           WHERE a.system_key IN ('ar', 'customer_advances') AND e.source_id IN (${ids()})
           GROUP BY a.system_key`);
        const led = Object.fromEntries((r.rows as Array<{ k: string; v: number }>).map((x) => [x.k, x.v]));
        const live = await tx.select().from(customerPayments).where(sql`${customerPayments.id} IN (${ids()})`);
        const unapplied = live.reduce((t, p) => t + Number(p.unappliedAmount), 0);
        const applied = live.reduce((t, p) => t + Number(p.amount) - Number(p.unappliedAmount), 0);
        const ar = led.ar ?? 0;
        const adv = led.customer_advances ?? 0;
        check(
          name,
          Math.abs(ar + applied) < 0.005 && Math.abs(adv + unapplied) < 0.005,
          `ledger ar ${ar} adv ${adv} · documents applied ${applied} unapplied ${unapplied}`,
        );
      };
      const sale = async (n: string, total: string) => {
        const [i] = await tx
          .insert(invoices)
          .values({ number: `${tag}-${n}`, customerId: customer!.id, status: "sent", invoiceDate: day, dueDate: day, total, balanceDue: total, createdBy: actor.id })
          .returning();
        owned.push(i!.id);
        return i!;
      };
      const advance = async (n: string, amount: string) => {
        const [p] = await tx
          .insert(customerPayments)
          .values({ number: `${tag}-${n}`, customerId: customer!.id, paymentDate: day, amount, unappliedAmount: amount, bankAccountId: bank!.id, createdBy: actor.id })
          .returning();
        const je = await postJournal(tx, {
          entryDate: day,
          narration: tag,
          sourceType: "customer_payment",
          sourceId: p!.id,
          postedBy: actor.id,
          lines: [{ accountId: gl!.id, debit: amount }, { systemKey: "customer_advances", credit: amount }] as never,
        });
        await tx.update(customerPayments).set({ journalEntryId: je }).where(eq(customerPayments.id, p!.id));
        owned.push(p!.id);
        return p!;
      };

      const r1 = await advance("R1", "1000.00");
      const i2 = await sale("I2", "1000.00");
      await applyCredits(tx, "customer", i2.id, [{ kind: "advance", id: r1.id, amount: "1000.00" }], actor.id);
      check("Apply Credits moves receivables, tied to the receipt", (await moved(tx, "ar", r1.id)) === -1000, String(await moved(tx, "ar", r1.id)));
      await agree("after Apply Credits");
      await editCustomerPayment(tx, r1.id, {}, actor.id);
      await agree("after editing it unchanged");
      await editCustomerPayment(tx, r1.id, { amount: "1200.00" }, actor.id);
      await agree("after raising its amount");
      await dissociatePayment(tx, "customer", i2.id, r1.id, actor.id);
      await editCustomerPayment(tx, r1.id, { amount: "1000.00" }, actor.id);
      await agree("after dissociating, then editing");

      // An entry the old way: against the invoice, not the receipt.
      const r2 = await advance("R2", "500.00");
      const i3 = await sale("I3", "500.00");
      await tx.insert(paymentApplications).values({ paymentId: r2.id, invoiceId: i3.id, amountApplied: "500.00" });
      await tx.update(customerPayments).set({ unappliedAmount: "0.00" }).where(eq(customerPayments.id, r2.id));
      await tx.update(invoices).set({ balanceDue: "0.00", status: "paid" }).where(eq(invoices.id, i3.id));
      await postJournal(tx, {
        entryDate: day,
        narration: tag,
        sourceType: "advance_application",
        sourceId: i3.id,
        postedBy: actor.id,
        lines: [{ systemKey: "customer_advances", debit: "500.00" }, { systemKey: "ar", credit: "500.00" }] as never,
      });
      await agree("old invoice-sourced entry");
      await editCustomerPayment(tx, r2.id, {}, actor.id);
      await agree("editing a receipt applied the old way");
      await deleteCustomerPayment(tx, r2.id, actor.id);
      await agree("deleting it");

      await applyCredits(tx, "customer", i2.id, [{ kind: "advance", id: r1.id, amount: "1000.00" }], actor.id);
      await unapplyInvoicePayments(tx, i2.id, day, actor.id);
      await agree("void path hands it back");
      const i4 = await sale("I4", "800.00");
      check("egg bay auto-apply takes 800", (await applyAdvancesToInvoice(tx, i4.id, actor.id)) === "800.00");
      check("auto-apply's entry is tied to the receipt", (await moved(tx, "ar", r1.id)) === -800, String(await moved(tx, "ar", r1.id)));
      await agree("after auto-apply");
      await deleteCustomerPayment(tx, r1.id, actor.id);
      await agree("deleting the receipt");
      const i4End = (await tx.select().from(invoices).where(eq(invoices.id, i4.id)))[0]!;
      check("its invoice owed again", i4End.balanceDue === "800.00", i4End.balanceDue);

      console.log("Imported vendor payment");
      const [v3] = await tx
        .insert(vendorPayments)
        .values({ number: `${tag}-V3`, vendorId: vendor!.id, paymentDate: day, amount: "500.00", unappliedAmount: "500.00", bankAccountId: bank!.id, advancesInLedger: true, createdBy: actor.id })
        .returning();
      await tx.insert(zohoIdMap).values({ entity: "vendor_payment", zohoId: `${tag}-zoho3`, eggsyId: v3!.id });
      const v3je = await postJournal(tx, {
        entryDate: day,
        narration: tag,
        sourceType: "vendor_payment",
        sourceId: v3!.id,
        postedBy: actor.id,
        lines: [{ systemKey: "vendor_advances", debit: "500.00" }, { accountId: gl!.id, credit: "500.00" }] as never,
      });
      await tx.update(vendorPayments).set({ journalEntryId: v3je }).where(eq(vendorPayments.id, v3!.id));
      const [bill2] = await tx
        .insert(bills)
        .values({ number: `${tag}-B2`, vendorId: vendor!.id, status: "open", billDate: day, dueDate: day, total: "500.00", balanceDue: "500.00", createdBy: actor.id } as never)
        .returning();
      const vAgree = async (name: string, unapplied: number) =>
        check(name, (await moved(tx, "vendor_advances", v3!.id)) === unapplied, String(await moved(tx, "vendor_advances", v3!.id)));
      await applyCredits(tx, "vendor", bill2!.id, [{ kind: "advance", id: v3!.id, amount: "500.00" }], actor.id);
      await vAgree("Apply Credits empties vendor advances", 0);
      await editVendorPayment(tx, v3!.id, {}, actor.id);
      await vAgree("still empty after an edit", 0);
      await editVendorPayment(tx, v3!.id, { amount: "600.00" }, actor.id);
      await vAgree("an edit adding 100 unapplied puts 100 there", 100);
      await deleteVendorPayment(tx, v3!.id, actor.id);
      await vAgree("deleting it leaves nothing in vendor advances", 0);

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
