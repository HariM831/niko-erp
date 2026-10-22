/**
 * Put Zoho's figures on an invoice niko already holds, without rebuilding it.
 *
 *   npx tsx scripts/reprice-from-zoho.ts --dump <dir> A-INV-EG-27-0008 ...
 *   npx tsx scripts/reprice-from-zoho.ts --dump <dir> --all
 *   ... --commit
 *
 * The usual way to correct an amount is to unload the invoice and let the
 * loader write it again, which is how the seven corrections of 16 Oct were
 * done. That path is closed once anything else points at the document: a
 * dispatch records eggs that left the farm against this invoice and cannot be
 * moved to a new row, and an invoice with a dispatch refuses to be deleted
 * for exactly that reason.
 *
 * So this does the same job in place. The lines are written again from Zoho's
 * own, the totals follow, and the journal is reversed and re-posted on the
 * invoice's own date. What hangs off the invoice — its dispatch, its stock,
 * the receipts that settled it — keeps hanging off the same row.
 *
 * Thirteen invoices are a few rupees from Zoho's figure and three were
 * re-priced there after our snapshot; the user, 22 Oct 2026: "i need all
 * invoices to match zoho exactly".
 */
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { invoiceLines, invoices } from "@shared/schema";
import { postInvoiceJournal } from "../server/routes/sales";
import { reverseJournal } from "../server/services/posting";
import { db, pool } from "../server/db";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";
const COMMIT = process.argv.includes("--commit");
const ALL = process.argv.includes("--all");
const named = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== DIR);

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const P = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const R = (p: number) => (p / 100).toFixed(2);

interface ZLine { item_id?: string; name?: string; description?: string; quantity: number; rate: number; item_total: number }
interface Z { invoice_id: string; invoice_number: string; total: number; sub_total: number; line_items?: ZLine[] }

async function main() {
  const zoho = new Map<string, Z>();
  for (const line of readFileSync(`${DIR}/invoices.jsonl`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const z = JSON.parse(line) as Z;
    zoho.set(String(z.invoice_id), z);
  }

  const rows = (
    await db.execute(sql`
      SELECT i.id::text, i.number, i.invoice_date::text AS date, c.display_name AS party,
             i.total::float8 AS total, i.journal_entry_id::text AS je, i.status::text,
             (SELECT z.zoho_id FROM zoho_id_map z WHERE z.entity = 'invoice' AND z.eggsy_id = i.id) AS zoho
        FROM invoices i JOIN contacts c ON c.id = i.customer_id
       WHERE i.status NOT IN ('void', 'draft')
         ${named.length ? sql`AND i.number IN (${sql.join(named.map((n) => sql`${n}`), sql`, `)})` : sql``}
       ORDER BY i.invoice_date
    `)
  ).rows as Array<{ id: string; number: string; date: string; party: string; total: number;
                    je: string | null; status: string; zoho: string | null }>;

  const off = rows
    .map((r) => ({ r, z: r.zoho ? zoho.get(r.zoho) : undefined }))
    .filter((x) => x.z && Math.abs(P(x.z.total) - P(x.r.total)) > 0)
    .map((x) => ({ ...x, z: x.z! }));
  const todo = ALL || named.length ? off : [];

  console.log(`\n  ${off.length} invoice(s) differ from Zoho's figure — ${COMMIT ? "REPRICING" : "dry run"}\n`);
  for (const { r, z } of off) {
    console.log(
      `    ${r.number.padEnd(20)}${r.date}  ${r.party.slice(0, 24).padEnd(25)}` +
        `${money(r.total).padStart(14)} -> ${money(Number(z.total)).padStart(14)}` +
        `   ${(P(z.total) - P(r.total)) / 100 > 0 ? "+" : ""}${money((P(z.total) - P(r.total)) / 100)}`,
    );
  }
  if (!todo.length) {
    console.log(`\n  Name them, or pass --all, to reprice.\n`);
    await pool.end();
    return;
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

  for (const { r, z } of todo) {
    await db.transaction(async (tx) => {
      /**
       * The lines are rewritten rather than adjusted: a figure that moved by
       * thirty rupees may have moved in the rate, the quantity or a line that
       * is not there any more, and only Zoho's own lines say which.
       */
      const old = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, r.id));
      const keep = old[0];
      if (!keep) throw new Error(`${r.number} has no lines to rewrite`);
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, r.id));
      let order = 0;
      for (const l of z.line_items ?? []) {
        order += 1;
        await tx.insert(invoiceLines).values({
          invoiceId: r.id,
          itemId: keep.itemId,
          accountId: keep.accountId,
          name: l.name?.trim() || keep.name,
          description: l.description?.trim() || keep.description,
          hsnOrSac: keep.hsnOrSac,
          unit: keep.unit,
          quantity: String(l.quantity ?? 0),
          // Zoho carries rates to six decimals and a feed line rounded to
          // paise reads two thousand rupees away from its own amount.
          rate: String(l.rate ?? 0),
          amount: R(P(l.item_total)),
          taxAmount: "0.00",
          lineOrder: order,
        });
      }
      await tx
        .update(invoices)
        .set({
          subTotal: R(P(z.sub_total)),
          total: R(P(z.total)),
          balanceDue: R(P(z.total)),
          status: "sent",
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, r.id));

      if (r.je) await reverseJournal(tx, r.je, r.date, user.id);
      const fresh = (await tx.query.invoices.findFirst({ where: eq(invoices.id, r.id) }))!;
      const jeId = await postInvoiceJournal(tx, fresh, r.party, user.id);
      await tx.update(invoices).set({ journalEntryId: jeId }).where(eq(invoices.id, r.id));
      console.log(`    ${r.number}  ${money(r.total)} -> ${money(Number(z.total))}`);
    });
  }
  console.log(`\n  Repriced ${todo.length}. Their receipts need placing again.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
