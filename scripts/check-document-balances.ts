/**
 * A document's balance is what it is owed less what has been put against it.
 *
 *   npx tsx scripts/check-document-balances.ts
 *   npx tsx scripts/check-document-balances.ts --fix
 *
 * `balance_due` is a remembered number, not a derived one: whoever writes an
 * invoice or a bill sets it, and nothing recalculates it afterwards. The Zoho
 * loaders set it from Zoho's own balance verbatim, which was right at the
 * moment of the load and has been drifting since.
 *
 * It shows up as a document that says it is settled with nothing settling it.
 * On 17 Oct 2026, 113 invoices carried Rs 2.09 crore of "paid" with no payment
 * applied behind them, and four bills imported that morning said the same. It
 * also means loading a receipt does not reduce what an invoice says it is owed
 * — the field is not computed from the applications, so nothing moved when Rs
 * 4.96 crore of receipts went in.
 *
 * The invariant, settled by the user on 17 Oct 2026 — balance is DERIVED FROM
 * APPLICATIONS, always:
 *
 *   invoice.balance_due = total
 *                       - payments applied
 *                       - credit notes applied
 *
 *   bill.balance_due    = total
 *                       - vendor payments applied
 *                       - vendor credits applied
 *
 * This reports every document that disagrees with that, and with --fix writes
 * the derived figure. It does NOT touch the ledger: AR and AP control are
 * posted by the documents themselves and are a separate reconciliation — this
 * only makes a document's own statement of itself true.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const FIX = process.argv.includes("--fix");

const money = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

async function main() {
  console.log(`\n  Document balances — ${FIX ? "FIXING" : "dry run"}\n`);

  const invoices = (
    await db.execute(sql`
      SELECT i.id, i.number, i.invoice_date::text AS date, c.display_name AS party,
             i.total::float8 AS total, i.balance_due::float8 AS says,
             coalesce(p.applied, 0)::float8 AS paid,
             coalesce(n.applied, 0)::float8 AS credited
        FROM invoices i
        JOIN contacts c ON c.id = i.customer_id
        LEFT JOIN (SELECT invoice_id, sum(amount_applied) applied FROM payment_applications GROUP BY 1) p
               ON p.invoice_id = i.id
        LEFT JOIN (SELECT invoice_id, sum(amount_applied) applied FROM credit_note_applications GROUP BY 1) n
               ON n.invoice_id = i.id
       WHERE i.status <> 'void'
         AND abs(i.total - coalesce(p.applied,0) - coalesce(n.applied,0) - i.balance_due) > 1
         -- A document over-applied by a few rupees holds a balance of zero,
         -- which is as true as it can be: the derived figure is below zero and
         -- nothing below zero is storable. Only a material excess is a finding.
         AND (i.total - coalesce(p.applied,0) - coalesce(n.applied,0) >= 0
              OR coalesce(p.applied,0) + coalesce(n.applied,0) - i.total > greatest(100, i.total * 0.005))
       ORDER BY abs(i.total - coalesce(p.applied,0) - coalesce(n.applied,0) - i.balance_due) DESC
    `)
  ).rows as Array<{ id: string; number: string; date: string; party: string;
                    total: number; says: number; paid: number; credited: number }>;

  const bills = (
    await db.execute(sql`
      SELECT b.id, b.number, b.bill_date::text AS date, c.display_name AS party,
             b.total::float8 AS total, b.balance_due::float8 AS says,
             coalesce(p.applied, 0)::float8 AS paid,
             coalesce(n.applied, 0)::float8 AS credited
        FROM bills b
        JOIN contacts c ON c.id = b.vendor_id
        LEFT JOIN (SELECT bill_id, sum(amount_applied) applied FROM vendor_payment_applications GROUP BY 1) p
               ON p.bill_id = b.id
        LEFT JOIN (SELECT bill_id, sum(amount_applied) applied FROM vendor_credit_applications GROUP BY 1) n
               ON n.bill_id = b.id
       WHERE b.status <> 'void'
         AND abs(b.total - coalesce(p.applied,0) - coalesce(n.applied,0) - b.balance_due) > 1
         AND (b.total - coalesce(p.applied,0) - coalesce(n.applied,0) >= 0
              OR coalesce(p.applied,0) + coalesce(n.applied,0) - b.total > greatest(100, b.total * 0.005))
       ORDER BY abs(b.total - coalesce(p.applied,0) - coalesce(n.applied,0) - b.balance_due) DESC
    `)
  ).rows as typeof invoices;

  for (const [label, rows] of [["INVOICES", invoices], ["BILLS", bills]] as const) {
    const net = rows.reduce((s, r) => s + (r.total - r.paid - r.credited - r.says), 0);
    console.log(`  ${label}: ${rows.length} disagree with their applications, net Rs ${money(net)}`);
    for (const r of rows.slice(0, 12)) {
      const should = r.total - r.paid - r.credited;
      console.log(
        `    ${r.number.padEnd(18)}${r.date}  ${r.party.slice(0, 22).padEnd(23)}` +
          `total ${money(r.total).padStart(11)}  applied ${money(r.paid + r.credited).padStart(11)}` +
          `  says ${money(r.says).padStart(10)}  should be ${money(should).padStart(11)}`,
      );
    }
    if (rows.length > 12) console.log(`    ... and ${rows.length - 12} more`);
    console.log();
  }

  if (!invoices.length && !bills.length) {
    console.log("  Every document's balance is what its applications make it.\n");
    await pool.end();
    return;
  }
  /**
   * A derived balance below zero means more has been put against the document
   * than it is worth, and that is a mistake to look at, not a figure to store.
   * Two turned up at once, each applied EXACTLY twice its total: Chowdhury n
   * Sons 8,96,400 against 17,92,800, and the 29 June Pal Egg Center invoice
   * 6,00,600 against 12,01,200 — the one whose customer the two books disagree
   * about, its receipt applied once from each version of the sale.
   */
  const excess = (r: { total: number; paid: number; credited: number }) =>
    r.paid + r.credited - r.total;
  /**
   * A few rupees over is the rounding that runs through both books — five
   * invoices are between 2 and 539 rupees over-applied. Those clamp to zero.
   * Half an invoice over is an error, and the run stops.
   */
  const material = (r: { total: number; paid: number; credited: number }) =>
    excess(r) > Math.max(100, r.total * 0.005);
  const over = [...invoices, ...bills].filter(material);
  if (over.length) {
    console.log(`  OVER-APPLIED — more applied than the document is worth (${over.length}):`);
    for (const r of over) {
      console.log(
        `    ${r.number.padEnd(18)}${r.date}  ${r.party.slice(0, 24).padEnd(25)}` +
          `total ${money(r.total).padStart(11)}  applied ${money(r.paid + r.credited).padStart(11)}`,
      );
    }
    const detail = (
      await db.execute(sql`
        SELECT i.number AS doc, p.number AS receipt, p.payment_date::text AS date,
               p.amount::float8 AS amount, pa.amount_applied::float8 AS applied,
               (SELECT z.zoho_id FROM zoho_id_map z
                 WHERE z.entity = 'customer_payment' AND z.eggsy_id = p.id) AS zoho
          FROM invoices i
          JOIN payment_applications pa ON pa.invoice_id = i.id
          JOIN customer_payments p ON p.id = pa.payment_id
         WHERE i.number IN (${sql.join(over.map((r) => sql`${r.number}`), sql`, `)})
         ORDER BY i.number, p.payment_date, p.number
      `)
    ).rows as Array<{ doc: string; receipt: string; date: string; amount: number;
                      applied: number; zoho: string | null }>;
    console.log(`\n  what is applied to each:`);
    let last = "";
    for (const d of detail) {
      if (d.doc !== last) { console.log(`    ${d.doc}`); last = d.doc; }
      console.log(
        `      ${d.receipt.padEnd(22)}${d.date}  receipt ${money(d.amount).padStart(11)}` +
          `  applied here ${money(d.applied).padStart(11)}   ${d.zoho ? `zoho ${d.zoho}` : "raised in niko"}`,
      );
    }
    console.log(`\n  Refusing to write a negative balance. Settle these first.\n`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  if (!FIX) {
    console.log("  Dry run — nothing written. Re-run with --fix.\n");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE invoices i SET balance_due = greatest(round((i.total
        - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
        - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0))::numeric, 2), 0)
       WHERE i.status <> 'void'
    `);
    await tx.execute(sql`
      UPDATE bills b SET balance_due = greatest(round((b.total
        - coalesce((SELECT sum(amount_applied) FROM vendor_payment_applications WHERE bill_id = b.id), 0)
        - coalesce((SELECT sum(amount_applied) FROM vendor_credit_applications WHERE bill_id = b.id), 0))::numeric, 2), 0)
       WHERE b.status <> 'void'
    `);
  });
  console.log(`  Rewritten: ${invoices.length} invoice(s) and ${bills.length} bill(s) now say what their applications make them.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
