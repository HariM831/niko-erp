/**
 * One customer's account, here against Zoho's statement.
 *
 *   npx tsx scripts/check-customer-against-zoho.ts "Kamakhya Traders" --dump <dir>
 *
 * A statement is three numbers: invoiced, received, and the difference. If
 * niko and Zoho disagree on the third, exactly one of the first two is to
 * blame, and this says which — then names the documents one book holds and
 * the other does not.
 *
 * The sales side should agree to the rupee: since 22 Oct 2026 niko's invoices
 * ARE Zoho's, 1,029 of them, with Zoho's own dates. The receipts side is not
 * meant to agree. Zoho stopped on 15 October and niko has gone on recording
 * money since, so niko should show MORE received, never less — and a customer
 * reading Zoho's statement will see a balance that has been paid since.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";
const name = process.argv.slice(2).find((a) => !a.startsWith("--") && a !== DIR);

const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  if (!name) {
    console.error('Usage: check-customer-against-zoho.ts "<customer>" [--dump <dir>]');
    process.exitCode = 1;
    return;
  }
  const want = norm(name);
  const read = <T>(file: string) =>
    readFileSync(`${DIR}/${file}.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

  const zInv = read<{ invoice_id: string; invoice_number: string; date: string; customer_name?: string; total: number; status?: string }>("invoices")
    .filter((z) => norm(z.customer_name ?? "").startsWith(want) || want.startsWith(norm(z.customer_name ?? "")))
    .filter((z) => (z.status ?? "") !== "void");
  const zPay = read<{ payment_id: string; payment_number: string; date: string; customer_name?: string; amount: number }>("customerpayments")
    .filter((z) => norm(z.customer_name ?? "").startsWith(want) || want.startsWith(norm(z.customer_name ?? "")));

  const [here] = (
    await db.execute(sql`
      SELECT c.display_name AS party, c.id::text AS id,
             coalesce((SELECT sum(i.total) FROM invoices i
                        WHERE i.customer_id = c.id AND i.status NOT IN ('void', 'draft')), 0)::float8 AS billed,
             coalesce((SELECT count(*) FROM invoices i
                        WHERE i.customer_id = c.id AND i.status NOT IN ('void', 'draft')), 0)::int AS bills,
             coalesce((SELECT sum(p.amount) FROM customer_payments p WHERE p.customer_id = c.id), 0)::float8 AS got,
             coalesce((SELECT count(*) FROM customer_payments p WHERE p.customer_id = c.id), 0)::int AS receipts
        FROM contacts c
       WHERE lower(regexp_replace(c.display_name, '[^a-zA-Z0-9]', '', 'g')) = ${want}
       LIMIT 1
    `)
  ).rows as Array<{ party: string; id: string; billed: number; bills: number; got: number; receipts: number }>;
  if (!here) throw new Error(`no customer called ${name}`);

  const zBilled = zInv.reduce((s, z) => s + Number(z.total), 0);
  const zGot = zPay.reduce((s, z) => s + Number(z.amount), 0);

  console.log(`\n  ${here.party}\n`);
  console.log(`    ${"".padEnd(14)}${"niko".padStart(18)}${"Zoho".padStart(18)}${"difference".padStart(18)}`);
  const line = (label: string, a: number, b: number) =>
    console.log(`    ${label.padEnd(14)}${money(a).padStart(18)}${money(b).padStart(18)}${(Math.abs(a - b) < 0.5 ? "agree" : money(a - b)).padStart(18)}`);
  line("invoiced", here.billed, zBilled);
  line("received", here.got, zGot);
  line("balance", here.billed - here.got, zBilled - zGot);
  console.log(`    ${"documents".padEnd(14)}${`${here.bills} inv, ${here.receipts} rcpt`.padStart(18)}${`${zInv.length} inv, ${zPay.length} rcpt`.padStart(18)}`);

  const mineInv = (
    await db.execute(sql`
      SELECT i.number, i.invoice_date::text AS date, i.total::float8 AS total,
             (SELECT z.zoho_id FROM zoho_id_map z WHERE z.entity = 'invoice' AND z.eggsy_id = i.id) AS zoho
        FROM invoices i WHERE i.customer_id = ${here.id}::uuid AND i.status NOT IN ('void', 'draft')
       ORDER BY i.invoice_date
    `)
  ).rows as Array<{ number: string; date: string; total: number; zoho: string | null }>;
  const zInvIds = new Set(zInv.map((z) => String(z.invoice_id)));
  const extraInv = mineInv.filter((m) => !m.zoho || !zInvIds.has(m.zoho));
  const missingInv = zInv.filter((z) => !mineInv.some((m) => m.zoho === String(z.invoice_id)));
  if (extraInv.length || missingInv.length) {
    console.log(`\n    invoices that do not pair:`);
    for (const m of extraInv) console.log(`      only here   ${m.number.padEnd(20)}${m.date}  ${money(m.total)}`);
    for (const z of missingInv) console.log(`      only Zoho   ${z.invoice_number.padEnd(20)}${z.date}  ${money(Number(z.total))}`);
  } else {
    console.log(`\n    every invoice pairs, one to one.`);
  }

  const minePay = (
    await db.execute(sql`
      SELECT p.number, p.payment_date::text AS date, p.amount::float8 AS amount,
             (SELECT z.zoho_id FROM zoho_id_map z WHERE z.entity = 'customer_payment' AND z.eggsy_id = p.id) AS zoho
        FROM customer_payments p WHERE p.customer_id = ${here.id}::uuid
       ORDER BY p.payment_date
    `)
  ).rows as Array<{ number: string; date: string; amount: number; zoho: string | null }>;
  const zPayIds = new Set(zPay.map((z) => String(z.payment_id)));
  const extraPay = minePay.filter((m) => !m.zoho || !zPayIds.has(m.zoho));
  const missingPay = zPay.filter((z) => !minePay.some((m) => m.zoho === String(z.payment_id)));
  console.log(`\n    receipts here that Zoho has not got: ${extraPay.length}, Rs ${money(extraPay.reduce((s, m) => s + m.amount, 0))}`);
  for (const m of extraPay) console.log(`      ${m.number.padEnd(20)}${m.date}  ${money(m.amount).padStart(16)}`);
  if (missingPay.length) {
    console.log(`\n    receipts Zoho has and niko has not — these would be a hole:`);
    for (const z of missingPay) console.log(`      ${z.payment_number.padEnd(20)}${z.date}  ${money(Number(z.amount)).padStart(16)}`);
  } else {
    console.log(`\n    every Zoho receipt is here.`);
  }
  console.log();
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
