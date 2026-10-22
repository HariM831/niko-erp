/**
 * Where a document came from, and what has happened to it since.
 *
 *   npx tsx scripts/trace-document.ts A-INV-EG-27-0826
 *
 * After a catch-up that renumbered 292 invoices, created 173 and voided four,
 * "where did this come from" stops being answerable by looking at the screen.
 * The number on it today may have belonged to a different sale three days ago.
 *
 * So this reads the provenance out of the record itself: who raised it and
 * when, whether it came from Zoho and under which number there, whether a
 * dispatch stands behind it — the eggs leaving the farm, which is the one
 * event no import can invent — what has been applied to it, and what it
 * posted to the ledger.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const number = process.argv.slice(2).find((a) => !a.startsWith("--"));
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  if (!number) {
    console.error("Usage: trace-document.ts <invoice or bill number>");
    process.exitCode = 1;
    return;
  }

  const [inv] = (
    await db.execute(sql`
      SELECT i.id::text, i.number, i.invoice_date::text AS date, i.due_date::text AS due,
             c.display_name AS party, i.total::float8 AS total, i.balance_due::float8 AS balance,
             i.status::text, i.created_at::text AS created, i.updated_at::text AS updated,
             u.name AS raised_by, u.username,
             (SELECT z.zoho_id || ' as ' || coalesce(z.label, '?') FROM zoho_id_map z
               WHERE z.entity = 'invoice' AND z.eggsy_id = i.id) AS zoho
        FROM invoices i
        JOIN contacts c ON c.id = i.customer_id
        LEFT JOIN users u ON u.id = i.created_by
       WHERE i.number = ${number}
    `)
  ).rows as Array<{ id: string; number: string; date: string; due: string; party: string;
                    total: number; balance: number; status: string; created: string; updated: string;
                    raised_by: string | null; username: string | null; zoho: string | null }>;
  if (!inv) throw new Error(`no invoice numbered ${number}`);

  console.log(`\n  ${inv.number}   ${inv.date}   ${inv.party}`);
  console.log(`    worth ${money(inv.total)}, owes ${money(inv.balance)}, ${inv.status}`);
  console.log(`    raised by ${inv.raised_by ?? "?"}${inv.username ? ` (${inv.username})` : ""} on ${inv.created.slice(0, 16)}`);
  if (inv.updated.slice(0, 10) !== inv.created.slice(0, 10)) {
    console.log(`    last changed ${inv.updated.slice(0, 16)}`);
  }
  console.log(`    ${inv.zoho ? `came from Zoho — ${inv.zoho}` : "no Zoho link: raised in niko"}`);

  const dispatches = (
    await db.execute(sql`
      SELECT d.id::text, d.dispatch_date::text AS date, d.status::text,
             d.created_at::text AS created, u.name AS by,
             d.driver_name, d.vehicle_number
        FROM egg_dispatches d LEFT JOIN users u ON u.id = d.loaded_by
       WHERE d.invoice_id = ${inv.id}::uuid
    `)
  ).rows as Array<{ id: string; date: string; status: string; created: string; by: string | null;
                    driver_name: string | null; vehicle_number: string | null }>;
  console.log(
    `    ${
      dispatches.length
        ? dispatches
            .map((d) => `dispatch ${d.date} (${d.status}), ${d.vehicle_number ?? "?"} / ${d.driver_name ?? "?"}, loaded by ${d.by ?? "?"} on ${d.created.slice(0, 16)}`)
            .join("; ")
        : "no dispatch behind it"
    }`,
  );

  const apps = (
    await db.execute(sql`
      SELECT p.number, p.payment_date::text AS date, pa.amount_applied::float8 AS applied,
             (SELECT z.zoho_id FROM zoho_id_map z
               WHERE z.entity = 'customer_payment' AND z.eggsy_id = p.id) AS zoho
        FROM payment_applications pa JOIN customer_payments p ON p.id = pa.payment_id
       WHERE pa.invoice_id = ${inv.id}::uuid
       ORDER BY p.payment_date
    `)
  ).rows as Array<{ number: string; date: string; applied: number; zoho: string | null }>;
  console.log(`\n    applied to it:`);
  for (const a of apps) {
    console.log(`      ${a.number.padEnd(20)}${a.date}  ${money(a.applied).padStart(12)}   ${a.zoho ? "from Zoho" : "raised here"}`);
  }
  if (!apps.length) console.log(`      nothing`);

  const je = (
    await db.execute(sql`
      SELECT j.entry_date::text AS date, j.narration, j.is_reversal,
             count(l.id)::int AS lines, j.created_at::text AS created
        FROM journal_entries j LEFT JOIN journal_entry_lines l ON l.entry_id = j.id
       WHERE j.source_type = 'invoice' AND j.source_id = ${inv.id}::uuid
       GROUP BY j.id, j.entry_date, j.narration, j.is_reversal, j.created_at
       ORDER BY j.created_at
    `)
  ).rows as Array<{ date: string; narration: string | null; is_reversal: boolean; lines: number; created: string }>;
  console.log(`\n    posted:`);
  for (const j of je) {
    console.log(`      ${j.date}  ${j.lines} line(s)${j.is_reversal ? "  REVERSAL" : ""}   ${(j.narration ?? "").slice(0, 52)}   written ${j.created.slice(0, 16)}`);
  }
  if (!je.length) console.log(`      nothing`);

  const log = (
    await db.execute(sql`
      SELECT a.created_at::text AS at, a.action, u.name AS by, a.details
        FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.details LIKE ${`%${number}%`}
       ORDER BY a.created_at LIMIT 10
    `)
  ).rows as Array<{ at: string; action: string; by: string | null; details: string }>;
  if (log.length) {
    console.log(`\n    the activity log mentions it:`);
    for (const r of log) {
      console.log(`      ${r.at.slice(0, 16)}  ${(r.by ?? "?").slice(0, 16).padEnd(17)}${r.action}`);
    }
  }
  console.log();
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
