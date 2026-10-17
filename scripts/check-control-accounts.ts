/**
 * Does the ledger say what the documents say?
 *
 *   npx tsx scripts/check-control-accounts.ts
 *
 * check-document-balances.ts settles one half: an invoice says it is owed what
 * its applications leave on it. This is the other half. Receivables is a
 * control account — every invoice debits it and every receipt credits it — so
 * its balance must equal what the open invoices add up to, and customer
 * advances must equal the receipts not yet placed against a sale. The same
 * holds on the buying side.
 *
 * They were apart by lakhs through the catch-up, and for a reason worth
 * keeping: a loader wrote a receipt's journal from Zoho's split of applied and
 * unapplied, then the allocation changed underneath it. A control account that
 * disagrees with its documents means a posting somewhere describes a document
 * that no longer looks like that.
 *
 * This only reports. The customers it names are where to look.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const money = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

async function balance(key: string) {
  const [row] = (
    await db.execute(sql`
      SELECT a.code, a.name,
             coalesce(sum(l.debit - l.credit), 0)::float8 AS bal
        FROM accounts a
        LEFT JOIN journal_entry_lines l ON l.account_id = a.id
       WHERE a.system_key = ${key}
       GROUP BY a.code, a.name
    `)
  ).rows as Array<{ code: string; name: string; bal: number }>;
  return row ?? null;
}

async function main() {
  console.log(`\n  Control accounts against their documents\n`);

  const checks: Array<{ what: string; key: string; docs: number; sign: 1 | -1 }> = [];

  const [inv] = (
    await db.execute(sql`
      SELECT coalesce(sum(balance_due), 0)::float8 AS open
        FROM invoices WHERE status NOT IN ('void', 'draft')
    `)
  ).rows as Array<{ open: number }>;
  checks.push({ what: "open invoices", key: "ar", docs: inv!.open, sign: 1 });

  const [adv] = (
    await db.execute(sql`
      SELECT coalesce(sum(unapplied_amount), 0)::float8 AS held FROM customer_payments
    `)
  ).rows as Array<{ held: number }>;
  checks.push({ what: "receipts not yet placed", key: "customer_advances", docs: adv!.held, sign: -1 });

  const [bill] = (
    await db.execute(sql`
      SELECT coalesce(sum(balance_due), 0)::float8 AS open
        FROM bills WHERE status NOT IN ('void', 'draft')
    `)
  ).rows as Array<{ open: number }>;
  checks.push({ what: "open bills", key: "ap", docs: bill!.open, sign: -1 });

  for (const c of checks) {
    const acct = await balance(c.key);
    if (!acct) { console.log(`    ${c.what.padEnd(28)}no account carries the key '${c.key}'`); continue; }
    const led = acct.bal * c.sign;
    const diff = led - c.docs;
    console.log(
      `    ${acct.code} ${acct.name.slice(0, 22).padEnd(23)}ledger ${money(led).padStart(14)}` +
        `   ${c.what} ${money(c.docs).padStart(14)}   ${Math.abs(diff) < 1 ? "agree" : `apart by ${money(diff)}`}`,
    );
  }

  /**
   * Where a difference lives. Receivables is posted per document but carries no
   * customer of its own, so the only way to attribute it is to put each
   * customer's own documents beside the postings their documents made.
   */
  const rows = (
    await db.execute(sql`
      WITH ar AS (SELECT id FROM accounts WHERE system_key = 'ar'),
      posted AS (
        SELECT i.customer_id AS cust, sum(l.debit - l.credit)::float8 AS bal
          FROM journal_entry_lines l
          JOIN journal_entries j ON j.id = l.entry_id
          JOIN invoices i ON i.id = j.source_id AND j.source_type = 'invoice'
         WHERE l.account_id = (SELECT id FROM ar)
         GROUP BY 1
        UNION ALL
        SELECT p.customer_id, sum(l.debit - l.credit)::float8
          FROM journal_entry_lines l
          JOIN journal_entries j ON j.id = l.entry_id
          JOIN customer_payments p ON p.id = j.source_id
                                  AND j.source_type IN ('customer_payment', 'advance_application')
         WHERE l.account_id = (SELECT id FROM ar)
         GROUP BY 1
        UNION ALL
        SELECT i.customer_id, sum(l.debit - l.credit)::float8
          FROM journal_entry_lines l
          JOIN journal_entries j ON j.id = l.entry_id
          JOIN invoices i ON i.id = j.source_id AND j.source_type = 'advance_application'
         WHERE l.account_id = (SELECT id FROM ar)
         GROUP BY 1
      ),
      docs AS (
        SELECT customer_id AS cust, sum(balance_due)::float8 AS bal
          FROM invoices WHERE status NOT IN ('void', 'draft') GROUP BY 1
      )
      SELECT c.display_name AS cust,
             coalesce(sum(posted.bal), 0)::float8 AS posted,
             coalesce(max(docs.bal), 0)::float8 AS open
        FROM contacts c
        LEFT JOIN posted ON posted.cust = c.id
        LEFT JOIN docs ON docs.cust = c.id
       GROUP BY c.display_name
      HAVING abs(coalesce(sum(posted.bal), 0) - coalesce(max(docs.bal), 0)) > 1
       ORDER BY abs(coalesce(sum(posted.bal), 0) - coalesce(max(docs.bal), 0)) DESC
       LIMIT 25
    `)
  ).rows as Array<{ cust: string; posted: number; open: number }>;

  if (!rows.length) {
    console.log(`\n  Every customer's postings and documents say the same.\n`);
    await pool.end();
    return;
  }
  console.log(`\n  customers whose receivable postings and open invoices differ:`);
  for (const r of rows) {
    console.log(
      `    ${r.cust.slice(0, 28).padEnd(29)}posted ${money(r.posted).padStart(13)}` +
        `   open invoices ${money(r.open).padStart(13)}   apart ${money(r.posted - r.open).padStart(13)}`,
    );
  }
  console.log();
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
