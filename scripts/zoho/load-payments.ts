/**
 * Phase 3: money in and money out, with what each payment was applied to.
 *
 *   npx tsx scripts/zoho/load-payments.ts             # say what would happen
 *   npx tsx scripts/zoho/load-payments.ts --commit    # do it
 *
 * Last, because a payment names the invoices and bills it settles and those
 * have to exist first. 896 receipts against 1,007 invoices, 1,895 payments
 * against 2,018 bills.
 *
 * Not every payment is applied to something. 36 receipts sit entirely
 * unapplied and 18 partly so — customer advances, which post to their own
 * account rather than reducing a receivable that does not exist yet. 210
 * vendor payments are likewise unapplied. Those are real balances, not
 * missing data, so they are carried rather than forced onto a document.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import {
  bankAccounts,
  bills,
  customerPayments,
  invoices,
  paymentApplications,
  users,
  vendorPaymentApplications,
  vendorPayments,
  zohoIdMap,
} from "@shared/schema";
import { db, pool } from "../../server/db";
import { postJournal } from "../../server/services/posting";

interface ZohoCustomerPayment {
  payment_id: string;
  payment_number: string;
  customer_id: string;
  date: string;
  amount: number;
  unused_amount?: number;
  payment_mode?: string;
  account_id: string;
  reference_number?: string;
  description?: string;
  invoices?: Array<{ invoice_id: string; amount_applied: number }>;
}

interface ZohoVendorPayment {
  payment_id: string;
  payment_number: string;
  vendor_id: string;
  date: string;
  amount: number;
  payment_mode?: string;
  paid_through_account_id: string;
  reference_number?: string;
  description?: string;
  tax_amount_withheld?: number;
  bills?: Array<{ bill_id: string; amount_applied: number }>;
}

/** Zoho writes the mode as a label; EGGSY stores an enum. */
const MODE: Record<string, "cash" | "bank_transfer" | "upi" | "cheque" | "card"> = {
  Cash: "cash",
  "Bank Transfer": "bank_transfer",
  "Bank Remittance": "bank_transfer",
  UPI: "upi",
  Cheque: "cheque",
  // Zoho's US spelling of the same instrument.
  Check: "cheque",
  Card: "card",
  "Credit Card": "card",
};

const money = (n: number | undefined) => (n ?? 0).toFixed(2);
const paise = (n: number | undefined) => Math.round((n ?? 0) * 100);

