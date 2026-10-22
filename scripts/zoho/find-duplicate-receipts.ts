/**
 * Find the same deposit sitting in niko twice.
 *
 *   npx tsx scripts/zoho/find-duplicate-receipts.ts --dump <dir>
 *
 * Twenty-two invoices carry more applied to them than they are worth, fifteen
 * of those exactly twice over. The money is not wrong — the same deposit is
 * recorded twice, and there are two ways it got there:
 *
 *   ZOHO ENTERED IT TWICE. Between 6 and 8 October somebody re-keyed old
 *   receipts into Zoho: CP-2026-27/1346 of 6 October carries the identical UTR
 *   as CP-2026-27/569 of 29 June, PUNBR52026062919129747, under a different
 *   customer name. Five July receipts for DG Egg Point were re-entered the same
 *   evening against a second contact record, and an April cash receipt in
 *   October. Zoho applied both copies to the same invoice, so Zoho's own books
 *   are over-applied there too, and the catch-up inherited it.
 *
 *   BOTH BOOKS HOLD IT. A deposit keyed from the bank statement as PMT-00019
 *   and the same deposit loaded from Zoho as CP-2026-27/1206. This is the
 *   double-posting the 16 September rule existed to prevent, and the presence
 *   test that replaced it misses whenever the two books split the deposit
 *   differently — Zoho has 20,000 on the 14th and 5,53,000 on the 15th where
 *   niko has one 5,73,000 on the 18th.
 *
 * The evidence, strongest first: a shared UTR is proof, since a bank reference
 * belongs to one transfer. Beyond that it is the same customer and the same
 * amount close together in time, which is suspicion, not proof — a customer
 * who pays the same round sum twice in a week is ordinary. A Zoho record
 * created weeks after the day it is dated, when an earlier record of the same
 * money already exists, is near proof.
 *
 * This only reports. Nothing is unloaded here: see unload-selected.ts.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../../server/db";
import { sharesUtr, utrs } from "./utr";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";
/** Same customer, same amount, no further apart than this — worth a look. */
const DAYS = 7;
/** The money going out. Complaints of duplicates there too, 22 Oct 2026. */
const VENDOR = process.argv.includes("--vendor");
const SIDE = VENDOR
  ? { file: "vendorpayments", table: sql`vendor_payments`, who: sql`vendor_id`,
      apps: sql`vendor_payment_applications`, doc: sql`bills`, on: sql`bill_id`,
      entity: "vendor_payment", word: "payment" }
  : { file: "customerpayments", table: sql`customer_payments`, who: sql`customer_id`,
      apps: sql`payment_applications`, doc: sql`invoices`, on: sql`invoice_id`,
      entity: "customer_payment", word: "receipt" };

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const days = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);


interface Z {
  payment_number: string;
  date: string;
  created_time: string;
  customer_name?: string;
  amount: number;
  reference_number?: string;
  invoices?: Array<{ invoice_number: string; amount_applied: number }>;
}

