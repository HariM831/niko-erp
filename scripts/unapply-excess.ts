/**
 * Give back what was applied beyond a document's worth.
 *
 *   npx tsx scripts/unapply-excess.ts
 *   npx tsx scripts/unapply-excess.ts --commit
 *
 * A document cannot be settled by more than it is worth, and the excess is
 * not a balance to store — it is money the payer is still holding, or still
 * owed. BILL-002164 is Shreeram Chemicals' 1,04,841 of 17 September: niko
 * voided Zoho's copy on 30 September and re-raised it at that figure, while
 * Zoho's VP-2026-27/0988 settles 1,10,250 against it. The payment left the
 * bank at 1,24,962 either way, so the 5,409 is not an error in the cash — it
 * is five thousand of advance with the vendor.
 *
 * So the newest application is trimmed to fit and the difference goes back to
 * the payment's unapplied balance. The ledger follows: a payment debits
 * payables for what it settles and advances for what it does not, and that
 * split moves by the same amount. Nothing is invented and no figure is
 * asserted — the bill keeps the amount somebody decided on, and the money
 * keeps its total.
 *
 * Rounding of a few rupees is left alone: check-document-balances.ts stores
 * those as a zero balance, which is as true as a negative can be.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { postJournal } from "../server/services/posting";

const COMMIT = process.argv.includes("--commit");
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

interface Row {
  side: "invoice" | "bill"; doc: string; party: string; total: number; applied: number;
  app_id: string; payment: string; payment_id: string; app_amount: number; date: string;
}

async function main() {
  console.log(`\n  Applied beyond the document — ${COMMIT ? "TRIMMING" : "dry run"}\n`);

  const rows = (
    await db.execute(sql`
      WITH over AS (
        SELECT 'invoice' AS side, i.id, i.number AS doc, c.display_name AS party,
               i.total::float8 AS total,
               (SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id)::float8 AS applied
          FROM invoices i JOIN contacts c ON c.id = i.customer_id
         WHERE i.status <> 'void'
           AND (SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id)
               - i.total > greatest(100, i.total * 0.005)
        UNION ALL
        SELECT 'bill', b.id, b.number, c.display_name, b.total::float8,
               (SELECT sum(amount_applied) FROM vendor_payment_applications WHERE bill_id = b.id)::float8
          FROM bills b JOIN contacts c ON c.id = b.vendor_id
         WHERE b.status <> 'void'
           AND (SELECT sum(amount_applied) FROM vendor_payment_applications WHERE bill_id = b.id)
               - b.total > greatest(100, b.total * 0.005)
      )
      SELECT o.side, o.doc, o.party, o.total, o.applied,
             a.id::text AS app_id, a.number AS payment, a.payment_id::text,
             a.amount_applied::float8 AS app_amount, a.date::text
        FROM over o
        JOIN LATERAL (
          SELECT pa.id, p.number, pa.payment_id, pa.amount_applied, p.payment_date AS date
            FROM payment_applications pa JOIN customer_payments p ON p.id = pa.payment_id
           WHERE o.side = 'invoice' AND pa.invoice_id = o.id
          UNION ALL
          SELECT pa.id, p.number, pa.payment_id, pa.amount_applied, p.payment_date
            FROM vendor_payment_applications pa JOIN vendor_payments p ON p.id = pa.payment_id
           WHERE o.side = 'bill' AND pa.bill_id = o.id
          ORDER BY 5 DESC, 4 DESC LIMIT 1
        ) a ON TRUE
       ORDER BY o.applied - o.total DESC
    `)
  ).rows as Row[];

  if (!rows.length) {
    console.log("  Nothing is applied beyond what it is worth.\n");
    await pool.end();
    return;
  }
  for (const r of rows) {
    const excess = Math.round((r.applied - r.total) * 100) / 100;
    console.log(
      `    ${r.doc.padEnd(18)}${r.party.slice(0, 24).padEnd(25)}worth ${money(r.total).padStart(11)}` +
        `  applied ${money(r.applied).padStart(11)}   trim ${r.payment} by ${money(excess)}`,
    );
  }
  if (!COMMIT) {
    console.log(`\n  Dry run — nothing written. Re-run with --commit.\n`);
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'zoho' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("the zoho user is missing; the catch-up is recorded as that user");

  await db.transaction(async (tx) => {
    for (const r of rows) {
      const excess = Math.round((r.applied - r.total) * 100) / 100;
      const keep = (r.app_amount - excess).toFixed(2);
      if (r.side === "invoice") {
        await tx.execute(sql`UPDATE payment_applications SET amount_applied = ${keep}::numeric WHERE id = ${r.app_id}::uuid`);
        await tx.execute(sql`
          UPDATE customer_payments SET unapplied_amount = unapplied_amount + ${excess.toFixed(2)}::numeric
           WHERE id = ${r.payment_id}::uuid
        `);
        await postJournal(tx, {
          entryDate: r.date,
          narration: `${r.payment} — ${money(excess)} beyond ${r.doc}, held as an advance`,
          sourceType: "advance_application",
          sourceId: r.payment_id,
          postedBy: user.id,
          lines: [
            { systemKey: "ar", debit: excess.toFixed(2) },
            { systemKey: "customer_advances", credit: excess.toFixed(2) },
          ],
        });
      } else {
        await tx.execute(sql`UPDATE vendor_payment_applications SET amount_applied = ${keep}::numeric WHERE id = ${r.app_id}::uuid`);
        await tx.execute(sql`
          UPDATE vendor_payments SET unapplied_amount = unapplied_amount + ${excess.toFixed(2)}::numeric
           WHERE id = ${r.payment_id}::uuid
        `);
        /**
         * Nothing is posted here. A vendor payment debits payables for the
         * whole of itself whatever it settles — there is no second account
         * holding the unapplied part, the way customer advances holds it on
         * the selling side — so moving an application changes which bill is
         * settled and not one figure in the ledger.
         */
      }
    }
  });
  console.log(`\n  Trimmed ${rows.length} application(s); the money is the payer's advance now.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
