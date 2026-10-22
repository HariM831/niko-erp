/**
 * What each customer owes, from the documents.
 *
 *   npx tsx scripts/report-customer-balances.ts
 *   npx tsx scripts/report-customer-balances.ts --csv > customers.csv
 *
 * An invoice is owed what its applications leave on it, and a receipt not yet
 * put against a sale is money the customer has with us. Nothing here reads a
 * stored balance: both sides are derived, the way the user settled it on
 * 17 Oct 2026, and receivables agrees with this to the rupee.
 *
 * There are no credit sales here. A customer pays first and is invoiced the
 * same day or the next, so a balance is not credit given — it is either a
 * sale whose money has not been found yet, or a day's dispatches invoiced
 * before the morning's transfers were keyed. Age is printed for that reason:
 * anything more than two or three days old is worth asking about.
 *
 * Group companies are marked, not hidden. Their advances are unapplied by
 * decision, so they read as owing and holding at the same time.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const CSV = process.argv.includes("--csv");
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

interface Row {
  customer: string; group: boolean; invoices: number; billed: number; paid: number;
  credited: number; owed: number; advance: number; oldest: string | null; days: number | null;
}

async function main() {
  const rows = (
    await db.execute(sql`
      WITH open_invoices AS (
        SELECT i.customer_id, i.id, i.invoice_date, i.total::numeric AS total,
               coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)::numeric AS paid,
               coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0)::numeric AS credited
          FROM invoices i
         WHERE i.status NOT IN ('void', 'draft')
      )
      SELECT c.display_name AS customer, c.is_group_company AS group,
             count(o.id) FILTER (WHERE o.total - o.paid - o.credited > 0)::int AS invoices,
             coalesce(sum(o.total), 0)::float8 AS billed,
             coalesce(sum(o.paid), 0)::float8 AS paid,
             coalesce(sum(o.credited), 0)::float8 AS credited,
             coalesce(sum(greatest(o.total - o.paid - o.credited, 0)), 0)::float8 AS owed,
             coalesce((SELECT sum(p.unapplied_amount) FROM customer_payments p WHERE p.customer_id = c.id), 0)::float8 AS advance,
             min(o.invoice_date) FILTER (WHERE o.total - o.paid - o.credited > 0)::text AS oldest
        FROM contacts c
        LEFT JOIN open_invoices o ON o.customer_id = c.id
       GROUP BY c.id, c.display_name, c.is_group_company
      HAVING coalesce(sum(greatest(o.total - o.paid - o.credited, 0)), 0) <> 0
          OR coalesce((SELECT sum(p.unapplied_amount) FROM customer_payments p WHERE p.customer_id = c.id), 0) <> 0
       ORDER BY 7 DESC
    `)
  ).rows as Row[];

  const today = Date.now();
  for (const r of rows) {
    r.days = r.oldest ? Math.round((today - Date.parse(r.oldest)) / 86_400_000) : null;
  }

  if (CSV) {
    console.log("Customer,Group,Open invoices,Invoiced,Received,Credited,Owed,Held in advance,Net owed,Oldest open invoice,Days");
    for (const r of rows) {
      console.log(
        [`"${r.customer.replace(/"/g, '""')}"`, r.group ? "group" : "", r.invoices,
          r.billed.toFixed(2), r.paid.toFixed(2), r.credited.toFixed(2), r.owed.toFixed(2),
          r.advance.toFixed(2), (r.owed - r.advance).toFixed(2), r.oldest ?? "", r.days ?? ""].join(","),
      );
    }
    await pool.end();
    return;
  }

  console.log(`\n  Customer balances — ${rows.length} with something open\n`);
  console.log(
    `    ${"customer".padEnd(32)}${"open".padStart(5)}${"owed".padStart(15)}` +
      `${"in advance".padStart(14)}${"net".padStart(15)}   oldest`,
  );
  for (const r of rows) {
    console.log(
      `    ${(r.customer + (r.group ? " *" : "")).slice(0, 31).padEnd(32)}${String(r.invoices).padStart(5)}` +
        `${money(r.owed).padStart(15)}${money(r.advance).padStart(14)}${money(r.owed - r.advance).padStart(15)}` +
        `   ${r.oldest ?? "-"}${r.days ? ` (${r.days}d)` : ""}`,
    );
  }
  if (process.argv.includes("--invoices")) {
    /**
     * The sales still waiting, named, with the money that customer is holding
     * beside them. Two columns of one fact: what they owe on paper, and what
     * of theirs we already have but could not place under the rule — a
     * payment settles the invoice of its own day or the next, never one
     * before it.
     */
    const detail = (
      await db.execute(sql`
        SELECT c.display_name AS customer, c.is_group_company AS grp,
               i.number, i.invoice_date::text AS date,
               (i.total - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
                        - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0))::float8 AS owed,
               i.total::float8 AS total
          FROM invoices i JOIN contacts c ON c.id = i.customer_id
         WHERE i.status NOT IN ('void', 'draft')
           AND i.total - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
                       - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0) > 1
         ORDER BY c.display_name, i.invoice_date
      `)
    ).rows as Array<{ customer: string; grp: boolean; number: string; date: string; owed: number; total: number }>;
    const credit = new Map(rows.map((r) => [r.customer, r.advance]));
    console.log(`
  Unpaid invoices, and what that customer is holding
`);
    let last = "";
    for (const d of detail) {
      if (d.customer !== last) {
        const held = credit.get(d.customer) ?? 0;
        console.log(
          `
    ${(d.customer + (d.grp ? " *" : "")).padEnd(30)}${held ? `holds ${money(held)} unapplied` : "holds nothing"}`,
        );
        last = d.customer;
      }
      console.log(
        `      ${d.number.padEnd(20)}${d.date}  owes ${money(d.owed).padStart(13)}` +
          `${Math.abs(d.owed - d.total) > 1 ? `  of ${money(d.total)}` : ""}`,
      );
    }
    const inCreditOnly = rows.filter((r) => r.advance > 0 && !detail.some((d) => d.customer === r.customer));
    if (inCreditOnly.length) {
      console.log(`
    holding money with no unpaid invoice at all:`);
      for (const r of inCreditOnly.sort((a, b) => b.advance - a.advance)) {
        console.log(`      ${r.customer.padEnd(30)}${money(r.advance).padStart(13)}`);
      }
    }
    console.log();
  }

  const t = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  console.log(
    `\n    ${"TOTAL".padEnd(32)}${String(t((r) => r.invoices)).padStart(5)}${money(t((r) => r.owed)).padStart(15)}` +
      `${money(t((r) => r.advance)).padStart(14)}${money(t((r) => r.owed - r.advance)).padStart(15)}`,
  );
  const net = (set: Row[]) => set.reduce((s, r) => s + r.owed - r.advance, 0);
  console.log(
    `      the group (*) ${money(net(rows.filter((r) => r.group))).padStart(14)}` +
      `      everyone else ${money(net(rows.filter((r) => !r.group))).padStart(14)}`,
  );
  const recent = rows.filter((r) => !r.group && (r.days ?? 0) <= 3);
  console.log(
    `\n  Of what the trade owes, Rs ${money(recent.reduce((s, r) => s + r.owed, 0))} is on invoices three days old or less —\n` +
      `  the ordinary lag between a dispatch and the morning's transfer. The rest is worth asking about.\n`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
