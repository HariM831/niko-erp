/**
 * Take every receipt off an invoice, so the invoice can be rebuilt.
 *
 *   npx tsx scripts/unapply-invoice.ts A-INV-EG-27-0857
 *   npx tsx scripts/unapply-invoice.ts A-INV-EG-27-0857 --commit
 *
 * An amount cannot be corrected in place: the lines and the journal have to
 * be written again, which is the loader's job. But an invoice with a receipt
 * against it refuses to be unloaded, and rightly — deleting the application
 * would leave the receipt's own posting claiming to have settled something
 * that no longer exists.
 *
 * Unloading the receipts instead is not always possible either: one raised
 * here has nothing to reload it from. So this does the smaller thing. The
 * money goes back to being the customer's, held as an advance, and the
 * allocation pass puts it where it belongs once the invoice has been rebuilt.
 *
 * Receivables gives up what those applications claimed to have settled, which
 * is the entry the invoice screen makes when an advance is handed back.
 */
import { sql } from "drizzle-orm";
import { postJournal } from "../server/services/posting";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const numbers = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  if (!numbers.length) {
    console.error("Usage: unapply-invoice.ts <invoice numbers> [--commit]");
    process.exitCode = 1;
    return;
  }
  const rows = (
    await db.execute(sql`
      SELECT i.id::text AS invoice_id, i.number, i.invoice_date::text AS date,
             c.display_name AS party, pa.id::text AS app_id,
             pa.payment_id::text, p.number AS receipt, pa.amount_applied::float8 AS amount
        FROM invoices i
        JOIN contacts c ON c.id = i.customer_id
        JOIN payment_applications pa ON pa.invoice_id = i.id
        JOIN customer_payments p ON p.id = pa.payment_id
       WHERE i.number IN (${sql.join(numbers.map((n) => sql`${n}`), sql`, `)})
       ORDER BY i.number, p.payment_date
    `)
  ).rows as Array<{ invoice_id: string; number: string; date: string; party: string;
                    app_id: string; payment_id: string; receipt: string; amount: number }>;

  console.log(`\n  ${rows.length} application(s) to release — ${COMMIT ? "RELEASING" : "dry run"}\n`);
  for (const r of rows) {
    console.log(`    ${r.number.padEnd(20)}${r.date}  ${r.party.slice(0, 22).padEnd(23)}` +
      `${r.receipt.padEnd(20)}${money(r.amount).padStart(12)}`);
  }
  if (!rows.length || !COMMIT) {
    console.log(`\n  ${rows.length ? "Dry run — nothing written. Re-run with --commit." : "Nothing applied to those."}\n`);
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'zoho' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("the zoho user is missing; the catch-up is recorded as that user");

  await db.transaction(async (tx) => {
    for (const r of rows) {
      await tx.execute(sql`DELETE FROM payment_applications WHERE id = ${r.app_id}::uuid`);
      await tx.execute(sql`
        UPDATE customer_payments SET unapplied_amount = unapplied_amount + ${r.amount.toFixed(2)}::numeric
         WHERE id = ${r.payment_id}::uuid
      `);
      await postJournal(tx, {
        entryDate: r.date,
        narration: `${r.receipt} taken off ${r.number}, held as an advance`,
        sourceType: "advance_application",
        sourceId: r.payment_id,
        postedBy: user.id,
        lines: [
          { systemKey: "ar", debit: r.amount.toFixed(2) },
          { systemKey: "customer_advances", credit: r.amount.toFixed(2) },
        ],
      });
    }
    await tx.execute(sql`
      UPDATE invoices i SET balance_due = round(i.total::numeric, 2), status = 'sent'
       WHERE i.number IN (${sql.join(numbers.map((n) => sql`${n}`), sql`, `)})
    `);
  });
  console.log(`\n  Released ${money(rows.reduce((s, r) => s + r.amount, 0))} back to advances.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
