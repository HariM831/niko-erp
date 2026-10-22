/**
 * Tie Zoho's two customer refunds to the receipts they came out of.
 *
 *   npx tsx scripts/link-customer-refunds.ts
 *   npx tsx scripts/link-customer-refunds.ts --commit
 *
 * Zoho's "Payment Refund" came across as loose manual journals — DR customer
 * advances, CR the bank — so the receipts still showed the money as spare
 * (customer advances sat Rs 31 lakh below them; traced 22 Oct 2026), and the
 * egg bay could apply Zakir's refunded Rs 3 lakh to a new invoice.
 *
 * The pairing is the user's, decided 22 Oct 2026, not worked out here:
 *   JE-09585  Zakir Egg Store, Rs 3,00,000, 22 Apr 2026  →  CP-2026-27/106 (16 Apr, Rs 3,00,000 unused)
 *
 * Luit Valley's Rs 28 lakh (JE-09546, 30 Mar 2026) is left as it is: the user
 * said not to touch Luit Valley. The group is settled as one net figure.
 *
 * Each becomes a customer_payment_refunds row, the receipt's unapplied amount
 * comes down by it, and the journal is re-sourced to the receipt. No amount in
 * the ledger moves. Refuses the whole run if a pairing no longer fits.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const PAIRS = [
  { entry: "JE-09585", customer: "Zakir Egg Store", receipt: "CP-2026-27/106" },
];

async function main() {
  const plans: Array<{ je: string; jeId: string; date: string; amount: string; ref: string | null; by: string; bank: string | null; receiptId: string; receipt: string; spare: string }> = [];
  for (const p of PAIRS) {
    const [je] = (
      await db.execute(sql`
        SELECT e.id::text, e.entry_date::text AS date, e.reference, e.posted_by::text AS by, e.source_type, l.debit::text AS amount,
               (SELECT b.id::text FROM journal_entry_lines l2 JOIN bank_accounts b ON b.gl_account_id = l2.account_id
                 WHERE l2.entry_id = e.id AND l2.id <> l.id LIMIT 1) AS bank,
               EXISTS (SELECT 1 FROM customer_payment_refunds r WHERE r.journal_entry_id = e.id) AS done
          FROM journal_entries e
          JOIN journal_entry_lines l ON l.entry_id = e.id
          JOIN accounts a ON a.id = l.account_id
         WHERE e.entry_number = ${p.entry} AND a.system_key = 'customer_advances' AND l.debit > 0`)
    ).rows as Array<{ id: string; date: string; reference: string | null; by: string; source_type: string; amount: string; bank: string | null; done: boolean }>;
    if (!je) throw new Error(`${p.entry}: no refund on customer advances`);
    if (je.done) { console.log(`  ${p.entry} is already tied — skipped`); continue; }
    const [rc] = (
      await db.execute(sql`
        SELECT p.id::text, p.number, p.payment_date::text AS date, p.unapplied_amount::text AS spare
          FROM customer_payments p JOIN contacts c ON c.id = p.customer_id
         WHERE p.number = ${p.receipt} AND c.display_name = ${p.customer}`)
    ).rows as Array<{ id: string; number: string; date: string; spare: string }>;
    if (!rc) throw new Error(`${p.receipt}: no receipt of ${p.customer} by that number`);
    if (Number(rc.spare) < Number(je.amount)) throw new Error(`${rc.number} has only ${rc.spare} spare for ${je.amount}`);
    if (rc.date > je.date) throw new Error(`${rc.number} (${rc.date}) is after the refund (${je.date})`);
    plans.push({ je: p.entry, jeId: je.id, date: je.date, amount: je.amount, ref: je.reference, by: je.by, bank: je.bank, receiptId: rc.id, receipt: rc.number, spare: rc.spare });
  }

  console.log(`\n  Zoho customer refunds tied to their receipts — ${COMMIT ? "WRITING" : "dry run"}\n`);
  for (const p of plans) {
    console.log(`  ${p.date}  ${p.je}  ${Number(p.amount).toLocaleString("en-IN")}  →  ${p.receipt}  (spare ${Number(p.spare).toLocaleString("en-IN")} → ${(Number(p.spare) - Number(p.amount)).toLocaleString("en-IN")})`);
  }
  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Add --commit to write.");
    await pool.end();
    return;
  }
  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx.execute(sql`
        INSERT INTO customer_payment_refunds (payment_id, refund_date, amount, bank_account_id, reference, journal_entry_id, created_by)
        VALUES (${p.receiptId}::uuid, ${p.date}::date, ${p.amount}::numeric, ${p.bank}::uuid, ${p.ref}, ${p.jeId}::uuid, ${p.by}::uuid)`);
      await tx.execute(sql`UPDATE customer_payments SET unapplied_amount = unapplied_amount - ${p.amount}::numeric WHERE id = ${p.receiptId}::uuid`);
      await tx.execute(sql`UPDATE journal_entries SET source_type = 'customer_payment', source_id = ${p.receiptId}::uuid WHERE id = ${p.jeId}::uuid`);
    }
  });
  console.log(`\n  Written: ${plans.length} refunds.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
