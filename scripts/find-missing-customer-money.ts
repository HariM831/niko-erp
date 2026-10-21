/**
 * An invoice still open means the money is somewhere else.
 *
 *   npx tsx scripts/find-missing-customer-money.ts
 *   npx tsx scripts/find-missing-customer-money.ts --days 10
 *
 * The user, 21 Oct 2026: there cannot be any outstanding. Nothing here is sold
 * on credit — the customer pays and is invoiced the same day or the next — so
 * an invoice with a balance is not a debt. It is a payment this book has not
 * found, and it will be one of four things:
 *
 *   STILL ON THE STATEMENT. The deposit arrived and nobody categorized the
 *   line. It is sitting in bank_transactions, unmatched, with the amount on
 *   it.
 *
 *   AGAINST THE WRONG CUSTOMER. Two traders paid the same round sum within a
 *   day of each other and the receipt went to whichever name was typed first.
 *   The giveaway is a receipt whose own customer has no invoice it can settle
 *   while this one does.
 *
 *   PAID TO SOMEBODY ELSE'S ACCOUNT. Several of these customers are one
 *   family of shops; money comes in under a name that is not on the invoice.
 *
 *   NOT A SALE AT ALL. KRC & SR Associates has fifteen invoices over two
 *   hundred days old and has never paid a rupee, which is what a canteen
 *   deduction looks like when it is written as a sale.
 *
 * For each open invoice this prints what is nearby: statement lines nobody has
 * categorized, and receipts of the same money held by another customer. It
 * decides nothing and writes nothing — a match here is a question for somebody
 * who knows the trade, not a rule.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const daysAt = process.argv.indexOf("--days");
/** How far from the invoice to look for the money. */
const DAYS = daysAt > -1 ? Number(process.argv[daysAt + 1]) : 7;

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const open = (
    await db.execute(sql`
      SELECT i.id::text, i.number, i.invoice_date::text AS date, c.display_name AS cust,
             c.id::text AS cust_id, i.total::float8 AS total,
             (i.total - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
                      - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0))::float8 AS owed
        FROM invoices i JOIN contacts c ON c.id = i.customer_id
       WHERE i.status NOT IN ('void', 'draft') AND c.is_group_company = false
         AND i.total - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
                     - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0) > 1
       ORDER BY i.invoice_date, i.number
    `)
  ).rows as Array<{ id: string; number: string; date: string; cust: string; cust_id: string;
                    total: number; owed: number }>;

  console.log(`\n  ${open.length} trade invoice(s) still open, Rs ${money(open.reduce((s, r) => s + r.owed, 0))}\n`);

  /** Statement lines nobody has turned into anything. */
  const loose = (
    await db.execute(sql`
      SELECT t.id::text, t.txn_date::text AS date, t.amount::float8 AS amount,
             t.counterparty, t.description, t.match_status::text AS status, a.name AS bank
        FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id
       WHERE t.direction = 'credit' AND t.match_status <> 'matched'
       ORDER BY t.txn_date
    `)
  ).rows as Array<{ id: string; date: string; amount: number; counterparty: string | null;
                    description: string | null; status: string; bank: string }>;
  console.log(`  ${loose.length} deposit(s) on the statement that are not matched to anything,` +
    ` Rs ${money(loose.reduce((s, r) => s + r.amount, 0))}\n`);

  /** Money held by a customer who has nothing open for it to settle. */
  const spare = (
    await db.execute(sql`
      SELECT p.number, p.payment_date::text AS date, c.display_name AS cust, c.id::text AS cust_id,
             p.unapplied_amount::float8 AS spare, p.reference
        FROM customer_payments p JOIN contacts c ON c.id = p.customer_id
       WHERE p.unapplied_amount::numeric > 1 AND c.is_group_company = false
       ORDER BY p.payment_date
    `)
  ).rows as Array<{ number: string; date: string; cust: string; cust_id: string;
                    spare: number; reference: string | null }>;

  const near = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000) <= DAYS;
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(100, b * 0.01);

  for (const inv of open) {
    console.log(
      `  ${inv.number}  ${inv.date}  ${inv.cust}  —  owed ${money(inv.owed)} of ${money(inv.total)}`,
    );
    const lines = loose.filter((l) => near(l.date, inv.date) && (close(l.amount, inv.owed) || close(l.amount, inv.total)));
    for (const l of lines) {
      console.log(
        `      statement  ${l.date}  ${money(l.amount).padStart(11)}  ${l.bank.slice(0, 18).padEnd(19)}` +
          `${(l.counterparty ?? l.description ?? "").slice(0, 46)}`,
      );
    }
    const held = spare.filter(
      (s) => s.cust_id !== inv.cust_id && near(s.date, inv.date) && (close(s.spare, inv.owed) || close(s.spare, inv.total)),
    );
    for (const h of held) {
      console.log(
        `      held by    ${h.date}  ${money(h.spare).padStart(11)}  ${h.cust.slice(0, 18).padEnd(19)}` +
          `${h.number}  ${(h.reference ?? "").slice(0, 34)}`,
      );
    }
    if (!lines.length && !held.length) console.log(`      nothing of that size nearby`);
  }

  /**
   * The check to make before anybody keys these in. A deposit that is already
   * in the book under some number is not missing money — it is a statement
   * line nobody matched — and categorizing it would post the same money a
   * second time. That is how the catch-up nearly doubled Rs 8.80 crore.
   */
  const already = (
    await db.execute(sql`
      SELECT p.number, p.payment_date::text AS date, c.display_name AS cust,
             round(p.amount::numeric, 2)::float8 AS amount
        FROM customer_payments p JOIN contacts c ON c.id = p.customer_id
    `)
  ).rows as Array<{ number: string; date: string; cust: string; amount: number }>;

  console.log(
    `\n  Deposits nobody has categorized, whatever their size:` +
      ` ${loose.length}, Rs ${money(loose.reduce((s, r) => s + r.amount, 0))}`,
  );
  let risky = 0;
  for (const l of loose) {
    const twin = already.find((p) => Math.abs(p.amount - l.amount) <= 1 && near(p.date, l.date));
    if (twin) risky += 1;
    console.log(
      `    ${l.date}  ${money(l.amount).padStart(12)}  ${l.bank.slice(0, 20).padEnd(21)}` +
        `${(l.counterparty ?? l.description ?? "").slice(0, 40).padEnd(41)}` +
        `${twin ? `ALREADY IN as ${twin.number} (${twin.cust})` : ""}`,
    );
  }
  /**
   * The decisive figure. Which invoice a rupee settles is bookkeeping; whether
   * the customer has paid at all is not. If everything they have sent matches
   * everything they have been billed, an open invoice is only the allocation
   * standing one sale behind — the money is here. A real shortfall is money
   * that never arrived, or arrived under a name that is not theirs.
   */
  const ledger = (
    await db.execute(sql`
      SELECT c.display_name AS cust,
             coalesce((SELECT sum(i.total) FROM invoices i
                        WHERE i.customer_id = c.id AND i.status NOT IN ('void', 'draft')), 0)::float8 AS billed,
             coalesce((SELECT sum(n.total) FROM credit_notes n WHERE n.customer_id = c.id), 0)::float8 AS credited,
             coalesce((SELECT sum(p.amount) FROM customer_payments p WHERE p.customer_id = c.id), 0)::float8 AS got
        FROM contacts c
       WHERE c.is_group_company = false
         AND EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status NOT IN ('void', 'draft'))
       ORDER BY 2 DESC
    `)
  ).rows as Array<{ cust: string; billed: number; credited: number; got: number }>;
  const short = ledger.filter((l) => l.billed - l.credited - l.got > 1);
  console.log(
    `\n  Everything billed against everything received, all time:` +
      `\n    ${ledger.length - short.length} customer(s) have sent at least as much as they were billed` +
      `\n    ${short.length} have not, by Rs ${money(short.reduce((s, l) => s + l.billed - l.credited - l.got, 0))}\n`,
  );
  for (const l of short) {
    console.log(
      `    ${l.cust.slice(0, 26).padEnd(27)}billed ${money(l.billed).padStart(13)}` +
        `   received ${money(l.got).padStart(13)}` +
        `${l.credited ? `   credit notes ${money(l.credited)}` : ""}` +
        `   short ${money(l.billed - l.credited - l.got).padStart(12)}`,
    );
  }

  console.log(
    `\n  ${loose.length - risky} of them are money this book has never seen.` +
      `${risky ? ` ${risky} already exist under a receipt number — those are lines to MATCH, not to key again.` : ""}\n`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
