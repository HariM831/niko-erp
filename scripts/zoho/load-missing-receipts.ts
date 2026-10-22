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
 *
 * --vendor asks the same question of the money going out. Nothing about the
 * reasoning changes: a payment can reach niko by the statement or by the
 * catch-up, and the 224 vendor payments still in Zoho are why payables does
 * not agree with the bills behind it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../../server/db";
import { sharesUtr, utrs } from "./utr";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";
const writeAt = process.argv.indexOf("--write");
const OUT = writeAt > -1 ? process.argv[writeAt + 1] : undefined;
/** The money going out instead of the money coming in. */
const VENDOR = process.argv.includes("--vendor");
const SIDE = VENDOR
  ? { file: "vendorpayments", table: sql`vendor_payments`, who: sql`vendor_id`, word: "payment" }
  : { file: "customerpayments", table: sql`customer_payments`, who: sql`customer_id`, word: "receipt" };

/** A deposit is the same deposit if the money and the party agree this closely. */
const DAYS = 3;

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const sameParty = (a: string, b: string) => {
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
};
const days = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

interface Z {
  payment_number: string; date: string; customer_name?: string; customer_id?: string;
  amount: number; reference_number?: string; created_time?: string;
}

async function main() {
  const zoho: Z[] = readFileSync(`${DIR}/${SIDE.file}.jsonl`, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Z & { vendor_id?: string; vendor_name?: string })
    // Zoho names the other party vendor_ on the paying side. Everything below
    // asks the same question, so it is asked of one shape.
    .map((z) => ({ ...z, customer_id: z.customer_id ?? z.vendor_id,
                   customer_name: z.customer_name ?? z.vendor_name }));

  const here = (
    await db.execute(sql`
      SELECT p.number, p.payment_date::text AS date, c.display_name AS cust,
             p.${SIDE.who}::text AS cust_id,
             round(p.amount::numeric, 2)::float8 AS amount, p.reference
        FROM ${SIDE.table} p JOIN contacts c ON c.id = p.${SIDE.who}
    `)
  ).rows as Array<{ number: string; date: string; cust: string; cust_id: string;
                    amount: number; reference: string | null }>;

  /**
   * Who a Zoho receipt belongs to is answered by its customer id, not by the
   * name printed on it. PUYA MARKETING was merged into M/s Puya here on 17
   * Oct 2026, and every Zoho receipt still says PUYA MARKETING: on the name
   * alone, 24.5 lakh already in niko would have been loaded a second time and
   * applied to the two invoices voided that morning.
   */
  const party = new Map(
    ((
      await db.execute(sql`
        SELECT zoho_id, eggsy_id::text FROM zoho_id_map WHERE entity = 'contact'
      `)
    ).rows as Array<{ zoho_id: string; eggsy_id: string }>).map((r) => [r.zoho_id, r.eggsy_id]),
  );
  const byNumber = new Set(here.map((r) => r.number));
  // Only receipts raised in niko can stand in for a Zoho one. A receipt that
  // carries a Zoho number IS that receipt, matched already.
  const own = here.filter((r) => !byNumber.has(r.number) || !r.number.startsWith("CP-"));

  /**
   * Zoho holds some deposits twice itself. Between 6 and 8 October somebody
   * re-keyed old receipts into it — CP-2026-27/1346 carries the same UTR as
   * CP-2026-27/569 of 29 June under a different customer's name — and Zoho
   * applied both copies to one invoice, so its own A-INV-EG-27-0439 says it
   * is paid while carrying 7,04,026 against a total of 3,52,013.
   *
   * Those copies were removed from niko on 17 Oct 2026, and this script
   * promptly offered to load them again: having no route into niko is exactly
   * what a removed duplicate looks like. So a receipt whose own twin is
   * already here under its own number is not missing, it is the second copy.
   * The twin is the earlier record — the one keyed when the money arrived.
   */
  /**
   * Twins already accepted into this very run. Unloading a receipt to rebuild
   * its allocation empties niko of it for a moment, and in that moment its
   * October re-entry stops looking like a duplicate and loads: CP-2026-27/1403
   * came back that way on 22 Oct 2026, hours after being removed, because
   * CP-2026-27/058 had been taken out for a rebuild.
   */
  const accepted = new Set<string>();
  const twinHere = (z: Z) => {
    const zu = utrs(z.reference_number);
    return zoho.find(
      (o) =>
        o.payment_number !== z.payment_number &&
        (byNumber.has(o.payment_number) || accepted.has(o.payment_number)) &&
        Math.abs(Number(o.amount) - Number(z.amount)) <= 1 &&
        days(o.date, z.date) <= 2 &&
        Date.parse(o.created_time ?? o.date) < Date.parse(z.created_time ?? z.date) &&
        // The same party, or — where the re-entry was filed under a second
        // customer record, as CP-2026-27/1346 was against North East Egg
        // Centre while its twin sits under Pal Egg Center — the same transfer.
        (String(o.customer_id ?? "") === String(z.customer_id ?? "") ||
          (zu.size > 0 && sharesUtr(zu, utrs(o.reference_number)))),
    );
  };

  const taken = new Set<string>();
  const load: Z[] = [];
  const skip: Array<{ z: Z; as: typeof own[number]; utr: boolean }> = [];
  const twins: Array<{ z: Z; as: Z }> = [];
  const candidatesFor = (z: Z) => {
    const mine = party.get(String(z.customer_id ?? ""));
    return own.filter(
      (k) =>
        !taken.has(k.number) &&
        Math.abs(Number(z.amount) - k.amount) <= 1 &&
        days(z.date, k.date) <= DAYS &&
        (mine ? k.cust_id === mine : sameParty(z.customer_name ?? "", k.cust)),
    );
  };

  const unmatched = zoho
    .filter((z) => !byNumber.has(z.payment_number))
    // Oldest keying first, so the copy that was written when the money
    // arrived is the one accepted and the re-entry is the one held back.
    .sort((a, b) => (a.created_time ?? a.date).localeCompare(b.created_time ?? b.date));
  /**
   * The amount and the party and a few days between them is where every
   * double-post lives, but it is not proof — a customer who pays the same
   * round sum twice in a week is ordinary here. A shared bank reference is
   * proof, so every one of those is paired FIRST, before a likeness can take
   * the receipt it belongs to.
   *
   * CP-2026-27/1393 is why. PMT-00085 carries its exact reference, but a
   * receipt three days later for the same round 2,68,800 reached it first,
   * and 1393 was loaded as missing against a deposit niko already had.
   */
  for (const z of unmatched) {
    const zu = utrs(z.reference_number);
    if (!zu.size) continue;
    const hit = candidatesFor(z).find((k) => sharesUtr(zu, utrs(k.reference)));
    if (hit) { taken.add(hit.number); skip.push({ z, as: hit, utr: true }); }
  }
  const done = new Set(skip.map((s) => s.z.payment_number));
  for (const z of unmatched) {
    if (done.has(z.payment_number)) continue;
    const zu = utrs(z.reference_number);
    /**
     * Two different references are two deposits however alike they look, so
     * likeness only decides where one side has no usable reference at all.
     */
    const hit = candidatesFor(z).find((k) => !zu.size || !utrs(k.reference).size);
    if (hit) { taken.add(hit.number); skip.push({ z, as: hit, utr: false }); continue; }
    const twin = twinHere(z);
    if (twin) { twins.push({ z, as: twin }); continue; }
    accepted.add(z.payment_number);
    load.push(z);
  }

  const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  console.log(`\n  ${zoho.length} Zoho receipts in ${DIR}`);
  console.log(`    already here under their own number .. ${zoho.length - load.length - skip.length}`);
  console.log(`    already here, keyed from the statement ${skip.length}   Rs ${money(skip.reduce((s, x) => s + Number(x.z.amount), 0))}`);
  console.log(`    Zoho holds the same deposit twice ..... ${twins.length}   Rs ${money(twins.reduce((s, x) => s + Number(x.z.amount), 0))}`);
  console.log(`    reached niko by no route — to load ... ${load.length}   Rs ${money(load.reduce((s, x) => s + Number(x.amount), 0))}`);
  console.log(`      of the skipped, ${skip.filter((s) => s.utr).length} share a bank reference with what is here; ` +
    `${skip.filter((s) => !s.utr).length} rest on the party, the amount and the days alone`);

  if (twins.length) {
    console.log(`
  not loaded, because Zoho holds the deposit twice and the first copy is here:`);
    for (const t of twins) {
      console.log(
        `    ${t.z.payment_number.padEnd(18)}${t.z.date}  ${(t.z.customer_name ?? "").slice(0, 24).padEnd(25)}` +
          `${money(Number(t.z.amount)).padStart(12)}   first keyed as ${t.as.payment_number} on ${(t.as.created_time ?? "").slice(0, 10)}`,
      );
    }
  }

  if (skip.length) {
    console.log(`\n  skipped, because niko already holds the same deposit:`);
    for (const s of skip.slice(0, 20)) {
      console.log(
        `    ${s.z.payment_number.padEnd(18)}${s.z.date}  ${(s.z.customer_name ?? "").slice(0, 24).padEnd(25)}` +
          `${money(Number(s.z.amount)).padStart(12)}   here as ${s.as.number} (${s.as.date})` +
            `${s.utr ? ", same UTR" : ""}`,
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
