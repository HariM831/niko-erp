/**
 * Checks refunds on customer receipts (22 Oct 2026): a refund comes off what
 * the receipt has spare and out of customer advances, never touches
 * receivables, survives an edit, blocks a delete of the receipt, and goes back
 * when deleted. Against the real database, then rolled back; every row it
 * touches is made here.
 *
 * Run: npx tsx scripts/check-customer-refunds.ts
 */
import { eq, sql } from "drizzle-orm";
import { accounts, bankAccounts, contacts, customerPayments, invoices, paymentApplications, users } from "@shared/schema";
import { db, type Tx } from "../server/db";
import { PostingError, postJournal } from "../server/services/posting";
import { deleteCustomerPayment, deleteCustomerRefund, editCustomerPayment, refundCustomerPayment } from "../server/routes/sales";

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

async function moved(tx: Tx, key: string, sourceId: string): Promise<number> {
  const r = await tx.execute(sql`
    SELECT coalesce(sum(l.debit - l.credit), 0)::float8 AS v
      FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.system_key = ${key} AND e.source_id = ${sourceId}`);
  return Number((r.rows[0] as { v: number }).v);
}

async function main() {
  const [actor] = await db.select({ id: users.id }).from(users).limit(1);
  if (!actor) throw new Error("No user");
  await db
    .transaction(async (tx) => {
      const tag = `ZR${Date.now() % 100000}`;
      const day = "2026-10-20";
      const [gl] = await tx.insert(accounts).values({ code: `${tag}B`, name: `Check ${tag}B`, type: "asset", subtype: "bank" as never }).returning({ id: accounts.id });
      const [bank] = await tx.insert(bankAccounts).values({ name: `${tag} Bank`, glAccountId: gl!.id }).returning();
      const [customer] = await tx.insert(contacts).values({ type: "customer", displayName: `${tag} Traders` }).returning();
      const [inv] = await tx
        .insert(invoices)
        .values({ number: `${tag}-I1`, customerId: customer!.id, status: "partially_paid", invoiceDate: day, dueDate: day, total: "2000.00", balanceDue: "1600.00", createdBy: actor.id })
        .returning();
      const [p] = await tx
        .insert(customerPayments)
        .values({ number: `${tag}-P1`, customerId: customer!.id, paymentDate: day, amount: "1000.00", unappliedAmount: "600.00", bankAccountId: bank!.id, createdBy: actor.id })
        .returning();
      const je = await postJournal(tx, {
        entryDate: day, narration: tag, sourceType: "customer_payment", sourceId: p!.id, postedBy: actor.id,
        lines: [{ accountId: gl!.id, debit: "1000.00" }, { systemKey: "ar", credit: "400.00" }, { systemKey: "customer_advances", credit: "600.00" }] as never,
      });
      await tx.update(customerPayments).set({ journalEntryId: je }).where(eq(customerPayments.id, p!.id));
      await tx.insert(paymentApplications).values({ paymentId: p!.id, invoiceId: inv!.id, amountApplied: "400.00" });

      await refuses("not more than is spare", () =>
        refundCustomerPayment(tx, p!.id, { refundDate: day, amount: "700.00", bankAccountId: bank!.id }, actor.id), "only 600.00 spare");
      const refund = await refundCustomerPayment(tx, p!.id, { refundDate: day, amount: "250.00", bankAccountId: bank!.id }, actor.id);
      const after = (await tx.select().from(customerPayments).where(eq(customerPayments.id, p!.id)))[0]!;
      check("350 left spare", after.unappliedAmount === "350.00", after.unappliedAmount);
      check("customer advances 350, receivables untouched",
        (await moved(tx, "customer_advances", p!.id)) === -350 && (await moved(tx, "ar", p!.id)) === -400,
        `${await moved(tx, "customer_advances", p!.id)} ${await moved(tx, "ar", p!.id)}`);
      await refuses("the receipt cannot be deleted under a refund", () => deleteCustomerPayment(tx, p!.id, actor.id), "has refunds");
      await refuses("nor edited to apply refunded money", () =>
        tx.transaction((sp) => editCustomerPayment(sp, p!.id, { applications: [{ invoiceId: inv!.id, amount: "800.00" }] }, actor.id)),
        "after 250.00 refunded");
      await editCustomerPayment(tx, p!.id, { notes: "edited" }, actor.id);
      const edited = (await tx.select().from(customerPayments).where(eq(customerPayments.id, p!.id)))[0]!;
      check("an edit keeps the refund off", edited.unappliedAmount === "350.00" && (await moved(tx, "customer_advances", p!.id)) === -350,
        `${edited.unappliedAmount} ${await moved(tx, "customer_advances", p!.id)}`);
      await deleteCustomerRefund(tx, refund.id);
      const back = (await tx.select().from(customerPayments).where(eq(customerPayments.id, p!.id)))[0]!;
      check("deleting the refund puts 600 back", back.unappliedAmount === "600.00" && (await moved(tx, "customer_advances", p!.id)) === -600);
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
