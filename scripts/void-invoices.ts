/**
 * Void named invoices that should never have existed.
 *
 *   npx tsx scripts/void-invoices.ts <file of numbers>
 *   npx tsx scripts/void-invoices.ts <file of numbers> --commit
 *
 * Four sales were written twice, once in each book, because one party was held
 * under two customer records and because the catch-up matched on the customer
 * name: PUYA MARKETING is not M/s Puya by any spelling, and the two copies of
 * the 7 October sale were 1.7 per cent apart in value as well.
 *
 * The copy to keep is the one the money is against; the empty one goes. It is
 * VOIDED, not removed: the number stays in the series where somebody can see
 * what happened to it, and the Zoho link stays with it so a loader can never
 * bring the same invoice in again.
 *
 * This is the invoice void from the Sales screen, narrowed to the case it is
 * safe to run in bulk — nothing applied, no dispatch, nothing in stock. Any
 * invoice that fails those is named and left for the screen, where the
 * dispatch and the boxes are handled properly.
 *
 * The reversal is dated to the invoice's own day, so no month in between is
 * disturbed by a document that was never a sale.
 */
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { invoices } from "@shared/schema";
import { reverseJournal } from "../server/services/posting";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const onAt = process.argv.indexOf("--on");
const ON = onAt > -1 ? process.argv[onAt + 1]! : undefined;

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  if (!file) {
    console.error("Usage: void-invoices.ts <file of niko invoice numbers> [--on YYYY-MM-DD] [--commit]");
    process.exitCode = 1;
    return;
  }
  const numbers = [...new Set(
    readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
  )];
  console.log(`\n  ${numbers.length} invoice(s) from ${file} — ${COMMIT ? "VOIDING" : "dry run"}\n`);

  const rows = (
    await db.execute(sql`
      SELECT i.id::text, i.number, i.invoice_date::text AS date, c.display_name AS cust,
             i.total::float8 AS total, i.status::text, i.journal_entry_id::text AS je,
             coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)::float8 AS paid,
             coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0)::float8 AS credited,
             (SELECT count(*)::int FROM egg_dispatches d WHERE d.invoice_id = i.id AND d.status <> 'void') AS dispatches,
             (SELECT count(*)::int FROM inventory_transactions t
               WHERE t.source_type = 'invoice' AND t.source_id = i.id) AS stock
        FROM invoices i JOIN contacts c ON c.id = i.customer_id
       WHERE i.number IN (${sql.join(numbers.map((n) => sql`${n}`), sql`, `)})
       ORDER BY i.number
    `)
  ).rows as Array<{ id: string; number: string; date: string; cust: string; total: number;
                    status: string; je: string | null; paid: number; credited: number;
                    dispatches: number; stock: number }>;

  const missing = numbers.filter((n) => !rows.some((r) => r.number === n));
  if (missing.length) console.log(`  not found: ${missing.join(", ")}\n`);

  const stop = rows.filter((r) => r.paid + r.credited > 0 || r.dispatches > 0 || r.stock > 0);
  const go = rows.filter((r) => !stop.includes(r) && r.status !== "void");
  for (const r of rows) {
    const why = r.status === "void" ? "already void"
      : r.paid + r.credited > 0 ? `Rs ${money(r.paid + r.credited)} applied — unapply it first`
      : r.dispatches ? "has a dispatch — void it on the Sales screen"
      : r.stock ? "moved stock — void it on the Sales screen"
      : "void it";
    console.log(
      `    ${r.number.padEnd(20)}${r.date}  ${r.cust.slice(0, 24).padEnd(25)}${money(r.total).padStart(12)}` +
        `  ${r.status.padEnd(15)}${why}`,
    );
  }
  console.log();

  if (stop.length) {
    console.log(`  ${stop.length} cannot be voided here. Nothing is written until they are settled.\n`);
    process.exitCode = 1;
    await pool.end();
    return;
  }
  if (!go.length) {
    console.log("  Nothing to do.\n");
    await pool.end();
    return;
  }
  if (!COMMIT) {
    console.log(`  Dry run — nothing written. ${go.length} would be voided.\n`);
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'zoho' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("the zoho user is missing; the catch-up is recorded as that user");

  await db.transaction(async (tx) => {
    for (const r of go) {
      if (r.je) await reverseJournal(tx, r.je, ON ?? r.date, user.id);
      await tx
        .update(invoices)
        .set({ status: "void", balanceDue: "0.00", updatedAt: new Date() })
        .where(eq(invoices.id, r.id));
    }
  });
  console.log(`  Voided ${go.length} invoice(s), each reversed on ${ON ?? "its own date"}.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
