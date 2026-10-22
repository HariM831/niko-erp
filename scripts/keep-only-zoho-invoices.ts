/**
 * Leave exactly the invoices Zoho holds, and nothing else.
 *
 *   npx tsx scripts/keep-only-zoho-invoices.ts --dump <dir>
 *   npx tsx scripts/keep-only-zoho-invoices.ts --dump <dir> --commit
 *
 * Decided by the user on 22 Oct 2026: Zoho is the only source. niko carried
 * 1,050 live invoices against Zoho's 1,029 — the difference being six sales
 * imported from Amino, fourteen raised here, and three Zoho deleted while
 * niko kept them — and every one of those goes.
 *
 * In the other direction, two of Zoho's own invoices had been voided here on
 * 17 October as duplicates of the Puya sales niko had raised. Under this
 * decision it is the niko copies that are wrong, so Zoho's two come back.
 *
 * WHAT A VOID HAS TO UNDO. An invoice is not a row: it holds receipts, it
 * posted to the ledger, and an egg invoice took boxes out of stock through a
 * dispatch. So each one releases its receipts back to the customer's advances
 * — with the ledger entry that move needs — voids its dispatch, puts the
 * stock back, and reverses its journal on its own date, before it is marked
 * void. Anything whose stock day is locked is reported and left alone rather
 * than forced.
 *
 * The receipts are not touched beyond being unapplied: the money arrived and
 * the bank says so. Placing it against Zoho's invoices is the allocation
 * pass's job, run afterwards.
 */
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { invoices } from "@shared/schema";
import { postJournal, reverseJournal } from "../server/services/posting";
import { db, pool } from "../server/db";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";
const COMMIT = process.argv.includes("--commit");

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const zoho = new Set(
    readFileSync(`${DIR}/invoices.jsonl`, "utf8")
      .split("\n").filter((l) => l.trim())
      .map((l) => String((JSON.parse(l) as { invoice_id: string }).invoice_id)),
  );
  console.log(`\n  Zoho holds ${zoho.size} invoices — ${COMMIT ? "MAKING IT SO" : "dry run"}\n`);

  const all = (
    await db.execute(sql`
      SELECT i.id::text, i.number, i.invoice_date::text AS date, c.display_name AS party,
             i.total::float8 AS total, i.status::text, i.journal_entry_id::text AS je,
             (SELECT z.zoho_id FROM zoho_id_map z WHERE z.entity = 'invoice' AND z.eggsy_id = i.id) AS zoho,
             coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)::float8 AS applied,
             (SELECT count(*)::int FROM egg_dispatches d WHERE d.invoice_id = i.id AND d.status <> 'void') AS dispatches,
             (SELECT count(*)::int FROM inventory_transactions t
               WHERE t.source_type = 'invoice' AND t.source_id = i.id) AS stock,
             -- The same test dayLock() makes: a day that has been reopened
             -- since it was submitted is open, and the submission stays on
             -- the record rather than being erased.
             (SELECT count(*)::int FROM egg_stock_days s
               WHERE s.day = i.invoice_date AND s.submitted_at IS NOT NULL
                 AND NOT (s.reopened_at IS NOT NULL AND s.reopened_at > s.submitted_at)) AS day_locked
        FROM invoices i JOIN contacts c ON c.id = i.customer_id
       WHERE i.status <> 'draft'
       ORDER BY i.invoice_date, i.number
    `)
  ).rows as Array<{ id: string; number: string; date: string; party: string; total: number;
                    status: string; je: string | null; zoho: string | null; applied: number;
                    dispatches: number; stock: number; day_locked: number }>;

  /** Not Zoho's at all, or Zoho's only by a link to something it deleted. */
  const drop = all.filter((r) => r.status !== "void" && (!r.zoho || !zoho.has(r.zoho)));
  /** Zoho's own, voided here while a niko copy of the same sale was kept. */
  const restore = all.filter((r) => r.status === "void" && r.zoho && zoho.has(r.zoho));
  const keep = all.filter((r) => r.status !== "void" && r.zoho && zoho.has(r.zoho));

  console.log(`  keeping   ${String(keep.length).padStart(5)}   Zoho's own`);
  console.log(`  restoring ${String(restore.length).padStart(5)}   Zoho's own, voided here`);
  console.log(`  removing  ${String(drop.length).padStart(5)}   Rs ${money(drop.reduce((s, r) => s + r.total, 0))}\n`);
  for (const r of drop) {
    console.log(
      `    ${r.number.padEnd(20)}${r.date}  ${r.party.slice(0, 22).padEnd(23)}${money(r.total).padStart(12)}` +
        `  ${r.zoho ? "Zoho deleted it" : "never in Zoho"}` +
        `${r.applied ? `, releases ${money(r.applied)}` : ""}` +
        `${r.dispatches ? `, ${r.dispatches} dispatch` : ""}${r.stock ? `, ${r.stock} stock move` : ""}` +
        `${r.day_locked ? "   DAY LOCKED" : ""}`,
    );
  }
  for (const r of restore) {
    console.log(`    ${r.number.padEnd(20)}${r.date}  ${r.party.slice(0, 22).padEnd(23)}${money(r.total).padStart(12)}  comes back`);
  }

  /**
   * A submitted stock day cannot take its boxes back, and voiding the invoice
   * without them would leave the eggs sold with nothing recording the sale.
   * So the whole document is left alone until a Director reopens the day —
   * half-done is the one outcome worth refusing.
   */
  const blocked = drop.filter((r) => r.day_locked && (r.dispatches || r.stock));
  const doing = drop.filter((r) => !blocked.includes(r));
  if (blocked.length) {
    console.log(`\n  left alone — the stock day is submitted, reopen it and run again:`);
    for (const b of blocked) console.log(`    ${b.number}  ${b.date}  ${b.party}  ${money(b.total)}`);
  }
  console.log(
    `\n  afterwards: ${keep.length + restore.length + blocked.length} live invoices against Zoho's ${zoho.size}` +
      `${blocked.length ? ` (${blocked.length} still to go)` : ""}\n`,
  );

  if (!COMMIT) {
    console.log(`  Dry run — nothing written. Re-run with --commit.\n`);
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'zoho' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("the zoho user is missing; the catch-up is recorded as that user");

  for (const r of doing) {
    await db.transaction(async (tx) => {
      // The receipts go back to being the customer's money, and receivables
      // gives up what it was told those invoices had settled.
      const apps = (
        await tx.execute(sql`
          SELECT pa.id::text, pa.payment_id::text, pa.amount_applied::float8 AS amount
            FROM payment_applications pa WHERE pa.invoice_id = ${r.id}::uuid
        `)
      ).rows as Array<{ id: string; payment_id: string; amount: number }>;
      for (const a of apps) {
        await tx.execute(sql`DELETE FROM payment_applications WHERE id = ${a.id}::uuid`);
        await tx.execute(sql`
          UPDATE customer_payments SET unapplied_amount = unapplied_amount + ${a.amount.toFixed(2)}::numeric
           WHERE id = ${a.payment_id}::uuid
        `);
      }
      const released = apps.reduce((s, a) => s + a.amount, 0);
      if (released > 0) {
        await postJournal(tx, {
          entryDate: r.date,
          narration: `${r.number} removed — ${money(released)} back to advances`,
          sourceType: "advance_application",
          sourceId: r.id,
          postedBy: user.id,
          lines: [
            { systemKey: "ar", debit: released.toFixed(2) },
            { systemKey: "customer_advances", credit: released.toFixed(2) },
          ],
        });
      }

      if (r.stock && !r.day_locked) {
        // The boxes come back at the value they left at, filed against the
        // invoice so the day's stock statement adds up again.
        await tx.execute(sql`
          INSERT INTO inventory_transactions
                 (item_id, stock_location_id, quantity, value, transaction_date, source_type, source_id, notes)
          SELECT t.item_id, t.stock_location_id, -sum(t.quantity), -sum(t.value),
                 ${r.date}::date, 'invoice_void', ${r.id}::uuid, ${`Removed ${r.number}`}
            FROM inventory_transactions t
           WHERE t.source_type = 'invoice' AND t.source_id = ${r.id}::uuid
           GROUP BY t.item_id, t.stock_location_id
          HAVING sum(t.quantity) <> 0 OR sum(t.value) <> 0
        `);
      }
      if (r.dispatches) {
        await tx.execute(sql`UPDATE egg_dispatches SET status = 'void' WHERE invoice_id = ${r.id}::uuid`);
      }
      if (r.je) await reverseJournal(tx, r.je, r.date, user.id);
      await tx
        .update(invoices)
        .set({ status: "void", balanceDue: "0.00", updatedAt: new Date() })
        .where(eq(invoices.id, r.id));
      console.log(`    removed ${r.number}${released ? `, released ${money(released)}` : ""}`);
    });
  }

  for (const r of restore) {
    await db.transaction(async (tx) => {
      /**
       * Its posting was reversed when it was voided; the reversal is reversed
       * in turn rather than deleted, so the ledger carries the whole story.
       */
      const [rev] = (
        await tx.execute(sql`
          SELECT id::text FROM journal_entries
           WHERE source_type = 'invoice' AND source_id = ${r.id}::uuid AND is_reversal = true
           ORDER BY posted_at DESC LIMIT 1
        `)
      ).rows as Array<{ id: string }>;
      if (rev) await reverseJournal(tx, rev.id, r.date, user.id);
      await tx
        .update(invoices)
        .set({ status: "sent", balanceDue: r.total.toFixed(2), updatedAt: new Date() })
        .where(eq(invoices.id, r.id));
      console.log(`    restored ${r.number}`);
    });
  }
  console.log(
    `
  Removed ${doing.length}, restored ${restore.length}` +
      `${blocked.length ? `, left ${blocked.length} on a locked day` : ""}.
`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
