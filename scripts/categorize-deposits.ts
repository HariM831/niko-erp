/**
 * Turn statement deposits into receipts, where the payer is not in doubt.
 *
 *   npx tsx scripts/categorize-deposits.ts --from 2026-10-17 --to 2026-10-19
 *   npx tsx scripts/categorize-deposits.ts --from 2026-10-17 --to 2026-10-19 --commit
 *
 * The same thing the Categorize screen does, for a day's worth at a time: a
 * receipt against the customer the line names, applied forward to the sale it
 * paid for, and the statement line linked to it so the bank reconciles.
 *
 * It posts ONLY where one party stands out. Where two could be meant — a cash
 * machine whose mobile has been used by two shops, a narration naming a word
 * that two customers have both paid under — it prints the choice and leaves
 * the line alone. A receipt against the wrong customer is worse than a line
 * still waiting: the money looks found, the customer looks settled, and the
 * next person has no reason to look again.
 *
 * It refuses outright where niko already holds a receipt for that money. The
 * eleven deposits of 7 October are all already in the book under a CP- or
 * PMT- number, and categorizing them would post 36 lakh a second time.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  bankAccounts, bankTransactions, contacts, customerPayments, invoices, paymentApplications,
} from "@shared/schema";
import { linkStatementLine, suggestLearned, suggestParties } from "../server/services/bank-links";
import { nextDocumentNumber } from "../server/lib/numbering";
import { postJournal } from "../server/services/posting";
import { db, pool } from "../server/db";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const FROM = arg("from")!;
const TO = arg("to")!;
const COMMIT = process.argv.includes("--commit");
/** A receipt looks this far forward for the sale it paid for. */
const WINDOW = 2;

