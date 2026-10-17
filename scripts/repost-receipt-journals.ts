/**
 * Make each receipt's posting say what the receipt actually settled.
 *
 *   npx tsx scripts/repost-receipt-journals.ts
 *   npx tsx scripts/repost-receipt-journals.ts --commit
 *
 * A receipt posts in two pieces: the part that settles invoices credits
 * receivables, and the part that does not credits the customer's advances. The
 * loader took that split from Zoho — from Zoho's own applied and unused
 * figures — and wrote it even when the applications themselves did not all
 * land here, because the invoice they named was not in niko. Receivables was
 * then credited for money no invoice here had been relieved of, and the
 * control account drifted below the documents: 64.8 lakh on staging.
 *
 * The applications are the truth, settled by the user on 17 Oct 2026. So this
 * rewrites the two credit lines of each receipt's own journal to match them.
 * It does not reverse and re-post: the entry, its date and its bank line are
 * right and only the split between two accounts is wrong, and a reversal pair
 * for every receipt would bury the ledger in entries that cancel out.
 *
 * Any other line on the entry — bank charges, a withheld tax — is left alone
 * and counted, so the two lines it does rewrite still balance the entry.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

interface Row {
  id: string; number: string; date: string; cust: string;
  amount: number; applied: number; unapplied: number;
  entry_id: string | null; ar_credit: number; adv_credit: number;
  other_debit: number; other_credit: number;
}

async function main() {
  console.log(`\n  Receipt postings against their applications — ${COMMIT ? "WRITING" : "dry run"}\n`);

  const rows = (
    await db.execute(sql`
      WITH ar AS (SELECT id FROM accounts WHERE system_key = 'ar'),
           adv AS (SELECT id FROM accounts WHERE system_key = 'customer_advances')
      SELECT p.id::text, p.number, p.payment_date::text AS date, c.display_name AS cust,
             p.amount::float8 AS amount,
             coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE payment_id = p.id), 0)::float8 AS applied,
             p.unapplied_amount::float8 AS unapplied,
             j.id::text AS entry_id,
             coalesce(sum(l.credit) FILTER (WHERE l.account_id = (SELECT id FROM ar)), 0)::float8 AS ar_credit,
             coalesce(sum(l.credit) FILTER (WHERE l.account_id = (SELECT id FROM adv)), 0)::float8 AS adv_credit,
             coalesce(sum(l.debit) FILTER (WHERE l.account_id NOT IN ((SELECT id FROM ar), (SELECT id FROM adv))), 0)::float8 AS other_debit,
             coalesce(sum(l.credit) FILTER (WHERE l.account_id NOT IN ((SELECT id FROM ar), (SELECT id FROM adv))), 0)::float8 AS other_credit
        FROM customer_payments p
        JOIN contacts c ON c.id = p.customer_id
        LEFT JOIN journal_entries j ON j.source_type = 'customer_payment' AND j.source_id = p.id
                                   AND j.is_reversal = false
        LEFT JOIN journal_entry_lines l ON l.entry_id = j.id
       GROUP BY p.id, p.number, p.payment_date, c.display_name, p.amount, p.unapplied_amount, j.id
       ORDER BY p.payment_date, p.number
    `)
  ).rows as Row[];

  const noEntry = rows.filter((r) => !r.entry_id);
  const wrongSplit = rows.filter(
    (r) => r.entry_id && Math.abs(r.ar_credit - r.applied) > 1,
  );
  /**
   * A receipt whose own total has drifted from its posting is a different
   * problem — the bank line itself is wrong — and this does not touch it.
   */
  const wrongSum = rows.filter(
    (r) => r.entry_id && Math.abs(r.other_debit - r.other_credit - r.amount) > 1,
  );
  const badUnapplied = rows.filter((r) => Math.abs(r.amount - r.applied - r.unapplied) > 1);

  console.log(`  ${rows.length} receipts`);
  console.log(`    posting splits receivables and advances wrongly .. ${wrongSplit.length}   Rs ${money(wrongSplit.reduce((s, r) => s + Math.abs(r.ar_credit - r.applied), 0))}`);
  console.log(`    the receipt's own unapplied figure is wrong ...... ${badUnapplied.length}`);
  console.log(`    no posting at all ................................ ${noEntry.length}`);
  console.log(`    the bank side disagrees with the receipt ......... ${wrongSum.length}   (left alone)`);

  for (const [label, set] of [
    ["splits wrongly", wrongSplit.slice(0, 12)],
    ["no posting", noEntry.slice(0, 8)],
    ["bank side disagrees", wrongSum.slice(0, 8)],
  ] as const) {
    if (!set.length) continue;
    console.log(`\n  ${label}:`);
    for (const r of set) {
      console.log(
        `    ${r.number.padEnd(20)}${r.date}  ${r.cust.slice(0, 22).padEnd(23)}${money(r.amount).padStart(11)}` +
          `   applied ${money(r.applied).padStart(11)}   posted to AR ${money(r.ar_credit).padStart(11)}  advances ${money(r.adv_credit).padStart(11)}`,
      );
    }
  }

  const fixable = wrongSplit.filter((r) => !wrongSum.includes(r));
  if (!fixable.length && !badUnapplied.length) {
    console.log(`\n  Every receipt's posting says what it settled.\n`);
    await pool.end();
    return;
  }
  if (!COMMIT) {
    console.log(`\n  Dry run — nothing written. ${fixable.length} posting(s) and ${badUnapplied.length} unapplied figure(s) would be rewritten with --commit.\n`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const r of fixable) {
      const target = r.other_debit - r.other_credit;        // what the two lines must credit
      const ar = Math.min(r.applied, target);
      const advance = Math.round((target - ar) * 100) / 100;
      for (const [key, amount] of [["ar", ar], ["customer_advances", advance]] as const) {
        await tx.execute(sql`
          DELETE FROM journal_entry_lines
           WHERE entry_id = ${r.entry_id}::uuid
             AND account_id = (SELECT id FROM accounts WHERE system_key = ${key})
        `);
        if (amount <= 0) continue;
        await tx.execute(sql`
          INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description)
          SELECT ${r.entry_id}::uuid, a.id, 0, ${amount.toFixed(2)}::numeric,
                 ${key === "ar" ? `Settles ${r.number}` : `Advance on ${r.number}`}
            FROM accounts a WHERE a.system_key = ${key}
        `);
      }
    }
    await tx.execute(sql`
      UPDATE customer_payments p
         SET unapplied_amount = greatest(round((p.amount
           - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE payment_id = p.id), 0))::numeric, 2), 0)
    `);
  });
  console.log(`\n  Rewritten: ${fixable.length} posting(s); every receipt's unapplied figure recomputed.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
