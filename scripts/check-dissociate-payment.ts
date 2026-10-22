/**
 * Checks Zoho's "Delete Recorded Payment?" from an invoice and a bill —
 * Dissociate & Add As Credit, and Delete Payment — against the real database,
 * then rolls back.
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
import { dissociatePayment } from "../server/services/apply-credits";
import { deleteCustomerPayment } from "../server/routes/sales";
import { deleteVendorPayment } from "../server/routes/purchases";

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
      await refuses("matched payment still cannot be deleted", () => deleteCustomerPayment(tx, p1.id), "matched to a bank statement line");

      const gone = await deleteCustomerPayment(tx, p2.id);
      const invEnd = (await tx.select().from(invoices).where(eq(invoices.id, inv!.id)))[0]!;
      check("Delete Payment reopens the invoice", gone.invoicesReopened.includes(inv!.number));
      check("invoice owed in full, sent", invEnd.balanceDue === "1000.00" && invEnd.status === "sent", `${invEnd.balanceDue} ${invEnd.status}`);

      // Deleting P1 later takes its dissociation journal with it.
      await tx.delete(bankTransactionLinks).where(eq(bankTransactionLinks.bankTransactionId, line!.id));
      await deleteCustomerPayment(tx, p1.id);
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
      const gv = await deleteVendorPayment(tx, own.id);
      check("Delete Payment on a dissociated payment reopens nothing", gv.billsReopened.length === 0, JSON.stringify(gv));

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