const P = (n: string | number) => Math.round(Number(n) * 100);
const R = (p: number) => (p / 100).toFixed(2);
const money = (p: number) => (p / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const day = (s: string) => Date.parse(s) / 86_400_000;

async function main() {
  if (!FROM || !TO) {
    console.error("Usage: categorize-deposits.ts --from YYYY-MM-DD --to YYYY-MM-DD [--commit]");
    process.exitCode = 1;
    return;
  }
  console.log(`\n  Deposits ${FROM} to ${TO} — ${COMMIT ? "POSTING" : "dry run"}\n`);

  const lines = (
    await db.execute(sql`
      SELECT t.id::text, t.txn_date::text AS date, t.amount::float8 AS amount, t.description,
             t.utr, t.counterparty, t.bank_account_id::text AS bank_id, a.name AS bank
        FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id
       WHERE t.direction = 'credit' AND t.match_status = 'unmatched'
         AND t.txn_date BETWEEN ${FROM}::date AND ${TO}::date
       ORDER BY t.txn_date, t.amount DESC
    `)
  ).rows as Array<{ id: string; date: string; amount: number; description: string | null;
                    utr: string | null; counterparty: string | null; bank_id: string; bank: string }>;

  /** Money already in the book. A deposit matching one of these is a line to match, not to key. */
  const already = (
    await db.execute(sql`
      SELECT p.number, p.payment_date::text AS date, c.display_name AS cust,
             round(p.amount::numeric, 2)::float8 AS amount
        FROM customer_payments p JOIN contacts c ON c.id = p.customer_id
    `)
  ).rows as Array<{ number: string; date: string; cust: string; amount: number }>;

  const people = await db
    .select({
      id: contacts.id, displayName: contacts.displayName, companyName: contacts.companyName,
      beneficiary: contacts.bankBeneficiaryName, accountNumber: contacts.bankAccountNumber,
    })
    .from(contacts)
    .where(and(inArray(contacts.type, ["customer", "both"]), eq(contacts.isActive, true),
               eq(contacts.isGroupCompany, false)));

  const seen = (
    await db.execute(sql`
      SELECT c.id::text AS "partyId", c.display_name AS "displayName", p.reference AS text
        FROM customer_payments p JOIN contacts c ON c.id = p.customer_id
       WHERE p.reference IS NOT NULL
      UNION ALL
      SELECT c.id::text, c.display_name, t.description
        FROM bank_transactions t
        JOIN bank_transaction_links l ON l.bank_transaction_id = t.id
        JOIN journal_entries j ON j.id = l.journal_entry_id
        JOIN customer_payments cp ON cp.id = j.source_id AND j.source_type = 'customer_payment'
        JOIN contacts c ON c.id = cp.customer_id
       WHERE t.description IS NOT NULL
    `)
  ).rows as Array<{ partyId: string; displayName: string; text: string }>;
  const house = (
    await db.execute(sql`SELECT account_number FROM bank_accounts WHERE account_number IS NOT NULL`)
  ).rows.map((r) => (r as { account_number: string }).account_number);

  type Plan = { line: typeof lines[number]; partyId: string; party: string; why: string;
                apply: Array<{ id: string; number: string; p: number }>; spare: number };
  const plan: Plan[] = [];
  const unsure: Array<{ line: typeof lines[number]; options: string[] }> = [];

  for (const l of lines) {
    const twin = already.find(
      (p) => Math.abs(p.amount - l.amount) <= 1 &&
             Math.abs(day(p.date) - day(l.date)) <= 3,
    );
    if (twin) {
      unsure.push({ line: l, options: [`already in the book as ${twin.number} (${twin.cust}) — match it, do not key it`] });
      continue;
    }
    const text = `${l.description ?? ""} ${l.utr ?? ""} ${l.counterparty ?? ""}`;
    const named = suggestParties(text, people);
    const known = new Set(named.map((n) => n.id));
    const learned = suggestLearned(text, seen, house).filter((s) => !known.has(s.id));
    const all = [...named, ...learned];
    if (!all.length) { unsure.push({ line: l, options: ["nobody suggested"] }); continue; }
    /**
     * One party or none. The screen can offer a shortlist because a person
     * reads the line and decides; here a second candidate means the evidence
     * does not say, and a guess would be indistinguishable from a fact
     * afterwards.
     */
    if (all.length > 1) {
      unsure.push({ line: l, options: all.map((a) => `${a.displayName} (${a.reason})`) });
      continue;
    }
    const party = all[0]!;

    const open = (
      await db.execute(sql`
        SELECT i.id::text, i.number, i.invoice_date::text AS date,
               (i.total - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
                        - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0))::text AS owed
          FROM invoices i
         WHERE i.customer_id = ${party.id}::uuid AND i.status NOT IN ('void', 'draft')
           AND i.total - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
                       - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0) > 1
         ORDER BY i.invoice_date
      `)
    ).rows as Array<{ id: string; number: string; date: string; owed: string }>;

    // The same rule the allocation pass uses: the sale this money was sent
    // for comes first, then whatever the customer still owes from before.
    let left = P(l.amount);
    const apply: Plan["apply"] = [];
    const take = (inv: typeof open[number]) => {
      const p = Math.min(P(inv.owed), left);
      if (p <= 0) return;
      apply.push({ id: inv.id, number: inv.number, p });
      left -= p;
    };
    const d = day(l.date);
    const forward = open.filter((i) => day(i.date) >= d && day(i.date) <= d + WINDOW);
    const exact = forward.find((i) => P(i.owed) === P(l.amount));
    if (exact) take(exact);
    else {
      for (const i of forward) { if (left <= 0) break; take(i); }
      for (const i of open) { if (left <= 0) break; if (!apply.some((a) => a.id === i.id)) take(i); }
    }
    plan.push({ line: l, partyId: party.id, party: party.displayName, why: party.reason, apply, spare: left });
  }

  for (const p of plan) {
    console.log(
      `    ${p.line.date}  ${money(P(p.line.amount)).padStart(12)}  ${p.party.slice(0, 24).padEnd(25)}${p.why}`,
    );
    console.log(
      `        ${(p.line.description ?? "").slice(0, 58).padEnd(60)}` +
        `${p.apply.map((a) => `${a.number.slice(-4)} ${money(a.p)}`).join(", ") || "nothing open"}` +
        `${p.spare > 0 ? `   advance ${money(p.spare)}` : ""}`,
    );
  }
  console.log(
    `\n  ${plan.length} to post, Rs ${money(plan.reduce((s, p) => s + P(p.line.amount), 0))}` +
      `   ${unsure.length} left for a person\n`,
  );
  for (const u of unsure) {
    console.log(`    ${u.line.date}  ${money(P(u.line.amount)).padStart(12)}  ${(u.line.description ?? "").slice(0, 52)}`);
    for (const o of u.options) console.log(`        ${o}`);
  }

  if (!COMMIT) {
    console.log(`\n  Dry run — nothing posted. Re-run with --commit.\n`);
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'zoho' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("the zoho user is missing; the catch-up is recorded as that user");

  for (const p of plan) {
    await db.transaction(async (tx) => {
      const bank = await tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, p.line.bank_id) });
      if (!bank) throw new Error(`bank account missing for ${p.line.id}`);
      const number = await nextDocumentNumber(tx, "customer_payment");
      const appliedP = p.apply.reduce((s, a) => s + a.p, 0);
      const [row] = await tx
        .insert(customerPayments)
        .values({
          number,
          customerId: p.partyId,
          paymentDate: p.line.date,
          amount: R(P(p.line.amount)),
          unappliedAmount: R(p.spare),
          mode: "bank_transfer",
          reference: p.line.utr ?? p.line.description ?? null,
          bankAccountId: bank.id,
          notes: p.line.description ?? null,
          createdBy: user.id,
        })
        .returning();
      for (const a of p.apply) {
        await tx.insert(paymentApplications).values({
          paymentId: row!.id, invoiceId: a.id, amountApplied: R(a.p),
        });
      }
      const lines = [
        { accountId: bank.glAccountId, debit: R(P(p.line.amount)), description: `Payment ${number}` },
      ];
      if (appliedP > 0) lines.push({ systemKey: "ar", credit: R(appliedP) } as never);
      if (p.spare > 0) lines.push({ systemKey: "customer_advances", credit: R(p.spare) } as never);
      const jeId = await postJournal(tx, {
        entryDate: p.line.date,
        narration: `Payment ${number} — ${p.party}`,
        reference: p.line.utr ?? undefined,
        sourceType: "customer_payment",
        sourceId: row!.id,
        postedBy: user.id,
        lines: lines as never,
      });
      await tx.update(customerPayments).set({ journalEntryId: jeId }).where(eq(customerPayments.id, row!.id));
      // Balances follow the applications, and the line is tied to the receipt.
      for (const a of p.apply) {
        await tx.execute(sql`
          UPDATE invoices i SET balance_due = greatest(round((i.total
            - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
            - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0))::numeric, 2), 0),
            status = CASE WHEN i.total
            - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
            - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0) <= 1 THEN 'paid'
            ELSE 'partially_paid' END::invoice_status
           WHERE i.id = ${a.id}::uuid
        `);
      }
      await linkStatementLine(tx, { bankTransactionId: p.line.id, journalEntryIds: [jeId], kind: "categorized" });
      console.log(`    ${number}  ${p.line.date}  ${p.party}  ${money(P(p.line.amount))}`);
    });
  }
  console.log(`\n  Posted ${plan.length} receipt(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
