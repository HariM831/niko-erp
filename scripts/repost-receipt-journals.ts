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
 * rewrites the two credit lines to match them. It does not reverse and
 * re-post: the entry, its date and its bank line are right and only the split
 * between two accounts is wrong, and a reversal pair for every receipt would
 * bury the ledger in entries that cancel out.
 *
 * A receipt can carry more than one entry. Where Zoho applied money days after
 * it arrived, the loader posted a second entry on the later day moving it from
 * advances into receivables. Those are folded back into the receipt's own
 * entry: what they describe is Zoho's apply_date, and the allocation they
 * describe is no longer the one niko holds. The split is then right from the
 * day the money came in, which is also how the app posts a receipt today.
 *
 * Any other line — bank charges, a withheld tax — is left alone and counted,
 * so the two lines this rewrites still balance the entry.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

interface Row {
  id: string; number: string; date: string; cust: string;
  amount: number; applied: number; unapplied: number;
  entries: number; primary_id: string | null;
  ar: number; adv: number; bank: number;
}

async function main() {
  console.log(`\n  Receipt postings against their applications — ${COMMIT ? "WRITING" : "dry run"}\n`);

  const rows = (
    await db.execute(sql`
      WITH ar AS (SELECT id FROM accounts WHERE system_key = 'ar'),
           adv AS (SELECT id FROM accounts WHERE system_key = 'customer_advances'),
           je AS (
             SELECT j.id, j.source_id, j.entry_date,
                    coalesce(sum(l.credit - l.debit) FILTER (WHERE l.account_id = (SELECT id FROM ar)), 0) AS ar,
                    coalesce(sum(l.credit - l.debit) FILTER (WHERE l.account_id = (SELECT id FROM adv)), 0) AS adv,
                    coalesce(sum(l.debit - l.credit) FILTER (WHERE l.account_id NOT IN ((SELECT id FROM ar), (SELECT id FROM adv))), 0) AS bank
               FROM journal_entries j
               LEFT JOIN journal_entry_lines l ON l.entry_id = j.id
              WHERE j.source_type = 'customer_payment' AND j.is_reversal = false
              GROUP BY j.id, j.source_id, j.entry_date
           )
      SELECT p.id::text, p.number, p.payment_date::text AS date, c.display_name AS cust,
             p.amount::float8 AS amount,
             coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE payment_id = p.id), 0)::float8 AS applied,
             p.unapplied_amount::float8 AS unapplied,
             count(je.id)::int AS entries,
             (SELECT k.id::text FROM je k WHERE k.source_id = p.id ORDER BY k.bank DESC, k.entry_date LIMIT 1) AS primary_id,
             coalesce(sum(je.ar), 0)::float8 AS ar,
             coalesce(sum(je.adv), 0)::float8 AS adv,
             coalesce(sum(je.bank), 0)::float8 AS bank
        FROM customer_payments p
        JOIN contacts c ON c.id = p.customer_id
        LEFT JOIN je ON je.source_id = p.id
       GROUP BY p.id, p.number, p.payment_date, c.display_name, p.amount, p.unapplied_amount
       ORDER BY p.payment_date, p.number
    `)
  ).rows as Row[];

  const noEntry = rows.filter((r) => !r.entries);
  const wrongBank = rows.filter((r) => r.entries && Math.abs(r.bank - r.amount) > 1);
  const wrongSplit = rows.filter(
    (r) => r.entries && !wrongBank.includes(r) && Math.abs(r.ar - r.applied) > 1,
  );
  const badUnapplied = rows.filter((r) => Math.abs(r.amount - r.applied - r.unapplied) > 1);

  console.log(`  ${rows.length} receipts`);
  console.log(`    split receivables and advances wrongly ..... ${wrongSplit.length}   Rs ${money(wrongSplit.reduce((s, r) => s + Math.abs(r.ar - r.applied), 0))}`);
  console.log(`    carry a second entry from a later apply date  ${rows.filter((r) => r.entries > 1).length}`);
  console.log(`    their own unapplied figure is wrong ........ ${badUnapplied.length}`);
  console.log(`    no posting at all .......................... ${noEntry.length}`);
  console.log(`    the bank side disagrees with the receipt ... ${wrongBank.length}   (left alone)`);

  for (const [label, set] of [
    ["split wrongly", wrongSplit.slice(0, 12)],
    ["no posting", noEntry.slice(0, 8)],
    ["bank side disagrees", wrongBank.slice(0, 8)],
  ] as const) {
    if (!set.length) continue;
    console.log(`\n  ${label}:`);
    for (const r of set) {
      console.log(
        `    ${r.number.padEnd(20)}${r.date}  ${r.cust.slice(0, 22).padEnd(23)}${money(r.amount).padStart(11)}` +
          `   applied ${money(r.applied).padStart(11)}   posted to AR ${money(r.ar).padStart(11)}  advances ${money(r.adv).padStart(11)}`,
      );
    }
  }

  if (!wrongSplit.length && !badUnapplied.length) {
    console.log(`\n  Every receipt's posting says what it settled.\n`);
    await pool.end();
    return;
  }
  if (!COMMIT) {
    console.log(`\n  Dry run — nothing written. ${wrongSplit.length} posting(s) would be rewritten with --commit.\n`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const r of wrongSplit) {
      const target = r.bank;                                 // what the two lines must credit
      const ar = Math.min(r.applied, target);
      const advance = Math.round((target - ar) * 100) / 100;
      // Clear both accounts off every entry this receipt has, including the
      // later apply-date ones, then state the split once on the receipt's own.
      await tx.execute(sql`
        DELETE FROM journal_entry_lines
         WHERE entry_id IN (SELECT id FROM journal_entries
                             WHERE source_type = 'customer_payment' AND source_id = ${r.id}::uuid)
           AND account_id IN (SELECT id FROM accounts WHERE system_key IN ('ar', 'customer_advances'))
      `);
      for (const [key, amount] of [["ar", ar], ["customer_advances", advance]] as const) {
        if (amount <= 0) continue;
        await tx.execute(sql`
          INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, line_order)
          SELECT ${r.primary_id}::uuid, a.id, 0, ${amount.toFixed(2)}::numeric,
                 ${key === "ar" ? `Settles invoices` : `Held as an advance`}, ${key === "ar" ? 1 : 2}
            FROM accounts a WHERE a.system_key = ${key}
        `);
      }
      // An apply-date entry that held nothing but those two lines is now empty.
      await tx.execute(sql`
        DELETE FROM journal_entries j
         WHERE j.source_type = 'customer_payment' AND j.source_id = ${r.id}::uuid
           AND j.id <> ${r.primary_id}::uuid
           AND NOT EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.entry_id = j.id)
      `);
    }
    await tx.execute(sql`
      UPDATE customer_payments p
         SET unapplied_amount = greatest(round((p.amount
           - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE payment_id = p.id), 0))::numeric, 2), 0)
    `);
  });
  console.log(`\n  Rewritten: ${wrongSplit.length} posting(s); every receipt's unapplied figure recomputed.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
