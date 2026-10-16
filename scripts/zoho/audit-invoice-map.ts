/**
 * Find Zoho links that no longer describe the same invoice, and drop them.
 *
 *   npx tsx scripts/zoho/audit-invoice-map.ts --dump <file>
 *   npx tsx scripts/zoho/audit-invoice-map.ts --dump <file> --fix
 *
 * zoho_id_map says "this niko invoice is that Zoho invoice". It was written by
 * the September load and was right then. Zoho kept being edited afterwards —
 * A-INV-EG-27-0801 was re-dated from 16 Sep to 14 Sep and re-priced from
 * 2,73,000 to 2,45,700 on the night of 10 October — and a link whose two sides
 * have drifted apart is worse than no link at all:
 *
 *   it makes a real Zoho invoice look like one niko already has, so the
 *   catch-up skips it and the series is left with a hole; and
 *
 *   it sends a receipt to the wrong invoice, because load-payments resolves
 *   every application through this table.
 *
 * Four invoices went missing from a rehearsal exactly this way, and a receipt
 * for 2,73,000 had nowhere to land.
 *
 * A link is stale when the two sides disagree on customer, date or amount. It
 * is NOT stale merely because niko's number has changed — the series is being
 * relaid, so numbers are expected to move; identity is what must hold. Dropping
 * a stale link loses nothing: the backfill re-links what genuinely pairs, and
 * the loader imports what does not.
 *
 * Pass the CURRENT dump. The droplet keeps its own from the September pull, and
 * auditing against that would compare today's database to the very copies the
 * links were made from — every link would look perfect.
 */
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { contacts, invoices, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";

const FIX = process.argv.includes("--fix");
const dumpAt = process.argv.indexOf("--dump");
const DUMP = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail/invoices.jsonl";

interface Z { invoice_id: string; invoice_number: string; date: string; customer_name?: string; total: number; status?: string }

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const sameParty = (a: string, b: string) => {
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
};

async function main() {
  const zoho = new Map<string, Z>();
  for (const line of readFileSync(DUMP, "utf8").trim().split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Z;
    zoho.set(String(r.invoice_id), r);
  }
  console.log(`\n  auditing invoice links against ${DUMP} (${zoho.size} invoices) — ${FIX ? "FIXING" : "dry run"}\n`);

  const links = await db
    .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId, number: invoices.number,
              date: invoices.invoiceDate, total: invoices.total, cust: contacts.displayName })
    .from(zohoIdMap)
    .innerJoin(invoices, eq(invoices.id, zohoIdMap.eggsyId))
    .innerJoin(contacts, eq(contacts.id, invoices.customerId))
    .where(eq(zohoIdMap.entity, "invoice"));

  const stale: typeof links = [];
  const gone: typeof links = [];
  for (const l of links) {
    const z = zoho.get(l.zohoId);
    if (!z) { gone.push(l); continue; }
    const party = sameParty(z.customer_name ?? "", l.cust);
    const day = z.date === l.date;
    const money = Math.abs(Number(l.total) - Number(z.total)) <= 1;
    if (!party || !day || !money) stale.push(l);
  }
  console.log(`  ${links.length} link(s)`);
  console.log(`    agree on customer, date and amount ... ${links.length - stale.length - gone.length}`);
  console.log(`    disagree — stale .................... ${stale.length}`);
  console.log(`    point at an invoice Zoho no longer has ${gone.length}`);

  if (stale.length) {
    console.log(`\n  stale:`);
    for (const l of stale) {
      const z = zoho.get(l.zohoId)!;
      console.log(`    ${l.number}  ${l.date}  ${l.cust.slice(0, 22).padEnd(23)}${Number(l.total).toFixed(0).padStart(11)}`);
      console.log(`      says it is ${z.invoice_number}  ${z.date}  ${(z.customer_name ?? "").slice(0, 22).padEnd(23)}${Number(z.total).toFixed(0).padStart(11)}`);
    }
  }
  if (gone.length) {
    console.log(`\n  pointing at a deleted Zoho invoice (left alone — niko keeps these by decision):`);
    for (const l of gone) console.log(`    ${l.number}  ${l.date}  ${l.cust}  ${Number(l.total).toFixed(0)}`);
  }

  if (!stale.length) {
    console.log("\n  nothing to drop.\n");
    await pool.end();
    return;
  }
  if (!FIX) {
    console.log("\n  Dry run — nothing dropped. Re-run with --fix.\n");
    await pool.end();
    return;
  }
  await db.delete(zohoIdMap).where(
    and(eq(zohoIdMap.entity, "invoice"), inArray(zohoIdMap.eggsyId, stale.map((s) => s.eggsyId))),
  );
  console.log(`\n  Dropped ${stale.length} stale link(s). Run the backfill to re-link what pairs, then the loaders.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
