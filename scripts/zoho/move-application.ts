/**
 * Move a receipt's application from one invoice to another of the same customer.
 *
 *   npx tsx scripts/zoho/move-application.ts CP-2026-27/1001 A-INV-EG-27-0659 A-INV-EG-27-0668
 *   npx tsx scripts/zoho/move-application.ts ... --commit
 *
 * Zoho deleted the 22 August invoice for Tapan Saha and left its cash receipt
 * of 2,43,600 applied to the invoice before it, so Zoho's own A-INV-EG-27-0654
 * says it is paid while carrying 8,63,000 against a total of 6,19,400. niko
 * keeps that deleted invoice by decision, it is A-INV-EG-27-0668 after the
 * renumber, and it is open for exactly the receipt.
 *
 * Nothing moves in the ledger: the same customer owes the same money, and only
 * which sale the cash settles changes. Both invoices and the receipt must
 * belong to one customer, and the destination must have room.
 */
import { eq, sql } from "drizzle-orm";
import { paymentApplications } from "@shared/schema";
import { db, pool } from "../../server/db";

const [receiptNo, fromNo, toNo] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const COMMIT = process.argv.includes("--commit");

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  if (!receiptNo || !fromNo || !toNo) {
    console.error("Usage: move-application.ts <receipt> <from invoice> <to invoice> [--commit]");
    process.exitCode = 1;
    return;
  }

  const [row] = (
    await db.execute(sql`
      SELECT pa.id::text AS app_id, pa.amount_applied::float8 AS applied,
             p.customer_id::text AS payer, c.display_name AS cust,
             f.id::text AS from_id, f.customer_id::text AS from_cust,
             t.id::text AS to_id, t.customer_id::text AS to_cust, t.number AS to_number,
             t.total::float8 AS to_total, t.status::text AS to_status,
             coalesce((SELECT sum(x.amount_applied) FROM payment_applications x WHERE x.invoice_id = t.id), 0)::float8 AS to_applied
        FROM customer_payments p
        JOIN contacts c ON c.id = p.customer_id
        JOIN invoices f ON f.number = ${fromNo}
        JOIN invoices t ON t.number = ${toNo}
        JOIN payment_applications pa ON pa.payment_id = p.id AND pa.invoice_id = f.id
       WHERE p.number = ${receiptNo}
    `)
  ).rows as Array<{ app_id: string; applied: number; payer: string; cust: string;
                    from_id: string; from_cust: string; to_id: string; to_cust: string;
                    to_number: string; to_total: number; to_status: string; to_applied: number }>;

  if (!row) throw new Error(`${receiptNo} has nothing applied to ${fromNo}`);
  if (row.payer !== row.from_cust || row.payer !== row.to_cust)
    throw new Error(`${receiptNo}, ${fromNo} and ${toNo} are not all ${row.cust}'s`);
  if (row.to_status === "void") throw new Error(`${toNo} is void`);
  const room = row.to_total - row.to_applied;
  if (row.applied > room + 1) {
    // Say what is in the way. Usually it is the allocation pass, which filled
    // the invoice while this receipt was still sitting on the wrong one.
    const on = (
      await db.execute(sql`
        SELECT p.number, p.payment_date::text AS date, pa.amount_applied::float8 AS applied
          FROM payment_applications pa JOIN customer_payments p ON p.id = pa.payment_id
         WHERE pa.invoice_id = ${row.to_id}::uuid
         ORDER BY p.payment_date
      `)
    ).rows as Array<{ number: string; date: string; applied: number }>;
    console.log(`\n  ${toNo} already carries:`);
    for (const a of on) console.log(`    ${a.number.padEnd(20)}${a.date}  ${money(a.applied).padStart(11)}`);
    throw new Error(`${toNo} has room for ${money(room)}, not ${money(row.applied)}`);
  }

  console.log(
    `\n  ${receiptNo} — ${row.cust}\n` +
      `    Rs ${money(row.applied)} moves from ${fromNo} to ${toNo}, which is open for Rs ${money(room)}\n`,
  );
  if (!COMMIT) {
    console.log("  Dry run — nothing written. Re-run with --commit.\n");
    await pool.end();
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(paymentApplications)
      .set({ invoiceId: row.to_id })
      .where(eq(paymentApplications.id, row.app_id));
    await tx.execute(sql`
      UPDATE invoices i SET balance_due = greatest(round((i.total
        - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
        - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0))::numeric, 2), 0),
        status = CASE WHEN i.total
        - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
        - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0) <= 0 THEN 'paid'
        WHEN coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
           + coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0) > 0
        THEN 'partially_paid' ELSE 'sent' END::invoice_status
       WHERE i.id IN (${row.from_id}::uuid, ${row.to_id}::uuid)
    `);
  });
  console.log(`  Moved.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
