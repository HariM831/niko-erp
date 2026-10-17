/**
 * Before importing a Zoho bill, ask whether niko already has it.
 *
 *   npx tsx scripts/zoho/match-missing-bills.ts --dump <dir>
 *   npx tsx scripts/zoho/match-missing-bills.ts --dump <dir> --link
 *
 * The same mistake twice is a choice. On the sales side the catch-up matched
 * on the customer's NAME, found no counterpart for a sale niko already held
 * under a second record for the same party, and created it again — four
 * invoices, ₹33 lakh, voided on 17 Oct 2026.
 *
 * The purchase side is more exposed, not less. niko raises its own bills from
 * goods receipts and gate settlements, and has done since the mill went live
 * on 28 September, while Zoho was keyed in parallel until 15 October. A bill
 * for the same delivery exists in both books, with niko's number and no link
 * between them. Import the Zoho copy and the vendor is owed twice.
 *
 * So each unmapped Zoho bill is put beside niko's own bills for the same
 * vendor — by the vendor's Zoho id, never its name, because a merged contact
 * still answers to the old name in the dump — within a few days and the same
 * money. A match is LINKED, not imported: the document niko already has is
 * the one the goods receipt and the stock hang off.
 *
 * What is left over is genuinely missing and the loader can have it.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../../server/db";

const dumpAt = process.argv.indexOf("--dump");
const DIR = dumpAt > -1 ? process.argv[dumpAt + 1]! : ".zoho-dump/detail";
const LINK = process.argv.includes("--link");
/** A bill is dated by the vendor; niko dates its own from the delivery. */
const DAYS = 5;

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const days = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

interface Z {
  bill_id: string; bill_number: string; date: string; vendor_id: string;
  vendor_name?: string; total: number; status?: string;
}

async function main() {
  const zoho: Z[] = readFileSync(`${DIR}/bills.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Z)
    .filter((z) => (z.status ?? "") !== "void");

  const mapped = new Set(
    ((
      await db.execute(sql`SELECT zoho_id FROM zoho_id_map WHERE entity = 'bill'`)
    ).rows as Array<{ zoho_id: string }>).map((r) => r.zoho_id),
  );
  const party = new Map(
    ((
      await db.execute(sql`SELECT zoho_id, eggsy_id::text FROM zoho_id_map WHERE entity = 'contact'`)
    ).rows as Array<{ zoho_id: string; eggsy_id: string }>).map((r) => [r.zoho_id, r.eggsy_id]),
  );

  const own = (
    await db.execute(sql`
      SELECT b.id::text, b.number, b.bill_date::text AS date, b.vendor_id::text AS vendor_id,
             c.display_name AS vendor, b.total::float8 AS total, b.status::text,
             b.vendor_bill_number AS their_number
        FROM bills b JOIN contacts c ON c.id = b.vendor_id
       WHERE b.status NOT IN ('void', 'draft')
         AND NOT EXISTS (SELECT 1 FROM zoho_id_map z WHERE z.entity = 'bill' AND z.eggsy_id = b.id)
       ORDER BY b.bill_date
    `)
  ).rows as Array<{ id: string; number: string; date: string; vendor_id: string;
                    vendor: string; total: number; status: string; their_number: string | null }>;

  const missing = zoho.filter((z) => !mapped.has(String(z.bill_id)));
  console.log(`\n  ${zoho.length} Zoho bills, ${missing.length} not linked to anything here`);
  console.log(`  ${own.length} bill(s) raised in niko carry no Zoho link\n`);

  const taken = new Set<string>();
  const pairs: Array<{ z: Z; k: typeof own[number]; why: string }> = [];
  const load: Z[] = [];
  const unknown: Z[] = [];
  for (const z of missing) {
    const mine = party.get(String(z.vendor_id));
    if (!mine) { unknown.push(z); continue; }
    const hit = own.find(
      (k) =>
        !taken.has(k.id) &&
        k.vendor_id === mine &&
        Math.abs(k.total - Number(z.total)) <= Math.max(50, Number(z.total) * 0.005) &&
        days(k.date, z.date) <= DAYS,
    );
    if (hit) {
      taken.add(hit.id);
      pairs.push({
        z, k: hit,
        why: [
          z.date === hit.date ? "same day" : `${days(z.date, hit.date)} day(s) apart`,
          Math.abs(hit.total - Number(z.total)) < 1 ? "same amount"
            : `Rs ${money(Math.abs(hit.total - Number(z.total)))} apart`,
          hit.their_number && hit.their_number === z.bill_number ? "same vendor bill number" : "",
        ].filter(Boolean).join("; "),
      });
    } else load.push(z);
  }

  console.log(`  ALREADY HERE — link, do not import: ${pairs.length}   Rs ${money(pairs.reduce((s, p) => s + Number(p.z.total), 0))}`);
  for (const p of pairs) {
    console.log(
      `    ${p.z.bill_number.padEnd(22)}${p.z.date}  ${(p.z.vendor_name ?? "").slice(0, 24).padEnd(25)}` +
        `${money(Number(p.z.total)).padStart(12)}   here as ${p.k.number} (${p.k.date})   ${p.why}`,
    );
  }
  console.log(`\n  GENUINELY MISSING — import: ${load.length}   Rs ${money(load.reduce((s, z) => s + Number(z.total), 0))}`);
  for (const z of load.slice(0, 25)) {
    console.log(
      `    ${z.bill_number.padEnd(22)}${z.date}  ${(z.vendor_name ?? "").slice(0, 24).padEnd(25)}${money(Number(z.total)).padStart(12)}`,
    );
  }
  if (load.length > 25) console.log(`    ... and ${load.length - 25} more`);
  if (unknown.length) {
    console.log(`\n  vendor not in niko at all — the contact loader runs first: ${unknown.length}`);
    for (const z of unknown.slice(0, 10)) {
      console.log(`    ${z.bill_number.padEnd(22)}${z.date}  ${(z.vendor_name ?? "").slice(0, 30).padEnd(31)}${money(Number(z.total)).padStart(12)}`);
    }
  }

  if (!LINK) {
    console.log(`\n  Nothing written. Pass --link to join the pairs above, then run load-bills.ts.\n`);
    await pool.end();
    return;
  }
  if (!pairs.length) {
    console.log(`\n  Nothing to link.\n`);
    await pool.end();
    return;
  }
  await db.transaction(async (tx) => {
    for (const p of pairs) {
      await tx.execute(sql`
        INSERT INTO zoho_id_map (entity, zoho_id, eggsy_id, label)
        VALUES ('bill', ${String(p.z.bill_id)}, ${p.k.id}::uuid, ${p.z.bill_number})
      `);
    }
  });
  console.log(`\n  Linked ${pairs.length} bill(s). The loader will now pass over them.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