async function main() {
  const commit = process.argv.includes("--commit");
  const read = async <T>(f: string): Promise<T[]> =>
    (await readFile(`.zoho-dump/detail/${f}.jsonl`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  const receipts = (await read<ZohoCustomerPayment>("customerpayments")).sort(
    (a, b) => a.date.localeCompare(b.date) || a.payment_id.localeCompare(b.payment_id),
  );
  const payouts = (await read<ZohoVendorPayment>("vendorpayments")).sort(
    (a, b) => a.date.localeCompare(b.date) || a.payment_id.localeCompare(b.payment_id),
  );

  const idsOf = async (entity: string) =>
    new Map(
      (
        await db
          .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
          .from(zohoIdMap)
          .where(eq(zohoIdMap.entity, entity))
      ).map((r) => [r.zohoId, r.eggsyId]),
    );
  const contactFor = await idsOf("contact");
  const bankFor = await idsOf("bank_account");
  const invoiceFor = await idsOf("invoice");
  const billFor = await idsOf("bill");
  const doneIn = await idsOf("customer_payment");
  const doneOut = await idsOf("vendor_payment");

  const glOfBank = new Map(
    (
      await db.select({ id: bankAccounts.id, glAccountId: bankAccounts.glAccountId }).from(bankAccounts)
    ).map((b) => [b.id, b.glAccountId]),
  );

  const todoIn = receipts.filter((p) => !doneIn.has(p.payment_id));
  const todoOut = payouts.filter((p) => !doneOut.has(p.payment_id));

  const problems: string[] = [];
  for (const p of todoIn) {
    if (!contactFor.has(p.customer_id)) problems.push(`${p.payment_number}: customer not imported`);
    if (!bankFor.has(p.account_id)) problems.push(`${p.payment_number}: deposit bank not imported`);
    if (p.payment_mode && !MODE[p.payment_mode]) {
      problems.push(`${p.payment_number}: unknown mode "${p.payment_mode}"`);
    }
    const applied = (p.invoices ?? []).reduce((s, a) => s + paise(a.amount_applied), 0);
    if (applied > paise(p.amount)) {
      problems.push(`${p.payment_number}: applies more than it is worth`);
    }
    for (const a of p.invoices ?? []) {
      if (!invoiceFor.has(a.invoice_id)) {
        problems.push(`${p.payment_number}: applied to invoice ${a.invoice_id}, which is not imported`);
      }
    }
  }
  for (const p of todoOut) {
    if (!contactFor.has(p.vendor_id)) problems.push(`${p.payment_number}: vendor not imported`);
    if (!bankFor.has(p.paid_through_account_id)) {
      problems.push(`${p.payment_number}: paid-through bank not imported`);
    }
    if (p.payment_mode && !MODE[p.payment_mode]) {
      problems.push(`${p.payment_number}: unknown mode "${p.payment_mode}"`);
    }
    for (const a of p.bills ?? []) {
      if (!billFor.has(a.bill_id)) {
        problems.push(`${p.payment_number}: applied to bill ${a.bill_id}, which is not imported`);
      }
    }
  }
  if (problems.length) {
    throw new Error(
      `Cannot import — ${problems.length} problem(s):\n  ${problems.slice(0, 15).join("\n  ")}`,
    );
  }

  const unappliedIn = todoIn.filter(
    (p) => paise(p.amount) > (p.invoices ?? []).reduce((s, a) => s + paise(a.amount_applied), 0),
  );
  console.log(`Receipts: ${todoIn.length} to import (${doneIn.size} done)`);
  console.log(`  value ${todoIn.reduce((s, p) => s + Number(p.amount), 0).toLocaleString("en-IN")}`);
  console.log(`  applications ${todoIn.reduce((s, p) => s + (p.invoices?.length ?? 0), 0)}`);
  console.log(`  carrying an unapplied balance ${unappliedIn.length}`);
  console.log(`Payments: ${todoOut.length} to import (${doneOut.size} done)`);
  console.log(`  value ${todoOut.reduce((s, p) => s + Number(p.amount), 0).toLocaleString("en-IN")}`);
  console.log(`  applications ${todoOut.reduce((s, p) => s + (p.bills?.length ?? 0), 0)}`);
  console.log(`  unapplied ${todoOut.filter((p) => !(p.bills ?? []).length).length}`);

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("No user to attribute the import to");

  await db.transaction(async (tx) => {
    for (const p of todoIn) {
      const bankId = bankFor.get(p.account_id)!;
      const appliedP = (p.invoices ?? []).reduce((s, a) => s + paise(a.amount_applied), 0);
      const unappliedP = paise(p.amount) - appliedP;

      const [row] = await tx
        .insert(customerPayments)
        .values({
          number: p.payment_number,
          customerId: contactFor.get(p.customer_id)!,
          paymentDate: p.date,
          amount: money(p.amount),
          unappliedAmount: (unappliedP / 100).toFixed(2),
          mode: MODE[p.payment_mode ?? ""] ?? "bank_transfer",
          reference: p.reference_number?.trim() || null,
          bankAccountId: bankId,
          notes: p.description?.trim() || null,
          createdBy: admin.id,
        })
        .returning({ id: customerPayments.id });

      for (const a of p.invoices ?? []) {
        if (paise(a.amount_applied) === 0) continue;
        await tx.insert(paymentApplications).values({
          paymentId: row!.id,
          invoiceId: invoiceFor.get(a.invoice_id)!,
          amountApplied: money(a.amount_applied),
        });
      }

      // DR bank; CR receivable for what it settles, customer advances for the
      // rest — the same split the application makes.
      const lines: Array<Record<string, string | undefined>> = [
        { accountId: glOfBank.get(bankId)!, debit: money(p.amount), description: `Payment ${p.payment_number}` },
      ];
      if (appliedP > 0) lines.push({ systemKey: "ar", credit: (appliedP / 100).toFixed(2) });
      if (unappliedP > 0) {
        lines.push({ systemKey: "customer_advances", credit: (unappliedP / 100).toFixed(2) });
      }

      const jeId = await postJournal(tx, {
        entryDate: p.date,
        narration: `Payment ${p.payment_number}`,
        reference: p.reference_number?.trim() || undefined,
        sourceType: "customer_payment",
        sourceId: row!.id,
        postedBy: admin.id,
        lines: lines as never,
      });
      await tx
        .update(customerPayments)
        .set({ journalEntryId: jeId })
        .where(eq(customerPayments.id, row!.id));

      await tx.insert(zohoIdMap).values({
        entity: "customer_payment",
        zohoId: p.payment_id,
        eggsyId: row!.id,
        label: p.payment_number,
      });
    }

    for (const p of todoOut) {
      const bankId = bankFor.get(p.paid_through_account_id)!;
      const appliedP = (p.bills ?? []).reduce((s, a) => s + paise(a.amount_applied), 0);
      const tdsP = paise(p.tax_amount_withheld);

      const [row] = await tx
        .insert(vendorPayments)
        .values({
          number: p.payment_number,
          vendorId: contactFor.get(p.vendor_id)!,
          paymentDate: p.date,
          amount: money(p.amount),
          unappliedAmount: ((paise(p.amount) - appliedP) / 100).toFixed(2),
          mode: MODE[p.payment_mode ?? ""] ?? "bank_transfer",
          reference: p.reference_number?.trim() || null,
          bankAccountId: bankId,
          tdsAmount: money(p.tax_amount_withheld),
          notes: p.description?.trim() || null,
          createdBy: admin.id,
        })
        .returning({ id: vendorPayments.id });

      for (const a of p.bills ?? []) {
        if (paise(a.amount_applied) === 0) continue;
        await tx.insert(vendorPaymentApplications).values({
          paymentId: row!.id,
          billId: billFor.get(a.bill_id)!,
          amountApplied: money(a.amount_applied),
        });
      }

      // DR the payable for what this settles and Advance to Suppliers for what
      // it does not, exactly as the customer side splits between receivable and
      // unearned revenue. Debiting the whole amount to the payable understated
      // it by the 1.31 crore paid ahead of any bill, and left 136 vendors
      // reading as overpaid.
      const unappliedP = paise(p.amount) - appliedP;
      const lines: Array<Record<string, string | undefined>> = [];
      if (appliedP > 0) {
        lines.push({
          systemKey: "ap",
          debit: (appliedP / 100).toFixed(2),
          description: `Payment ${p.payment_number}`,
        });
      }
      if (unappliedP > 0) {
        lines.push({
          systemKey: "vendor_advances",
          debit: (unappliedP / 100).toFixed(2),
          description: `Payment ${p.payment_number} — on account`,
        });
      }
      lines.push({
        accountId: glOfBank.get(bankId)!,
        credit: ((paise(p.amount) - tdsP) / 100).toFixed(2),
      });
      if (tdsP > 0) lines.push({ systemKey: "tds_payable", credit: (tdsP / 100).toFixed(2) });

      const jeId = await postJournal(tx, {
        entryDate: p.date,
        narration: `Payment ${p.payment_number}`,
        reference: p.reference_number?.trim() || undefined,
        sourceType: "vendor_payment",
        sourceId: row!.id,
        postedBy: admin.id,
        lines: lines as never,
      });
      await tx
        .update(vendorPayments)
        .set({ journalEntryId: jeId })
        .where(eq(vendorPayments.id, row!.id));

      await tx.insert(zohoIdMap).values({
        entity: "vendor_payment",
        zohoId: p.payment_id,
        eggsyId: row!.id,
        label: p.payment_number,
      });
    }
  });

  console.log(`\nCommitted ${todoIn.length} receipts and ${todoOut.length} payments, all posted.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
