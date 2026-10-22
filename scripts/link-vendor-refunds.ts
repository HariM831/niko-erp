/**
 * Tie the vendor refunds brought from Zoho to the payments they came back from.
 *
 *   npx tsx scripts/link-vendor-refunds.ts
 *   npx tsx scripts/link-vendor-refunds.ts --commit
 *
 * Zoho's "Vendor Payment Refund" came across as loose manual journals —
 * DR the bank, CR Vendor Advances — with nothing on the payment saying any of
 * its spare money had gone back. So niko kept offering refunded advances in
 * Apply Credits, and 1095 sat Rs 21.8 lakh below the payments' unapplied total
 * (traced 22 Oct 2026). Each refund now becomes a vendor_payment_refunds row on
 * its payment, the payment's unapplied amount comes down by it, and the
 * existing journal is re-sourced to the payment. No amount in the ledger moves.
 *
 * Pairing, decided once here and printed for review, never guessed:
 *   1. the vendor is the contact named in the narration, exactly;
 *   2. a payment of that vendor dated on or before the refund, holding exactly
 *      the refund's amount spare, the latest such first;
 *   3. failing that, the only payment that could hold it (spare >= refund) —
 *      listed as partial;
 *   4. anything else is left alone and listed.
 * A payment can take several refunds while it has spare left.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const PREFIX = "Vendor Payment Refund — ";
const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paise = (s: string | number) => Math.round(Number(s) * 100);

interface Refund {
  je_id: string;
  entry_number: string;
  entry_date: string;
  narration: string;
  reference: string | null;
  amount: string;
  posted_by: string;
  bank_account_id: string | null;
}
interface Payment {
  id: string;
  number: string;
  payment_date: string;
  unapplied: string;
  in_ledger: boolean;
}

async function main() {
  const refunds = (
    await db.execute(sql`
      SELECT e.id::text AS je_id, e.entry_number, e.entry_date::text, e.narration, e.reference,
             l.credit::text AS amount, e.posted_by::text,
             (SELECT b.id::text FROM journal_entry_lines l2 JOIN bank_accounts b ON b.gl_account_id = l2.account_id
               WHERE l2.entry_id = e.id AND l2.id <> l.id LIMIT 1) AS bank_account_id
        FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        JOIN accounts a ON a.id = l.account_id
       WHERE a.system_key = 'vendor_advances' AND e.source_type = 'manual'
         AND e.narration LIKE ${PREFIX + "%"} AND l.credit > 0
         AND NOT EXISTS (SELECT 1 FROM vendor_payment_refunds r WHERE r.journal_entry_id = e.id)
       ORDER BY e.entry_date, e.entry_number`)
  ).rows as unknown as Refund[];

  // Remaining spare per payment, drawn down as refunds are paired.
  const spare = new Map<string, number>();
  type Plan = { refund: Refund; vendor: string; payment: Payment; kind: "exact" | "partial" };
  const plans: Plan[] = [];
  const skipped: Array<{ refund: Refund; vendor: string; why: string }> = [];

  for (const r of refunds) {
    // The narration ends with the bank in brackets; a vendor's own name may
    // carry brackets too, so only the last bracket is the bank.
    const rest = r.narration.slice(PREFIX.length);
    const vendor = rest.slice(0, rest.lastIndexOf(" (")).trim();
    const contacts = (
      await db.execute(sql`SELECT id::text FROM contacts WHERE display_name = ${vendor} AND type IN ('vendor', 'both')`)
    ).rows as Array<{ id: string }>;
    if (contacts.length !== 1) {
      skipped.push({ refund: r, vendor, why: contacts.length ? "several contacts carry that name" : "no contact by that name" });
      continue;
    }
    const payments = (
      await db.execute(sql`
        SELECT id::text, number, payment_date::text, unapplied_amount::text AS unapplied, advances_in_ledger AS in_ledger
          FROM vendor_payments
         WHERE vendor_id = ${contacts[0]!.id}::uuid AND payment_date <= ${r.entry_date}::date AND unapplied_amount > 0
         ORDER BY payment_date DESC, number DESC`)
    ).rows as unknown as Payment[];
    const left = (p: Payment) => spare.get(p.id) ?? paise(p.unapplied);
    const want = paise(r.amount);
    const exact = payments.find((p) => left(p) === want);
    const fits = payments.filter((p) => left(p) >= want);
    const pick = exact ?? (fits.length === 1 ? fits[0] : undefined);
    if (!pick) {
      skipped.push({
        refund: r,
        vendor,
        why: fits.length ? `${fits.length} payments could hold it` : "no payment holds that much spare",
      });
      continue;
    }
    if (!pick.in_ledger) {
      skipped.push({ refund: r, vendor, why: `${pick.number} still holds its advance inside payables` });
      continue;
    }
    spare.set(pick.id, left(pick) - want);
    plans.push({ refund: r, vendor, payment: pick, kind: exact ? "exact" : "partial" });
  }

  console.log(`\n  Zoho vendor refunds tied to their payments — ${COMMIT ? "WRITING" : "dry run"}\n`);
  for (const p of plans) {
    console.log(
      `  ${p.refund.entry_date}  ${p.refund.entry_number.padEnd(9)} ${p.vendor.slice(0, 32).padEnd(32)} ${money(Number(p.refund.amount)).padStart(13)}  →  ${p.payment.number.padEnd(16)} ${p.payment.payment_date}${p.kind === "partial" ? `  PARTIAL (spare ${money(Number(p.payment.unapplied))})` : ""}`,
    );
  }
  const total = plans.reduce((s, p) => s + Number(p.refund.amount), 0);
  console.log(`\n  ${plans.length} refunds, ${money(total)}.`);
  if (skipped.length) {
    console.log("\n  Left alone:");
    for (const s of skipped) {
      console.log(`  ${s.refund.entry_date}  ${s.refund.entry_number.padEnd(9)} ${s.vendor.slice(0, 32).padEnd(32)} ${money(Number(s.refund.amount)).padStart(13)}  —  ${s.why}`);
    }
  }

  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Add --commit to write.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const p of plans) {
      const r = p.refund;
      await tx.execute(sql`
        INSERT INTO vendor_payment_refunds (payment_id, refund_date, amount, bank_account_id, reference, journal_entry_id, created_by)
        VALUES (${p.payment.id}::uuid, ${r.entry_date}::date, ${r.amount}::numeric, ${r.bank_account_id}::uuid,
                ${r.reference}, ${r.je_id}::uuid, ${r.posted_by}::uuid)`);
      await tx.execute(sql`
        UPDATE vendor_payments SET unapplied_amount = unapplied_amount - ${r.amount}::numeric WHERE id = ${p.payment.id}::uuid`);
      await tx.execute(sql`
        UPDATE journal_entries SET source_type = 'vendor_payment', source_id = ${p.payment.id}::uuid WHERE id = ${r.je_id}::uuid`);
    }
    const [neg] = (
      await tx.execute(sql`SELECT count(*)::int AS n FROM vendor_payments WHERE unapplied_amount < 0`)
    ).rows as Array<{ n: number }>;
    if (neg!.n > 0) throw new Error("a payment would be left with less than nothing spare — nothing written");
  });
  console.log(`\n  Written: ${plans.length} refunds.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
