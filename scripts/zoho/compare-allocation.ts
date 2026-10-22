/**
 * Which bill each vendor payment settles, here against Zoho.
 *
 *   npx tsx scripts/zoho/compare-vendor-allocation.ts --dump <dir>
 *   npx tsx scripts/zoho/compare-vendor-allocation.ts --dump <dir> --list
 *
 * The user settled this for the money coming in on 16 Oct 2026: Zoho wins on
 * allocation. The cash and the party's balance already agree on both sides;
 * only which document each rupee settles differs. The same holds going out,
 * and the purchase side has never been through it.
 *
 * It shows up as a bill with more against it than it is worth. BILL-002083 is
 * Vastech Constructions' 2,96,180 of 8 September 2026, and niko has 2,96,180
 * of two August 2025 advances on it as well as the September payment Zoho
 * applied. In Zoho those two advances are spent entirely on 2025 bills that
 * niko never imported — so the earlier load, finding nowhere to put them, put
 * them somewhere.
 *
 * This only reports, and `--list` prints the payment numbers for
 * unload-selected. A payment Zoho applies to a bill niko does not have is
 * named separately: re-loading that one cannot improve it, and it is a bill
 * to bring across, not an allocation to fix.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../../server/db";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";
const LIST = process.argv.includes("--list");
/** The same question of the money coming in. Zoho wins there too. */
const CUSTOMER = process.argv.includes("--customer");
const SIDE = CUSTOMER
  ? { file: "customerpayments", docs: "invoices", entity: "customer_payment", word: "receipt" }
  : { file: "vendorpayments", docs: "bills", entity: "vendor_payment", word: "payment" };

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

interface Z {
  payment_id: string; payment_number: string; date: string; vendor_name?: string;
  amount: number; bills?: Array<{ bill_id: string; bill_number?: string; amount_applied: number }>;
}

async function main() {
  const zoho = new Map<string, Z>();
  for (const line of readFileSync(`${DIR}/${SIDE.file}.jsonl`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const z = JSON.parse(line) as Z;
    zoho.set(String(z.payment_id), z);
  }

  /** Every Zoho bill id niko holds, so "we do not have it" is a fact, not a guess. */
  const billHere = new Map(
    ((
      await db.execute(sql`SELECT zoho_id, eggsy_id::text FROM zoho_id_map WHERE entity = ${CUSTOMER ? "invoice" : "bill"}`)
    ).rows as Array<{ zoho_id: string; eggsy_id: string }>).map((r) => [r.zoho_id, r.eggsy_id]),
  );

  const here = (
    await db.execute(sql`
      SELECT z.zoho_id, p.number, p.payment_date::text AS date, c.display_name AS vendor,
             p.amount::float8 AS amount,
             coalesce((
               SELECT json_agg(json_build_object('bill', b.id::text, 'amount', round(pa.amount_applied::numeric, 2)))
                 FROM ${CUSTOMER ? sql`payment_applications` : sql`vendor_payment_applications`} pa
                 JOIN ${CUSTOMER ? sql`invoices` : sql`bills`} b
                   ON b.id = ${CUSTOMER ? sql`pa.invoice_id` : sql`pa.bill_id`}
                WHERE pa.payment_id = p.id
             ), '[]'::json) AS apps
        FROM ${CUSTOMER ? sql`customer_payments` : sql`vendor_payments`} p
        JOIN zoho_id_map z ON z.entity = ${SIDE.entity} AND z.eggsy_id = p.id
        JOIN contacts c ON c.id = ${CUSTOMER ? sql`p.customer_id` : sql`p.vendor_id`}
       -- The group's advances are unapplied here on purpose (16 Oct 2026), so
       -- Zoho having spent them is a decision, not a difference to fix.
       WHERE c.is_group_company = false
       ORDER BY p.payment_date, p.number
    `)
  ).rows as Array<{ zoho_id: string; number: string; date: string; vendor: string;
                    amount: number; apps: Array<{ bill: string; amount: number }> }>;

  const same: string[] = [];
  const differ: Array<{ n: typeof here[number]; z: Z; why: string }> = [];
  const elsewhere: Array<{ n: typeof here[number]; z: Z; missing: number }> = [];

  for (const n of here) {
    const z = zoho.get(n.zoho_id);
    if (!z) continue;                                    // deleted in Zoho; a separate question
    const applied = (CUSTOMER
      ? ((z as unknown as { invoices?: Array<{ invoice_id: string; amount_applied: number }> }).invoices ?? [])
          .map((i) => ({ bill_id: i.invoice_id, amount_applied: i.amount_applied }))
      : (z.bills ?? []));
    const wantAll = applied.map((b) => ({ bill: billHere.get(String(b.bill_id)), amount: Math.round(Number(b.amount_applied) * 100) / 100 }));
    const absent = wantAll.filter((w) => !w.bill);
    if (absent.length) {
      elsewhere.push({ n, z, missing: absent.reduce((s, w) => s + w.amount, 0) });
      continue;
    }
    const key = (rows: Array<{ bill?: string; amount: number }>) =>
      rows.filter((r) => r.amount > 0)
        .map((r) => `${r.bill}:${r.amount.toFixed(2)}`).sort().join("|");
    const mine = key(n.apps.map((a) => ({ bill: a.bill, amount: Number(a.amount) })));
    const theirs = key(wantAll);
    if (mine === theirs) { same.push(n.number); continue; }
    const mineTotal = n.apps.reduce((s, a) => s + Number(a.amount), 0);
    const theirsTotal = wantAll.reduce((s, w) => s + w.amount, 0);
    differ.push({
      n, z,
      why: Math.abs(mineTotal - theirsTotal) < 1
        ? `same money, ${n.apps.length} bill(s) here against ${wantAll.length} there`
        : `applies ${money(mineTotal)} here, ${money(theirsTotal)} there`,
    });
  }

  console.log(`\n  ${here.length} vendor payment(s) carry a Zoho number\n`);
  console.log(`    allocated exactly as Zoho has them ... ${same.length}`);
  console.log(`    allocated differently ................ ${differ.length}`);
  console.log(`    Zoho applies them to a bill niko has not got  ${elsewhere.length}   Rs ${money(elsewhere.reduce((s, e) => s + e.missing, 0))}`);

  if (differ.length) {
    console.log(`\n  allocated differently:`);
    for (const d of differ.slice(0, 30)) {
      console.log(
        `    ${d.n.number.padEnd(20)}${d.n.date}  ${d.n.vendor.slice(0, 24).padEnd(25)}` +
          `${money(d.n.amount).padStart(12)}   ${d.why}`,
      );
    }
    if (differ.length > 30) console.log(`    ... and ${differ.length - 30} more`);
  }
  if (elsewhere.length) {
    console.log(`\n  Zoho spends them on bills niko has not got — bring the bills, not the payment:`);
    for (const e of elsewhere.slice(0, 20)) {
      console.log(
        `    ${e.n.number.padEnd(20)}${e.n.date}  ${e.n.vendor.slice(0, 24).padEnd(25)}` +
          `${money(e.n.amount).padStart(12)}   ${money(e.missing)} of it`,
      );
    }
    if (elsewhere.length > 20) console.log(`    ... and ${elsewhere.length - 20} more`);
  }
  if (LIST) {
    console.log(`\n  ${differ.map((d) => d.n.number).join(" ")}\n`);
  } else {
    console.log(`\n  Nothing written. --list prints the numbers for unload-selected.\n`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
