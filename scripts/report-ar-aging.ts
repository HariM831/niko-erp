/**
 * The AR Aging Summary, as the screen builds it.
 *
 *   npx tsx scripts/report-ar-aging.ts
 *   npx tsx scripts/report-ar-aging.ts --as-of 2026-10-15
 *
 * Same question the report asks — invoices that are 'sent' or 'partially_paid'
 * as at a date, bucketed by how far past due they are — so the figures here
 * are the figures on the screen, and both tie to receivables in the ledger.
 *
 * It exists because the screen's answer depends on a field the catch-up could
 * leave stale. The report reads STATUS, not the balance, so an invoice owing
 * money while still saying "paid" is missing from it entirely. That is what
 * the loaders left behind for the group: Zoho had applied their advances and
 * marked the invoices paid, niko holds those advances back by decision, and
 * the ageing quietly lost ₹34 crore until the statuses were derived again on
 * 21 Oct 2026.
 *
 * The group is in here and marked, settled 26 Sep 2026. Ageing is what an
 * accountant ties to the balance sheet, and most of what is owed is the two
 * LLPs: leaving them out makes the tie-out fail rather than make a point.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const asOfAt = process.argv.indexOf("--as-of");
const AS_OF = asOfAt > -1 ? process.argv[asOfAt + 1]! : new Date().toISOString().slice(0, 10);

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const BUCKETS = ["current", "1-15", "16-30", "31-45", "45+"] as const;

async function main() {
  const rows = (
    await db.execute(sql`
      SELECT c.display_name AS party, c.is_group_company AS grp,
             CASE WHEN i.due_date >= ${AS_OF}::date THEN 'current'
                  WHEN i.due_date >= ${AS_OF}::date - 15 THEN '1-15'
                  WHEN i.due_date >= ${AS_OF}::date - 30 THEN '16-30'
                  WHEN i.due_date >= ${AS_OF}::date - 45 THEN '31-45'
                  ELSE '45+' END AS bucket,
             sum(i.balance_due)::float8 AS amount
        FROM invoices i JOIN contacts c ON c.id = i.customer_id
       WHERE i.status IN ('sent', 'partially_paid') AND i.invoice_date <= ${AS_OF}::date
       GROUP BY 1, 2, 3
    `)
  ).rows as Array<{ party: string; grp: boolean; bucket: string; amount: number }>;

  const by = new Map<string, { grp: boolean; b: Record<string, number>; total: number }>();
  for (const r of rows) {
    const row = by.get(r.party) ?? { grp: r.grp, b: {}, total: 0 };
    row.b[r.bucket] = (row.b[r.bucket] ?? 0) + r.amount;
    row.total += r.amount;
    by.set(r.party, row);
  }
  const ordered = [...by.entries()].sort(
    (a, b) => Number(a[1].grp) - Number(b[1].grp) || b[1].total - a[1].total,
  );

  console.log(`\n  AR Aging Summary as at ${AS_OF}\n`);
  console.log(
    `    ${"customer".padEnd(30)}${BUCKETS.map((b) => b.padStart(14)).join("")}${"total".padStart(15)}`,
  );
  const line = (name: string, b: Record<string, number>, total: number) =>
    console.log(
      `    ${name.slice(0, 29).padEnd(30)}${BUCKETS.map((k) => money(b[k] ?? 0).padStart(14)).join("")}` +
        `${money(total).padStart(15)}`,
    );
  for (const [name, r] of ordered) line(name + (r.grp ? " *" : ""), r.b, r.total);

  const sum = (p: (g: boolean) => boolean) => {
    const b: Record<string, number> = {};
    let total = 0;
    for (const [, r] of ordered) {
      if (!p(r.grp)) continue;
      for (const k of BUCKETS) b[k] = (b[k] ?? 0) + (r.b[k] ?? 0);
      total += r.total;
    }
    return { b, total };
  };
  const all = sum(() => true), grp = sum((g) => g), trade = sum((g) => !g);
  console.log();
  line("TOTAL", all.b, all.total);
  line("  of which the group (*)", grp.b, grp.total);
  line("  everyone else", trade.b, trade.total);

  /** The same column the screen now carries, from the same two sources. */
  const credits = (
    await db.execute(sql`
      SELECT c.display_name AS party, c.is_group_company AS grp,
             (coalesce((SELECT sum(p.unapplied_amount) FROM customer_payments p
                         WHERE p.customer_id = c.id), 0)
            + coalesce((SELECT sum(n.balance) FROM credit_notes n
                         WHERE n.customer_id = c.id AND n.status NOT IN ('draft', 'void')), 0))::float8 AS unused
        FROM contacts c
    `)
  ).rows as Array<{ party: string; grp: boolean; unused: number }>;
  const held = credits.filter((c) => c.unused > 0.5);
  console.log(`
  Unused credits — money held against no document:`);
  for (const c of [...held].sort((a, b) => Number(a.grp) - Number(b.grp) || b.unused - a.unused)) {
    console.log(`    ${(c.party + (c.grp ? " *" : "")).slice(0, 29).padEnd(30)}${money(c.unused).padStart(14)}`);
  }
  const heldGroup = held.filter((c) => c.grp).reduce((s, c) => s + c.unused, 0);
  const heldTrade = held.filter((c) => !c.grp).reduce((s, c) => s + c.unused, 0);
  console.log(
    `    ${"TOTAL".padEnd(30)}${money(heldGroup + heldTrade).padStart(14)}` +
      `   group ${money(heldGroup)}   everyone else ${money(heldTrade)}`,
  );
  console.log(
    `
  Net of it: the group ${money(grp.total - heldGroup)}, everyone else ${money(trade.total - heldTrade)}`,
  );

  const [tie] = (
    await db.execute(sql`
      SELECT coalesce(sum(balance_due), 0)::float8 AS open
        FROM invoices WHERE status NOT IN ('void', 'draft')
    `)
  ).rows as Array<{ open: number }>;
  console.log(
    `\n  Open invoices in the book: Rs ${money(tie.open)}   ` +
      `${Math.abs(tie.open - all.total) < 1 ? "the ageing accounts for every rupee" : `the ageing is Rs ${money(tie.open - all.total)} short — an invoice is marked wrongly`}\n`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
