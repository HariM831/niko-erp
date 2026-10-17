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

const keyAt = process.argv.indexOf("--account");
/** Which control account to take apart; receivables unless asked otherwise. */
const KEY = keyAt > -1 ? process.argv[keyAt + 1]! : "ar";

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

  /**
   * Payables nets the advances inside itself. A vendor payment debits payables
   * for the whole of itself whatever it settles — there is no second account
   * for the unapplied part, the way customer advances holds it on the selling
   * side — so money paid ahead of a bill sits in payables as a debit, and what
   * the ledger should say is the open bills LESS that.
   */
  const [bill] = (
    await db.execute(sql`
      SELECT (SELECT coalesce(sum(balance_due), 0) FROM bills WHERE status NOT IN ('void', 'draft'))::float8 AS open,
             (SELECT coalesce(sum(p.unapplied_amount), 0) FROM vendor_payments p
               WHERE EXISTS (SELECT 1 FROM zoho_id_map z
                              WHERE z.entity = 'vendor_payment' AND z.eggsy_id = p.id))::float8 AS imported,
             (SELECT coalesce(sum(p.unapplied_amount), 0) FROM vendor_payments p
               WHERE NOT EXISTS (SELECT 1 FROM zoho_id_map z
                                  WHERE z.entity = 'vendor_payment' AND z.eggsy_id = p.id))::float8 AS own
    `)
  ).rows as Array<{ open: number; imported: number; own: number }>;
  checks.push({ what: "open bills less own advances", key: "ap", docs: bill!.open - bill!.own, sign: -1 });
  checks.push({ what: "advances on imported payments", key: "vendor_advances", docs: bill!.imported, sign: 1 });

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
   * Where the movement comes from. Receivables carries no customer of its own,
   * so before attributing a difference it is worth seeing which kind of
   * document moved it at all — an entry nobody can attribute is the first
   * thing to look at.
   */
  const bySource = (
    await db.execute(sql`
      SELECT j.source_type::text AS src, count(DISTINCT j.id)::int AS entries,
             coalesce(sum(l.debit - l.credit), 0)::float8 AS net
        FROM journal_entries j
        JOIN journal_entry_lines l ON l.entry_id = j.id
       WHERE l.account_id = (SELECT id FROM accounts WHERE system_key = ${KEY})
       GROUP BY 1 ORDER BY 3 DESC
    `)
  ).rows as Array<{ src: string; entries: number; net: number }>;
  console.log(`\n  what moves receivables:`);
  for (const s of bySource) {
    console.log(`    ${s.src.padEnd(24)}${String(s.entries).padStart(6)} entries   ${money(s.net).padStart(15)}`);
  }
  /**
   * A hand-written entry against a control account is worth naming: the
   * documents cannot account for it, so the difference it makes never closes
   * on its own. Two of them hold 31 lakh of customer advances on staging.
   */
  const manual = (
    await db.execute(sql`
      SELECT j.entry_date::text AS date, j.narration,
             coalesce(sum(l.debit - l.credit), 0)::float8 AS net
        FROM journal_entries j
        JOIN journal_entry_lines l ON l.entry_id = j.id
       WHERE l.account_id = (SELECT id FROM accounts WHERE system_key = ${KEY})
         AND j.source_type = 'manual'
       GROUP BY j.id, j.entry_date, j.narration
       ORDER BY abs(sum(l.debit - l.credit)) DESC LIMIT 15
    `)
  ).rows as Array<{ date: string; narration: string | null; net: number }>;
  if (manual.length) {
    console.log(`
  hand-written entries against it:`);
    for (const m of manual) {
      console.log(`    ${m.date}  ${money(m.net).padStart(14)}   ${(m.narration ?? "(no narration)").slice(0, 70)}`);
    }
  }

  if (KEY !== "ar" && KEY !== "ap") {
    console.log();
    await pool.end();
    return;
  }

  /**
   * Both sides of the gap, separately: what the invoices are worth against
   * what they debited, and what has been applied to them against what was
   * credited back. A control account is only ever wrong on one of those two.
   */
  const [sides] = (
    await db.execute(
      KEY === "ar"
        ? sql`
      SELECT (SELECT coalesce(sum(total), 0) FROM invoices WHERE status NOT IN ('void', 'draft'))::float8 AS raised,
             (SELECT coalesce(sum(amount_applied), 0) FROM payment_applications)::float8 AS paid,
             (SELECT coalesce(sum(amount_applied), 0) FROM credit_note_applications)::float8 AS credited
    `
        : sql`
      SELECT (SELECT coalesce(sum(total), 0) FROM bills WHERE status NOT IN ('void', 'draft'))::float8 AS raised,
             (SELECT coalesce(sum(amount_applied), 0) FROM vendor_payment_applications)::float8 AS paid,
             (SELECT coalesce(sum(amount_applied), 0) FROM vendor_credit_applications)::float8 AS credited
    `,
    )
  ).rows as Array<{ raised: number; paid: number; credited: number }>;
  const debits = bySource.filter((s) => s.net > 0).reduce((s, r) => s + r.net, 0);
  const credits = -bySource.filter((s) => s.net < 0).reduce((s, r) => s + r.net, 0);
  // On a liability the directions are the other way round: a bill credits
  // payables and a payment debits it.
  const raisedSide = KEY === "ar" ? debits : credits;
  const appliedSide = KEY === "ar" ? credits : debits;
  const line = (label: string, doc: number, posted: number) =>
    console.log(
      `    ${label.padEnd(16)}${money(doc).padStart(15)}   posted ${money(posted).padStart(15)}   ` +
        `${Math.abs(doc - posted) < 1 ? "agree" : `apart by ${money(posted - doc)}`}`,
    );
  line(KEY === "ar" ? "invoices raised" : "bills raised", sides!.raised, raisedSide);
  line("applied to them", sides!.paid + sides!.credited, appliedSide);
  if (KEY === "ap") {
    /**
     * Two conventions meet here. A vendor payment raised in niko debits
     * payables for the whole of itself, so money paid ahead of a bill sits
     * inside payables; the Zoho loader puts that part in vendor advances
     * instead. Both are internally consistent and the two figures below are
     * where each convention's advances went, not a difference to chase.
     */
    console.log(`    ${"paid ahead".padEnd(16)}${money(bill!.own).padStart(15)}   raised here — sits inside payables`);
    console.log(`    ${"".padEnd(16)}${money(bill!.imported).padStart(15)}   imported — sits in vendor advances`);
  }

  /**
   * Then each customer's own documents beside the postings those documents
   * made. An advance applied posts an entry of its own, and it is raised
   * against an invoice from the sales screens and against the receipt by the
   * re-allocation, so both shapes have to be followed to find the customer.
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