async function main() {
  const zoho = new Map<string, Z>();
  for (const line of readFileSync(`${DIR}/${SIDE.file}.jsonl`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const z = JSON.parse(line) as Z & { vendor_name?: string };
    zoho.set(z.payment_number, { ...z, customer_name: z.customer_name ?? z.vendor_name });
  }

  const here = (
    await db.execute(sql`
      SELECT p.number, p.payment_date::text AS date, c.display_name AS cust,
             p.${SIDE.who}::text AS cust_id,
             round(p.amount::numeric, 2)::float8 AS amount, p.reference,
             coalesce((SELECT string_agg(i.number || ' ' || round(pa.amount_applied::numeric)::text, '; ' ORDER BY i.number)
                         FROM ${SIDE.apps} pa JOIN ${SIDE.doc} i ON i.id = pa.${SIDE.on}
                        WHERE pa.payment_id = p.id), '(unapplied)') AS applied
        FROM ${SIDE.table} p JOIN contacts c ON c.id = p.${SIDE.who}
       ORDER BY p.payment_date, p.number
    `)
  ).rows as Array<{ number: string; date: string; cust: string; cust_id: string;
                    amount: number; reference: string | null; applied: string }>;

  console.log(`\n  ${here.length} ${SIDE.word}s in niko, ${zoho.size} in the dump\n`);

  /** Everything for one party, when a single account is in question. */
  const partyAt = process.argv.indexOf("--party");
  const only = partyAt > -1 ? process.argv[partyAt + 1]! : undefined;
  if (only) {
    const mine = here.filter((h) => h.cust.toLowerCase().includes(only.toLowerCase()));
    console.log(`  everything niko holds for ${only}:`);
    for (const m of mine) {
      console.log(
        `    ${m.number.padEnd(20)}${m.date}  ${money(m.amount).padStart(12)}   ${m.applied}` +
          `   ${(m.reference ?? "").slice(0, 32)}`,
      );
    }
    console.log(`    ${mine.length} in all, Rs ${money(mine.reduce((s, m) => s + m.amount, 0))}\n`);
  }

  type Pair = { a: typeof here[number]; b: typeof here[number]; why: string[]; bucket: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < here.length; i++) {
    for (let j = i + 1; j < here.length; j++) {
      const [a, b] = [here[i]!, here[j]!];
      const za = zoho.get(a.number);
      const zb = zoho.get(b.number);
      const ua = utrs(a.reference ?? za?.reference_number ?? null);
      const ub = utrs(b.reference ?? zb?.reference_number ?? null);
      const utr = ua.size > 0 && ub.size > 0 && sharesUtr(ua, ub);
      const sameSum = Math.abs(a.amount - b.amount) <= 1;
      const apart = days(a.date, b.date);
      const sameParty = a.cust_id === b.cust_id;
      if (!utr && !(sameParty && sameSum && apart <= DAYS)) continue;

      const why: string[] = [];
      if (utr) why.push("same UTR");
      if (sameSum && a.date === b.date) why.push("same day, same amount");
      else if (sameSum) why.push(`same amount, ${apart} day(s) apart`);
      if (!sameParty) why.push("different customers");
      let late = false;
      for (const [n, z] of [[a.number, za], [b.number, zb]] as const) {
        if (z && days(z.created_time.slice(0, 10), z.date) > 14) {
          why.push(`${n} keyed into Zoho on ${z.created_time.slice(0, 10)} for ${z.date}`);
          late = true;
        }
      }
      const books = !za !== !zb;
      if (books) why.push("one from Zoho, one keyed from the statement");
      /**
       * Close in time and identical in amount is where every duplicate lives,
       * but it is not enough on its own: two customers paid 3,23,400 on the
       * same 17 July and the SBI counter put the same narration on both. What
       * settles it is a record keyed into Zoho weeks after the day it is dated
       * while an earlier record of the same money already existed, or the same
       * bank reference on the same customer.
       */
      const near = sameSum && apart <= 2;
      const bucket = near && (late || (utr && sameParty)) ? 0 : books && sameParty && sameSum ? 1 : 2;
      pairs.push({ a, b, why, bucket });
    }
  }

  for (const [label, set] of [
    ["THE SAME MONEY TWICE", pairs.filter((p) => p.bucket === 0)],
    ["ZOHO AND THE STATEMENT — one deposit or two?", pairs.filter((p) => p.bucket === 1)],
    ["WORTH A LOOK", pairs.filter((p) => p.bucket === 2)],
  ] as const) {
    const sum = set.reduce((s, p) => s + Math.min(p.a.amount, p.b.amount), 0);
    console.log(`  ${label}: ${set.length} pair(s), Rs ${money(sum)} counted twice if they are\n`);
    for (const p of set) {
      console.log(`    ${p.why.join("; ")}`);
      for (const r of [p.a, p.b]) {
        console.log(
          `      ${r.number.padEnd(20)}${r.date}  ${r.cust.slice(0, 24).padEnd(25)}${money(r.amount).padStart(11)}` +
            `   ${(r.reference ?? zoho.get(r.number)?.reference_number ?? "-").slice(0, 44)}`,
        );
        console.log(`        -> ${r.applied}`);
      }
      console.log();
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
