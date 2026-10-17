/**
 * Bring receivables and customer advances back to what the documents say.
 *
 *   npx tsx scripts/fix-control-drift.ts
 *   npx tsx scripts/fix-control-drift.ts --commit
 *
 * check-control-accounts.ts takes the difference apart. On staging, 17 Oct
 * 2026, it came out like this: the invoices agree to the rupee with what they
 * debited, and the credit side has put 64.75 lakh more into receivables than
 * the applications can account for. Customer advances is short by the same
 * amount plus 31 lakh of refunds, which are real — 28 lakh returned to Luit
 * Valley and 3 lakh to Zakir Egg Store — and which the receipts themselves
 * cannot show, since a receipt knows only what it collected.
 *
 * Where the 64.75 lakh comes from: applying an advance posts an entry of its
 * own, moving the money out of advances and into receivables. Two books'
 * worth of loading, unloading and re-allocating left some of those entries
 * standing while the application they described was deleted. So the ledger
 * holds a settlement that no invoice here was relieved of, and both accounts
 * are wrong by the same amount in opposite directions.
 *
 * This posts one correcting entry per customer — DR receivables, CR customer
 * advances, or the reverse — dated at the cutoff, with a narration that says
 * what it is. It changes no document and no application: it moves the ledger
 * onto them, because they are the record of what happened and it is not.
 *
 * The refunds themselves touch advances and the bank, never receivables, so
 * they are named here but not corrected: the ledger is right about them and
 * the receipts are simply silent. They are why advances stays 31 lakh below
 * the receipts' unapplied total once this has run.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { postJournal } from "../server/services/posting";

const COMMIT = process.argv.includes("--commit");
const onAt = process.argv.indexOf("--on");
/** The books were brought together as at the morning of the 16th. */
const ON = onAt > -1 ? process.argv[onAt + 1]! : "2026-10-16";

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  console.log(`\n  Receivables drift per customer, corrected as at ${ON} — ${COMMIT ? "POSTING" : "dry run"}\n`);

  const rows = (
    await db.execute(sql`
      WITH ar AS (SELECT id FROM accounts WHERE system_key = 'ar'),
      posted AS (
        SELECT i.customer_id AS cust, sum(l.debit - l.credit) AS bal
          FROM journal_entry_lines l
          JOIN journal_entries j ON j.id = l.entry_id
          JOIN invoices i ON i.id = j.source_id AND j.source_type IN ('invoice', 'advance_application')
         WHERE l.account_id = (SELECT id FROM ar)
         GROUP BY 1
        UNION ALL
        SELECT p.customer_id, sum(l.debit - l.credit)
          FROM journal_entry_lines l
          JOIN journal_entries j ON j.id = l.entry_id
          JOIN customer_payments p ON p.id = j.source_id
                                  AND j.source_type IN ('customer_payment', 'advance_application')
         WHERE l.account_id = (SELECT id FROM ar)
         GROUP BY 1
        UNION ALL
        SELECT n.customer_id, sum(l.debit - l.credit)
          FROM journal_entry_lines l
          JOIN journal_entries j ON j.id = l.entry_id
          JOIN credit_notes n ON n.id = j.source_id AND j.source_type = 'credit_note'
         WHERE l.account_id = (SELECT id FROM ar)
         GROUP BY 1
      ),
      docs AS (
        SELECT customer_id AS cust, sum(balance_due) AS bal
          FROM invoices WHERE status NOT IN ('void', 'draft') GROUP BY 1
      )
      SELECT c.id::text, c.display_name AS cust,
             coalesce(sum(posted.bal), 0)::float8 AS posted,
             coalesce(max(docs.bal), 0)::float8 AS open
        FROM contacts c
        LEFT JOIN posted ON posted.cust = c.id
        LEFT JOIN docs ON docs.cust = c.id
       GROUP BY c.id, c.display_name
      HAVING abs(coalesce(sum(posted.bal), 0) - coalesce(max(docs.bal), 0)) > 1
       ORDER BY abs(coalesce(sum(posted.bal), 0) - coalesce(max(docs.bal), 0)) DESC
    `)
  ).rows as Array<{ id: string; cust: string; posted: number; open: number }>;

  /**
   * Money handed back. A receipt knows only what it collected, so a refund
   * leaves the ledger below the receipts for good. Named so the difference it
   * makes is not mistaken for drift later.
   */
  const refunds = (
    await db.execute(sql`
      SELECT j.id::text, j.entry_date::text AS date, j.narration,
             coalesce(sum(l.debit - l.credit), 0)::float8 AS net
        FROM journal_entries j
        JOIN journal_entry_lines l ON l.entry_id = j.id
       WHERE j.source_type = 'manual'
         AND l.account_id IN (SELECT id FROM accounts WHERE system_key IN ('ar', 'customer_advances'))
       GROUP BY j.id, j.entry_date, j.narration
    `)
  ).rows as Array<{ id: string; date: string; narration: string | null; net: number }>;
  if (refunds.length) {
    console.log(`  hand-written entries left alone:`);
    for (const r of refunds) {
      console.log(`    ${r.date}  ${money(r.net).padStart(13)}   ${(r.narration ?? "").slice(0, 64)}`);
    }
    console.log();
  }

  let total = 0;
  for (const r of rows) {
    const drift = r.open - r.posted;                  // receivables must rise by this
    total += drift;
    console.log(
      `    ${r.cust.slice(0, 28).padEnd(29)}posted ${money(r.posted).padStart(13)}` +
        `   open invoices ${money(r.open).padStart(13)}   ${drift > 0 ? "DR" : "CR"} receivables ${money(Math.abs(drift)).padStart(12)}`,
    );
  }
  console.log(`\n  ${rows.length} customer(s), net Rs ${money(total)} onto receivables\n`);

  if (!rows.length) {
    console.log("  Nothing to correct.\n");
    await pool.end();
    return;
  }
  if (!COMMIT) {
    console.log("  Dry run — nothing posted. Re-run with --commit.\n");
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'zoho' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("the zoho user is missing; the catch-up is recorded as that user");

  await db.transaction(async (tx) => {
    for (const r of rows) {
      const drift = Math.round((r.open - r.posted) * 100) / 100;
      await postJournal(tx, {
        entryDate: ON,
        narration: `Advance application corrected — ${r.cust}`,
        sourceType: "manual",
        postedBy: user.id,
        lines:
          drift > 0
            ? [{ systemKey: "ar", debit: drift.toFixed(2) }, { systemKey: "customer_advances", credit: drift.toFixed(2) }]
            : [{ systemKey: "customer_advances", debit: (-drift).toFixed(2) }, { systemKey: "ar", credit: (-drift).toFixed(2) }],
      });
    }
  });
  console.log(`  Posted ${rows.length} correcting entr(ies).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
