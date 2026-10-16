/**
 * Re-point an invoice's Zoho link where the one on file is wrong.
 *
 *   npx tsx scripts/zoho/repoint-invoice-map.ts <file.csv>
 *   npx tsx scripts/zoho/repoint-invoice-map.ts <file.csv> --commit
 *
 * Distinct from backfill-invoice-map.ts, which only ever adds a link that was
 * missing. This moves one, and a link that moves changes which invoice a
 * receipt settles — so it refuses on anything it cannot verify and prints what
 * each row looked like before.
 *
 * Why it is needed. The September load matched Zoho invoices to niko ones and
 * wrote the pairs down. On 10 October somebody in Zoho re-dated
 * A-INV-EG-27-0801 from 16 Sep to 14 Sep and re-priced it from Rs 2,73,000 to
 * Rs 2,45,700. The pairing that had been right in September was wrong from
 * that moment, and nothing noticed: niko's 17 Sep invoice still claimed to be
 * Zoho's 0801, while Zoho's real 17 Sep invoice had no link at all. The first
 * sign of it was load-payments refusing a receipt it could not place.
 *
 * The CSV is zoho_invoice_id,niko_number — the pairing as it should be. Each
 * row is checked three ways before anything moves: the Zoho id must exist in
 * the dump, the niko invoice must exist, and the two must agree on customer,
 * date and amount. A row that fails any of those stops the whole run.
 */
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { contacts, invoices, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";

const COMMIT = process.argv.includes("--commit");
const args = process.argv.slice(2);
const file = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--dump")[0];
/**
 * Which dump to read. The droplet keeps its own .zoho-dump from the original
 * September pull, so a run there against the default would check the pairs
 * against three-week-old copies — which is exactly the staleness this script
 * exists to repair. Pass the current one.
 */
const dumpAt = process.argv.indexOf("--dump");
const DUMP = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail/invoices.jsonl";

interface Zoho { invoice_id: string; invoice_number: string; date: string; customer_name?: string; total: number }

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const sameParty = (a: string, b: string) => {
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
};

async function main() {
  if (!file) throw new Error("give the CSV of zoho_invoice_id,niko_number pairs");
  const zoho = new Map<string, Zoho>();
  for (const line of readFileSync(DUMP, "utf8").trim().split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Zoho;
    zoho.set(String(r.invoice_id), r);
  }
  const rows = readFileSync(file, "utf8").trim().split("\n").slice(1).filter(Boolean)
    .map((l) => { const [zohoId, number] = l.split(","); return { zohoId: zohoId!.trim(), number: number!.trim() }; });
  console.log(`\n  ${rows.length} pair(s) from ${file} — ${COMMIT ? "WRITING" : "dry run"}\n`);

  const live = new Map(
    (await db
      .select({ id: invoices.id, number: invoices.number, date: invoices.invoiceDate,
                total: invoices.total, cust: contacts.displayName })
      .from(invoices)
      .innerJoin(contacts, eq(contacts.id, invoices.customerId))
      .where(inArray(invoices.number, rows.map((r) => r.number)))
    ).map((r) => [r.number, r]),
  );
  const current = new Map(
    (await db
      .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
      .from(zohoIdMap)
      .where(eq(zohoIdMap.entity, "invoice"))
    ).map((r) => [r.eggsyId, r.zohoId]),
  );

  const problems: string[] = [];
  const plan: Array<{ zohoId: string; eggsyId: string; number: string; was: string | undefined }> = [];
  for (const r of rows) {
    const z = zoho.get(r.zohoId);
    const k = live.get(r.number);
    if (!z) { problems.push(`Zoho ${r.zohoId} is not in the dump`); continue; }
    if (!k) { problems.push(`${r.number} is not in the database`); continue; }
    const money = Math.abs(Number(k.total) - Number(z.total));
    if (!sameParty(z.customer_name ?? "", k.cust)) {
      problems.push(`${r.number}: ${k.cust} is not ${z.customer_name} (${z.invoice_number})`); continue;
    }
    if (z.date !== k.date) {
      problems.push(`${r.number}: ${k.date} is not ${z.date} (${z.invoice_number})`); continue;
    }
    if (money > 1) {
      problems.push(`${r.number}: ${Number(k.total).toFixed(2)} is not ${Number(z.total).toFixed(2)} (${z.invoice_number})`); continue;
    }
    const was = current.get(k.id);
    const wasNum = was ? zoho.get(was)?.invoice_number ?? was : "nothing";
    console.log(`    ${r.number}  ${k.date}  ${k.cust.slice(0, 24).padEnd(25)}${Number(k.total).toFixed(0).padStart(11)}`);
    console.log(`        was linked to ${wasNum}  ->  now ${z.invoice_number}`);
    plan.push({ zohoId: r.zohoId, eggsyId: k.id, number: r.number, was });
  }
  if (problems.length) {
    console.log(`\n  REFUSING — ${problems.length} pair(s) do not agree:`);
    for (const p of problems) console.log(`    ${p}`);
    throw new Error("nothing moved");
  }

  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Re-run with --commit.\n");
    await pool.end();
    return;
  }
  await db.transaction(async (tx) => {
    // Clear the old links first: both the one this invoice held and any the
    // incoming Zoho id held elsewhere, or the unique pairing is broken.
    for (const p of plan) {
      await tx.delete(zohoIdMap).where(and(eq(zohoIdMap.entity, "invoice"), eq(zohoIdMap.eggsyId, p.eggsyId)));
      await tx.delete(zohoIdMap).where(and(eq(zohoIdMap.entity, "invoice"), eq(zohoIdMap.zohoId, p.zohoId)));
    }
    for (const p of plan) {
      await tx.insert(zohoIdMap).values({ entity: "invoice", zohoId: p.zohoId, eggsyId: p.eggsyId });
    }
  });
  console.log(`\n  Re-pointed ${plan.length} link(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
