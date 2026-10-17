/**
 * Bring across the Zoho receipts that reached niko by no route at all.
 *
 *   npx tsx scripts/zoho/load-missing-receipts.ts --dump <dir>
 *   npx tsx scripts/zoho/load-missing-receipts.ts --dump <dir> --write <file.jsonl>
 *
 * A deposit can enter niko two ways: somebody categorizes the bank statement
 * line, or the Zoho catch-up loads it. Do both and the money posts twice, with
 * a journal behind each. The rule written on 16 Oct 2026 was "never load a
 * Zoho receipt dated after 16 September", the date the original load stopped.
 *
 * That date was a proxy for "it is probably already here", and three weeks of
 * statement-keying has made the proxy wrong in both directions. Of the 291
 * Zoho receipts after 16 September that carry no Zoho number in niko:
 *
 *   114 are already here under a PMT- number, keyed from the statement. The
 *   eleven SBI deposits of 7 October that the rule was written for are among
 *   them: the rule did its job on exactly its own case.
 *
 *   177 are in niko by no route whatsoever, Rs 4.96 crore of them, and the
 *   date rule was keeping them out. They are why customers appear to owe money
 *   they have paid.
 *
 * So the test is not the date, it is presence: a receipt is skipped when niko
 * already holds one for the same customer, the same amount, within three days.
 * Everything else is written out for the ordinary loader to post.
 *
 * It writes a file and posts nothing itself. The matches it skipped are
 * printed so a wrong pairing can be seen before the loader runs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../../server/db";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";
const writeAt = process.argv.indexOf("--write");
const OUT = writeAt > -1 ? process.argv[writeAt + 1] : undefined;

/** A deposit is the same deposit if the money and the party agree this closely. */
const DAYS = 3;

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const sameParty = (a: string, b: string) => {
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
};
const days = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

interface Z { payment_number: string; date: string; customer_name?: string; amount: number }

async function main() {
  const zoho: Z[] = readFileSync(`${DIR}/customerpayments.jsonl`, "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const here = (
    await db.execute(sql`
      SELECT p.number, p.payment_date::text AS date, c.display_name AS cust,
             round(p.amount::numeric, 2)::float8 AS amount
        FROM customer_payments p JOIN contacts c ON c.id = p.customer_id
    `)
  ).rows as Array<{ number: string; date: string; cust: string; amount: number }>;
  const byNumber = new Set(here.map((r) => r.number));
  // Only receipts raised in niko can stand in for a Zoho one. A receipt that
  // carries a Zoho number IS that receipt, matched already.
  const own = here.filter((r) => !byNumber.has(r.number) || !r.number.startsWith("CP-"));

  const taken = new Set<string>();
  const load: Z[] = [];
  const skip: Array<{ z: Z; as: typeof own[number] }> = [];
  for (const z of zoho) {
    if (byNumber.has(z.payment_number)) continue;        // already here under its own number
    const hit = own.find(
      (k) =>
        !taken.has(k.number) &&
        Math.abs(Number(z.amount) - k.amount) <= 1 &&
        days(z.date, k.date) <= DAYS &&
        sameParty(z.customer_name ?? "", k.cust),
    );
    if (hit) { taken.add(hit.number); skip.push({ z, as: hit }); }
    else load.push(z);
  }

  const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  console.log(`\n  ${zoho.length} Zoho receipts in ${DIR}`);
  console.log(`    already here under their own number .. ${zoho.length - load.length - skip.length}`);
  console.log(`    already here, keyed from the statement ${skip.length}   Rs ${money(skip.reduce((s, x) => s + Number(x.z.amount), 0))}`);
  console.log(`    reached niko by no route — to load ... ${load.length}   Rs ${money(load.reduce((s, x) => s + Number(x.amount), 0))}`);

  if (skip.length) {
    console.log(`\n  skipped, because niko already holds the same deposit:`);
    for (const s of skip.slice(0, 20)) {
      console.log(
        `    ${s.z.payment_number.padEnd(18)}${s.z.date}  ${(s.z.customer_name ?? "").slice(0, 24).padEnd(25)}` +
          `${money(Number(s.z.amount)).padStart(12)}   here as ${s.as.number} (${s.as.date})`,
      );
    }
    if (skip.length > 20) console.log(`    ... and ${skip.length - 20} more`);
  }

  if (!OUT) {
    console.log(`\n  Nothing written. Pass --write <file.jsonl> to produce the set for load-payments.\n`);
    await pool.end();
    return;
  }
  writeFileSync(OUT, load.map((z) => JSON.stringify(z)).join("\n") + "\n");
  console.log(`\n  Wrote ${load.length} receipt(s) to ${OUT}`);
  console.log(`  Load them with:  npx tsx scripts/zoho/load-payments.ts --dir <that folder> --commit\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
