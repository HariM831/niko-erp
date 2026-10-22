/**
 * How many invoices niko holds, and where each of them came from.
 *
 *   npx tsx scripts/invoice-census.ts
 *   npx tsx scripts/invoice-census.ts --dump <dir>
 *
 * niko holds more invoices than Zoho, and it should. Zoho was one of the
 * places this business wrote its sales down, never all of them:
 *
 *   AMINO came first and ran until the go-live on 30 September 2026. Its
 *   sales were imported then, stamped with the inactive `replit` user, and
 *   most of them were never in Zoho at all.
 *
 *   ZOHO ran in parallel from January 2026 and stopped on 15 October. What it
 *   held was brought across by the catch-up and carries a zoho_id_map row.
 *
 *   NIKO ITSELF has raised every sale since the cutoff, and raised some
 *   alongside Zoho during the parallel weeks.
 *
 * So the question is never "why are there more" but "does each one belong to
 * exactly one of those three". This counts them that way, with the dump
 * beside it when there is one.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : undefined;
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const rows = (
    await db.execute(sql`
      SELECT CASE
               WHEN i.number LIKE 'A-INV-EG-%' THEN 'eggs'
               WHEN i.number LIKE 'A-INV-FD-%' THEN 'feed'
               WHEN i.number LIKE 'A-INV-BD-%' THEN 'birds'
               ELSE 'other' END AS series,
             CASE
               WHEN EXISTS (SELECT 1 FROM zoho_id_map z
                             WHERE z.entity = 'invoice' AND z.eggsy_id = i.id) THEN 'from Zoho'
               WHEN u.username = 'replit' THEN 'imported from Amino'
               ELSE 'raised in niko' END AS origin,
             i.status::text AS status,
             count(*)::int AS n,
             sum(i.total)::float8 AS value,
             min(i.invoice_date)::text AS first,
             max(i.invoice_date)::text AS last
        FROM invoices i LEFT JOIN users u ON u.id = i.created_by
       GROUP BY 1, 2, 3
       ORDER BY 1, 2, 3
    `)
  ).rows as Array<{ series: string; origin: string; status: string; n: number;
                    value: number; first: string; last: string }>;

  const live = rows.filter((r) => r.status !== "void" && r.status !== "draft");
  console.log(`\n  niko holds ${live.reduce((s, r) => s + r.n, 0)} invoices that count` +
    `${rows.length > live.length ? `, and ${rows.filter((r) => !live.includes(r)).reduce((s, r) => s + r.n, 0)} void or draft` : ""}\n`);
  console.log(`    ${"series".padEnd(8)}${"where it came from".padEnd(22)}${"count".padStart(7)}${"value".padStart(16)}   span`);
  // Status is only read to tell a live invoice from a void one; a census of
  // origins should not be split three ways by whether the money has arrived.
  const folded = new Map<string, { series: string; origin: string; n: number; value: number; first: string; last: string }>();
  for (const r of live) {
    const key = `${r.series}|${r.origin}`;
    const cur = folded.get(key) ?? { series: r.series, origin: r.origin, n: 0, value: 0, first: r.first, last: r.last };
    cur.n += r.n;
    cur.value += r.value;
    if (r.first < cur.first) cur.first = r.first;
    if (r.last > cur.last) cur.last = r.last;
    folded.set(key, cur);
  }
  for (const r of [...folded.values()].sort((a, b) => b.n - a.n)) {
    console.log(
      `    ${r.series.padEnd(8)}${r.origin.padEnd(22)}${String(r.n).padStart(7)}${money(r.value).padStart(16)}` +
        `   ${r.first} .. ${r.last}`,
    );
  }
  for (const r of rows.filter((r) => !live.includes(r))) {
    console.log(`    ${r.series.padEnd(8)}${`${r.origin} (${r.status})`.padEnd(22)}${String(r.n).padStart(7)}${money(r.value).padStart(16)}`);
  }

  /**
   * Everything that is not Zoho's, named. If Zoho is to be the only source
   * these are the rows that go, and what is applied to them is what has to be
   * dealt with first.
   */
  const outsiders = (
    await db.execute(sql`
      SELECT i.number, i.invoice_date::text AS date, c.display_name AS party,
             i.total::float8 AS total, i.status::text,
             CASE WHEN u.username = 'replit' THEN 'Amino' ELSE 'niko' END AS origin,
             coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)::float8 AS applied,
             (SELECT count(*)::int FROM egg_dispatches d WHERE d.invoice_id = i.id AND d.status <> 'void') AS dispatches
        FROM invoices i
        JOIN contacts c ON c.id = i.customer_id
        LEFT JOIN users u ON u.id = i.created_by
       WHERE i.status NOT IN ('void', 'draft')
         AND NOT EXISTS (SELECT 1 FROM zoho_id_map z WHERE z.entity = 'invoice' AND z.eggsy_id = i.id)
       ORDER BY i.invoice_date
    `)
  ).rows as Array<{ number: string; date: string; party: string; total: number; status: string;
                    origin: string; applied: number; dispatches: number }>;
  console.log(`
  not Zoho's — ${outsiders.length}, Rs ${money(outsiders.reduce((s, r) => s + r.total, 0))}:`);
  for (const o of outsiders) {
    console.log(
      `    ${o.number.padEnd(20)}${o.date}  ${o.party.slice(0, 24).padEnd(25)}${money(o.total).padStart(12)}` +
        `  ${o.origin.padEnd(6)}${o.applied ? `applied ${money(o.applied)}` : "nothing applied"}` +
        `${o.dispatches ? `, ${o.dispatches} dispatch` : ""}`,
    );
  }

  /** A Zoho invoice whose only counterpart here is void is a sale now missing. */
  const voided = (
    await db.execute(sql`
      SELECT i.number, i.invoice_date::text AS date, c.display_name AS party,
             i.total::float8 AS total, z.label AS zoho
        FROM invoices i
        JOIN zoho_id_map z ON z.entity = 'invoice' AND z.eggsy_id = i.id
        JOIN contacts c ON c.id = i.customer_id
       WHERE i.status = 'void'
    `)
  ).rows as Array<{ number: string; date: string; party: string; total: number; zoho: string | null }>;
  if (voided.length) {
    console.log(`
  Zoho invoices whose niko copy is void — the sale is only here as a non-Zoho row:`);
    for (const v of voided) {
      console.log(`    ${v.number.padEnd(20)}${v.date}  ${v.party.slice(0, 24).padEnd(25)}${money(v.total).padStart(12)}   zoho ${v.zoho ?? "?"}`);
    }
  }

  if (!DIR) {
    console.log(`\n  Pass --dump <dir> to count Zoho's side beside it.\n`);
    await pool.end();
    return;
  }
  const zoho = readFileSync(`${DIR}/invoices.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { invoice_number: string; status?: string; total: number });
  const zLive = zoho.filter((z) => (z.status ?? "") !== "void");
  const linked = live.filter((r) => r.origin === "from Zoho").reduce((s, r) => s + r.n, 0);
  console.log(`\n  Zoho holds ${zLive.length} invoices; ${linked} of niko's are linked to one.`);
  /**
   * Zoho rows with nothing here would be a hole in the catch-up; the other
   * direction is ordinary and is the answer to "why are there more".
   */
  const mapped = new Set(
    ((
      await db.execute(sql`SELECT zoho_id FROM zoho_id_map WHERE entity = 'invoice'`)
    ).rows as Array<{ zoho_id: string }>).map((r) => r.zoho_id),
  );
  const orphans = zoho.filter((z) => !mapped.has(String((z as unknown as { invoice_id: string }).invoice_id)));
  console.log(
    `  ${orphans.length} Zoho invoice(s) have no counterpart here` +
      `${orphans.length ? `: ${orphans.slice(0, 8).map((o) => o.invoice_number).join(", ")}` : ""}\n`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
