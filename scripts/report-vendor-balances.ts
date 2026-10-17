/**
 * What each vendor is owed, from the documents.
 *
 *   npx tsx scripts/report-vendor-balances.ts
 *   npx tsx scripts/report-vendor-balances.ts --csv > vendors.csv
 *
 * A vendor's balance is their open bills, less what has been paid against
 * them, less any vendor credit, less money paid and not yet put against a
 * bill. Every figure here is derived from the applications, the way
 * check-document-balances.ts settled on 17 Oct 2026 — nothing reads a stored
 * balance.
 *
 * READ THE WARNING THE REPORT PRINTS. The 224 vendor payments still sitting
 * in Zoho have not been brought across, so payables is overstated until they
 * are: the control account and the documents are 27,75,013 apart on
 * production on 17 Oct 2026, and that gap is the purchase side of the
 * catch-up, not an error in the figures below.
 *
 * Group companies are marked rather than hidden. Nandamuri and Luit are the
 * group's own, and their intra-group bills are a different question from a
 * trade payable.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const CSV = process.argv.includes("--csv");
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

interface Row {
  vendor: string; group: boolean; bills: number; billed: number; paid: number;
  credited: number; owed: number; advance: number; oldest: string | null; days: number | null;
}

async function main() {
  const rows = (
    await db.execute(sql`
      WITH open_bills AS (
        SELECT b.vendor_id, b.id, b.bill_date, b.total::numeric AS total,
               coalesce((SELECT sum(amount_applied) FROM vendor_payment_applications WHERE bill_id = b.id), 0)::numeric AS paid,
               coalesce((SELECT sum(amount_applied) FROM vendor_credit_applications WHERE bill_id = b.id), 0)::numeric AS credited
          FROM bills b
         WHERE b.status NOT IN ('void', 'draft')
      )
      SELECT c.display_name AS vendor, c.is_group_company AS group,
             count(o.id) FILTER (WHERE o.total - o.paid - o.credited > 0)::int AS bills,
             coalesce(sum(o.total), 0)::float8 AS billed,
             coalesce(sum(o.paid), 0)::float8 AS paid,
             coalesce(sum(o.credited), 0)::float8 AS credited,
             coalesce(sum(greatest(o.total - o.paid - o.credited, 0)), 0)::float8 AS owed,
             coalesce((SELECT sum(p.unapplied_amount) FROM vendor_payments p WHERE p.vendor_id = c.id), 0)::float8 AS advance,
             min(o.bill_date) FILTER (WHERE o.total - o.paid - o.credited > 0)::text AS oldest
        FROM contacts c
        LEFT JOIN open_bills o ON o.vendor_id = c.id
       GROUP BY c.id, c.display_name, c.is_group_company
      HAVING coalesce(sum(greatest(o.total - o.paid - o.credited, 0)), 0) <> 0
          OR coalesce((SELECT sum(p.unapplied_amount) FROM vendor_payments p WHERE p.vendor_id = c.id), 0) <> 0
       ORDER BY 7 DESC
    `)
  ).rows as Row[];

  const today = Date.now();
  for (const r of rows) {
    r.days = r.oldest ? Math.round((today - Date.parse(r.oldest)) / 86_400_000) : null;
  }

  if (CSV) {
    console.log("Vendor,Group,Open bills,Billed,Paid,Credited,Owed,Paid in advance,Net owed,Oldest open bill,Days");
    for (const r of rows) {
      console.log(
        [`"${r.vendor.replace(/"/g, '""')}"`, r.group ? "group" : "", r.bills,
          r.billed.toFixed(2), r.paid.toFixed(2), r.credited.toFixed(2), r.owed.toFixed(2),
          r.advance.toFixed(2), (r.owed - r.advance).toFixed(2), r.oldest ?? "", r.days ?? ""].join(","),
      );
    }
    await pool.end();
    return;
  }

  console.log(`\n  Vendor balances — ${rows.length} with something open\n`);
  console.log(
    `    ${"vendor".padEnd(34)}${"open".padStart(5)}${"owed".padStart(15)}` +
      `${"in advance".padStart(14)}${"net".padStart(15)}   oldest`,
  );
  for (const r of rows) {
    console.log(
      `    ${(r.vendor + (r.group ? " *" : "")).slice(0, 33).padEnd(34)}${String(r.bills).padStart(5)}` +
        `${money(r.owed).padStart(15)}${money(r.advance).padStart(14)}${money(r.owed - r.advance).padStart(15)}` +
        `   ${r.oldest ?? "-"}${r.days ? ` (${r.days}d)` : ""}`,
    );
  }
  const t = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  console.log(
    `\n    ${"TOTAL".padEnd(34)}${String(t((r) => r.bills)).padStart(5)}${money(t((r) => r.owed)).padStart(15)}` +
      `${money(t((r) => r.advance)).padStart(14)}${money(t((r) => r.owed - r.advance)).padStart(15)}`,
  );
  const net = (set: Row[]) => set.reduce((s, r) => s + r.owed - r.advance, 0);
  console.log(
    `      the group (*) ${money(net(rows.filter((r) => r.group))).padStart(14)}` +
      `      everyone else ${money(net(rows.filter((r) => !r.group))).padStart(14)}`,
  );
  console.log(
    `\n  From the documents: a bill is owed what its applications leave on it. The\n` +
      `  purchase side came across from Zoho on 17 Oct 2026 and every vendor payment\n` +
      `  is allocated as Zoho has it. See docs/zoho-catchup-runbook.md.\n`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
