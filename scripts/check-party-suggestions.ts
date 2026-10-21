/**
 * Who the Categorize screen would offer for each uncategorized line.
 *
 *   npx tsx scripts/check-party-suggestions.ts
 *
 * The screen knows a party by the name we invoice them under, their company
 * name, their beneficiary or their account number. A bank narration carries
 * none of those: "IMPS/629254237391 /RE1-XX766- SANKET S/200 large-" is money
 * from SS Food, and nothing on the contact record says Sanket.
 *
 * So the names are learned from what has already been decided — categorized
 * statement lines and the reference on every receipt — and this prints what
 * that learning produces for the lines still waiting, so a wrong habit can be
 * seen before anybody clicks it.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { contacts } from "@shared/schema";
import { suggestLearned, suggestParties } from "../server/services/bank-links";
import { db, pool } from "../server/db";

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const people = await db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      companyName: contacts.companyName,
      beneficiary: contacts.bankBeneficiaryName,
      accountNumber: contacts.bankAccountNumber,
    })
    .from(contacts)
    .where(and(inArray(contacts.type, ["customer", "both"]), eq(contacts.isActive, true)));

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

  const lines = (
    await db.execute(sql`
      SELECT t.txn_date::text AS date, t.amount::float8 AS amount, t.description, t.utr, t.counterparty
        FROM bank_transactions t
       WHERE t.direction = 'credit' AND t.match_status <> 'matched'
       ORDER BY t.txn_date, t.amount DESC
    `)
  ).rows as Array<{ date: string; amount: number; description: string | null;
                    utr: string | null; counterparty: string | null }>;

  console.log(`\n  ${seen.length} narration(s) already tied to a customer — what the names are learned from`);
  console.log(`  ${lines.length} deposit(s) waiting to be categorized\n`);

  let offered = 0;
  for (const l of lines) {
    const text = `${l.description ?? ""} ${l.utr ?? ""} ${l.counterparty ?? ""}`;
    const named = suggestParties(text, people);
    const known = new Set(named.map((n) => n.id));
    const learned = suggestLearned(text, seen, house).filter((s) => !known.has(s.id));
    const all = [...named, ...learned].slice(0, 6);
    if (all.length) offered += 1;
    console.log(`  ${l.date}  ${money(l.amount).padStart(12)}  ${(l.description ?? "").slice(0, 62)}`);
    for (const s of all) console.log(`      → ${s.displayName.padEnd(28)}${s.reason}`);
    if (!all.length) console.log(`      → nobody yet`);
  }
  console.log(`\n  ${offered} of ${lines.length} would open with a customer suggested.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
