/**
 * What has been done in the books lately, and by whom.
 *
 *   npx tsx scripts/recent-activity.ts
 *   npx tsx scripts/recent-activity.ts --hours 48
 *
 * When somebody says the team has started on something, the useful question
 * is whether their work has reached the database yet — a screen full of
 * unsaved changes looks the same from here as an empty afternoon. This counts
 * the documents and applications written in the last few hours beside the
 * ones written by the catch-up, so the two are not mistaken for each other.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const at = process.argv.indexOf("--hours");
const HOURS = at > -1 ? Number(process.argv[at + 1]) : 24;
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  console.log(`\n  The last ${HOURS} hours\n`);

  const rows = (
    await db.execute(sql`
      SELECT 'receipt' AS kind, p.number, p.created_at::text AS at, u.name AS who,
             p.amount::float8 AS amount, c.display_name AS party
        FROM customer_payments p
        LEFT JOIN users u ON u.id = p.created_by
        JOIN contacts c ON c.id = p.customer_id
       WHERE p.created_at > now() - ${`${HOURS} hours`}::interval
      UNION ALL
      SELECT 'invoice', i.number, i.created_at::text, u.name, i.total::float8, c.display_name
        FROM invoices i
        LEFT JOIN users u ON u.id = i.created_by
        JOIN contacts c ON c.id = i.customer_id
       WHERE i.created_at > now() - ${`${HOURS} hours`}::interval
       ORDER BY 3 DESC
    `)
  ).rows as Array<{ kind: string; number: string; at: string; who: string | null;
                    amount: number; party: string }>;

  const by = new Map<string, { n: number; value: number; kinds: Set<string> }>();
  for (const r of rows) {
    const k = r.who ?? "?";
    const cur = by.get(k) ?? { n: 0, value: 0, kinds: new Set<string>() };
    cur.n += 1;
    cur.value += r.amount;
    cur.kinds.add(r.kind);
    by.set(k, cur);
  }
  console.log(`  ${rows.length} document(s) written:`);
  for (const [who, v] of [...by].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${who.slice(0, 24).padEnd(25)}${String(v.n).padStart(5)}   Rs ${money(v.value).padStart(14)}   ${[...v.kinds].join(", ")}`);
  }
  if (!rows.length) console.log(`    none`);

  /**
   * The ones somebody keyed, named. The catch-up's own work is the noise here
   * and the team's is the signal, so the two are told apart by their author.
   */
  const byHand = rows.filter((r) => (r.who ?? "") !== "Zoho");
  if (byHand.length) {
    console.log(`
  keyed by hand:`);
    for (const r of byHand) {
      const applied = (
        await db.execute(sql`
          SELECT coalesce(sum(pa.amount_applied), 0)::float8 AS applied,
                 coalesce(string_agg(i.number || ' ' || round(pa.amount_applied::numeric)::text, ', '), '') AS against
            FROM payment_applications pa JOIN invoices i ON i.id = pa.invoice_id
            JOIN customer_payments p ON p.id = pa.payment_id
           WHERE p.number = ${r.number}
        `)
      ).rows[0] as { applied: number; against: string };
      console.log(
        `    ${r.at.slice(0, 16)}  ${r.number.padEnd(14)}${r.party.slice(0, 22).padEnd(23)}` +
          `${money(r.amount).padStart(12)}   ${applied.applied ? `against ${applied.against}` : "not applied to anything"}`,
      );
    }
  }

  const latest = (
    await db.execute(sql`
      SELECT a.created_at::text AS at, a.action, u.name AS who
        FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.created_at > now() - ${`${HOURS} hours`}::interval
       ORDER BY a.created_at DESC LIMIT 15
    `)
  ).rows as Array<{ at: string; action: string; who: string | null }>;
  console.log(`\n  the activity log, most recent first:`);
  for (const l of latest) {
    console.log(`    ${l.at.slice(0, 16)}  ${(l.who ?? "?").slice(0, 20).padEnd(21)}${l.action.slice(0, 60)}`);
  }
  if (!latest.length) console.log(`    nothing logged`);
  console.log();
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
