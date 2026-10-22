/**
 * Carry Zoho's discount onto a bill the loader took at its sub-total.
 *
 *   npx tsx scripts/zoho/carry-bill-discount.ts --dump <dir>
 *   npx tsx scripts/zoho/carry-bill-discount.ts --dump <dir> --commit
 *
 * Zoho reduces a bill three ways: an adjustment, a TDS deduction, and a plain
 * discount. The catch-up carried the first two and not the third, because only
 * one bill in 2,178 has one — G. N. Enterprises' screws, 960 of them less 60,
 * paid 900. niko kept the 960, so a bill Zoho calls paid owes 60 here and the
 * vendor sits in payables for it.
 *
 * Sixty rupees is not the point. A payable that cannot be settled is read by
 * every ageing report and every payment run forever, and the only way to clear
 * it is to be right about what the bill is worth.
 *
 * It rewrites the figure, the discount, the balance and the journal behind it —
 * the goods line falls by the discount and so does what we owe — and refuses
 * any bill whose journal is not the plain two lines, since a discount split
 * across several expense accounts is a judgement, not an arithmetic.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../../server/db";

const COMMIT = process.argv.includes("--commit");
const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const R = (n: number) => n.toFixed(2);

async function main() {
  const zoho = new Map<string, { n: string; sub: number; disc: number; total: number }>();
  for (const line of readFileSync(`${DIR}/bills.jsonl`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    // Zoho writes a percentage discount as "1.00%", so only a figure counts.
    const disc = Number(String(r.discount ?? 0).includes("%") ? 0 : r.discount ?? 0);
    if (!disc) continue;
    zoho.set(String(r.bill_id), {
      n: String(r.bill_number), sub: Number(r.sub_total ?? 0),
      disc, total: Number(r.total ?? 0),
    });
  }

  const rows = (
    await db.execute(sql`
      SELECT m.zoho_id, b.id::text, b.number, b.bill_date::text AS date, c.display_name AS vendor,
             b.sub_total::float8 AS sub, b.discount_total::float8 AS disc,
             b.total::float8 AS total, b.balance_due::float8 AS due,
             coalesce((SELECT sum(amount_applied) FROM vendor_payment_applications WHERE bill_id = b.id), 0)::float8 AS paid
        FROM zoho_id_map m
        JOIN bills b ON b.id = m.eggsy_id
        JOIN contacts c ON c.id = b.vendor_id
       WHERE m.entity = 'bill' AND b.status NOT IN ('void', 'draft')
    `)
  ).rows as Array<{ zoho_id: string; id: string; number: string; date: string; vendor: string;
                    sub: number; disc: number; total: number; due: number; paid: number }>;

  const todo = rows.filter((r) => {
    const z = zoho.get(String(r.zoho_id));
    return z && Math.abs(r.disc) < 0.5 && Math.abs(r.total - z.total) > 0.5;
  });

  console.log(`\n  ${zoho.size} Zoho bill(s) carry a discount; ${todo.length} of niko's were taken without it\n`);
  for (const r of todo) {
    const z = zoho.get(String(r.zoho_id))!;
    console.log(
      `    ${r.number}  ${r.date}  ${r.vendor.slice(0, 26).padEnd(27)}` +
        `here ${money(r.total).padStart(11)}   Zoho ${money(z.total).padStart(11)}` +
        ` = ${money(z.sub)} less ${money(z.disc)}   paid ${money(r.paid)}, owes ${money(r.due)}`,
    );
  }
  if (!todo.length || !COMMIT) {
    console.log(`\n  ${COMMIT ? "Nothing to do" : "Dry run — nothing written. Re-run with --commit"}.\n`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const r of todo) {
      const z = zoho.get(String(r.zoho_id))!;
      const lines = (
        await tx.execute(sql`
          SELECT l.id::text, l.debit::float8, l.credit::float8, a.code
            FROM journal_entries e JOIN journal_entry_lines l ON l.entry_id = e.id
            JOIN accounts a ON a.id = l.account_id
           WHERE e.source_type = 'bill' AND e.source_id = ${r.id}::uuid
        `)
      ).rows as Array<{ id: string; debit: number; credit: number; code: string }>;
      const goods = lines.filter((l) => l.debit > 0);
      const owed = lines.filter((l) => l.credit > 0);
      if (goods.length !== 1 || owed.length !== 1) {
        throw new Error(`${r.number}: the journal has ${goods.length} debit and ${owed.length} credit line(s) — split the discount by hand`);
      }
      await tx.execute(sql`
        UPDATE journal_entry_lines SET debit = ${R(goods[0]!.debit - z.disc)} WHERE id = ${goods[0]!.id}::uuid
      `);
      await tx.execute(sql`
        UPDATE journal_entry_lines SET credit = ${R(owed[0]!.credit - z.disc)} WHERE id = ${owed[0]!.id}::uuid
      `);
      await tx.execute(sql`
        UPDATE bills
           SET discount_total = ${R(z.disc)}, total = ${R(z.total)},
               balance_due = ${R(Math.max(z.total - r.paid, 0))},
               status = ${z.total - r.paid <= 0.5 ? "paid" : r.paid > 0 ? "partially_paid" : "open"}::bill_status,
               updated_at = now()
         WHERE id = ${r.id}::uuid
      `);
      console.log(`    ${r.number} is now ${money(z.total)}, owing ${money(Math.max(z.total - r.paid, 0))}`);
    }
  });
  console.log(`\n  ${todo.length} corrected.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
