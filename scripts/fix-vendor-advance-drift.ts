/**
 * Move vendor payments' postings onto what they apply.
 *
 *   npx tsx scripts/fix-vendor-advance-drift.ts
 *   npx tsx scripts/fix-vendor-advance-drift.ts --commit
 *
 * A vendor payment that holds its advances in the ledger (advances_in_ledger)
 * should have moved payables by exactly what it applies to bills, and Vendor
 * Advances by exactly what it leaves spare. On production on 22 Oct 2026, 13
 * payments brought from Zoho did not: they were put against bills after they
 * were loaded — by the bill merges and re-allocations of 17 Oct — and nothing
 * moved the money out of Vendor Advances when that happened. So payables said
 * 4,46,057 more was owed than the bills do, and Vendor Advances held the same
 * amount of money that had already gone to a bill. One payment
 * (VP-2026-27/0988, Shreeram) is the other way: its 5,409 was trimmed off
 * BILL-002164 and handed back as an advance, and payables kept it.
 *
 * Each such payment gets one entry, dated today and tied to the payment —
 * DR payables / CR Vendor Advances, or the reverse — for the difference, the
 * way any later change to a payment's applications posts
 * (services/payment-ledger.ts, the rule of 22 Oct 2026). No document and no
 * application changes: the ledger moves onto them.
 *
 * A payment whose payables and advances postings do not add up to what left
 * the bank is not touched — that is a different fault, and it is listed.
 *
 * Dry run by default. Afterwards check-control-accounts --account ap should
 * show payables agreeing.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { postJournal } from "../server/services/posting";
import { istDate } from "../server/services/day-resolution";

const COMMIT = process.argv.includes("--commit");
const AS = process.argv.find((a) => a.startsWith("--as="))?.slice(5) ?? "admin";
const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paise = (n: number) => Math.round(n * 100);

async function main() {
  const rows = (
    await db.execute(sql`
      WITH mv AS (
        SELECT e.source_id, a.system_key, sum(l.debit - l.credit) AS v
          FROM journal_entry_lines l
          JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id
         WHERE a.system_key IN ('ap', 'vendor_advances')
         GROUP BY 1, 2)
      , rf AS (SELECT payment_id, sum(amount) AS v FROM vendor_payment_refunds GROUP BY 1)
      SELECT p.id::text, p.number, c.display_name AS vendor,
             -- What the vendor refunded is neither applied nor spare.
             (p.amount - p.unapplied_amount - coalesce(rf.v, 0))::float8 AS applied,
             p.unapplied_amount::float8 AS unapplied,
             coalesce(ap.v, 0)::float8 AS ap,
             coalesce(ad.v, 0)::float8 AS adv
        FROM vendor_payments p
        JOIN contacts c ON c.id = p.vendor_id
        LEFT JOIN mv ap ON ap.source_id = p.id AND ap.system_key = 'ap'
        LEFT JOIN mv ad ON ad.source_id = p.id AND ad.system_key = 'vendor_advances'
        LEFT JOIN rf ON rf.payment_id = p.id
       WHERE p.advances_in_ledger
         AND (abs(coalesce(ap.v, 0) - (p.amount - p.unapplied_amount - coalesce(rf.v, 0))) > 0.004
           OR abs(coalesce(ad.v, 0) - p.unapplied_amount) > 0.004)
       ORDER BY p.payment_date, p.number`)
  ).rows as Array<{ id: string; number: string; vendor: string; applied: number; unapplied: number; ap: number; adv: number }>;

  const fixable = rows.filter((r) => paise(r.ap) + paise(r.adv) === paise(r.applied) + paise(r.unapplied));
  const odd = rows.filter((r) => !fixable.includes(r));
  const on = istDate();

  console.log(`\n  Vendor payments whose postings differ from their applications — ${COMMIT ? "POSTING" : "dry run"}\n`);
  let net = 0;
  for (const r of fixable) {
    const diff = r.applied - r.ap; // + : payables owes this much more debit
    net += diff;
    console.log(
      `  ${r.number.padEnd(17)}${r.vendor.slice(0, 34).padEnd(34)}  applied ${money(r.applied).padStart(14)}  payables ${money(r.ap).padStart(14)}  →  ${diff > 0 ? "DR payables" : "CR payables"} ${money(Math.abs(diff))}`,
    );
  }
  console.log(`\n  ${fixable.length} payments, net into payables ${money(net)}, dated ${on}.`);
  if (odd.length) {
    console.log(`\n  Left alone — payables and advances do not add up to the payment:`);
    for (const r of odd) console.log(`  ${r.number}  ${r.vendor}  ap ${r.ap} adv ${r.adv} applied ${r.applied} unapplied ${r.unapplied}`);
  }

  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Add --commit to post.");
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = ${AS} LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error(`no user '${AS}' to record the entries as`);

  await db.transaction(async (tx) => {
    for (const r of fixable) {
      const diffP = paise(r.applied) - paise(r.ap);
      const amount = (Math.abs(diffP) / 100).toFixed(2);
      const [dr, cr] = diffP > 0 ? ["ap", "vendor_advances"] : ["vendor_advances", "ap"];
      await postJournal(tx, {
        entryDate: on,
        narration: `${r.number} — ${amount} ${diffP > 0 ? "applied to bills, moved out of" : "handed back, moved into"} vendor advances`,
        sourceType: "vendor_payment",
        sourceId: r.id,
        postedBy: user.id,
        lines: [
          { systemKey: dr, debit: amount },
          { systemKey: cr, credit: amount },
        ],
      });
    }
  });
  console.log(`\n  Posted ${fixable.length} entries.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
