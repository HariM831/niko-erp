/**
 * Link the invoices that exist in both books and were never connected.
 *
 *   npx tsx scripts/zoho/backfill-invoice-map.ts <file.csv>
 *   npx tsx scripts/zoho/backfill-invoice-map.ts <file.csv> --commit
 *
 * zoho_id_map is how a Zoho document finds its niko counterpart. It is written
 * by the loaders, so it only knows about documents that came through them —
 * and through September the egg invoices came from Amino instead, while Zoho
 * was being keyed in parallel. Both books hold the same sale and nothing joins
 * them.
 *
 * That matters at the moment payments are brought across: load-payments
 * resolves every application through this table and refuses a payment applied
 * to an invoice it cannot find. 177 applications worth Rs 4.99 crore were
 * pointing at invoices niko already had.
 *
 * The pairs come from a CSV so that the matching — customer, date within a
 * week, amount within a tolerance — is reviewed once as data rather than
 * re-derived here. This only inserts; a Zoho id that already has a mapping is
 * left exactly as it is, and a niko invoice that is already spoken for by a
 * different Zoho id is reported rather than given a second owner.
 */
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { invoices, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";

const COMMIT = process.argv.includes("--commit");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));

async function main() {
  if (!file) throw new Error("give the CSV of zoho_invoice_id,niko_number pairs");
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [zohoId, number, date, ...rest] = l.split(",");
      return { zohoId: zohoId!.trim(), number: number!.trim(), date: date?.trim() ?? "", who: rest.join(",") };
    });
  console.log(`\n  ${rows.length} pair(s) from ${file} — ${COMMIT ? "WRITING" : "dry run"}\n`);

  const existing = new Set(
    (
      await db
        .select({ zohoId: zohoIdMap.zohoId })
        .from(zohoIdMap)
        .where(and(eq(zohoIdMap.entity, "invoice"), inArray(zohoIdMap.zohoId, rows.map((r) => r.zohoId))))
    ).map((r) => r.zohoId),
  );
  const live = new Map(
    (
      await db
        .select({ id: invoices.id, number: invoices.number })
        .from(invoices)
        .where(inArray(invoices.number, rows.map((r) => r.number)))
    ).map((r) => [r.number, r.id]),
  );
  // A niko invoice already mapped to some OTHER Zoho id would be claimed twice.
  const takenBy = new Map(
    (
      await db
        .select({ eggsyId: zohoIdMap.eggsyId, zohoId: zohoIdMap.zohoId })
        .from(zohoIdMap)
        .where(eq(zohoIdMap.entity, "invoice"))
    ).map((r) => [r.eggsyId, r.zohoId]),
  );

  const todo: Array<{ zohoId: string; eggsyId: string; number: string }> = [];
  let already = 0;
  const problems: string[] = [];
  for (const r of rows) {
    if (existing.has(r.zohoId)) { already++; continue; }
    const id = live.get(r.number);
    if (!id) { problems.push(`${r.number} is not in the database (Zoho ${r.zohoId})`); continue; }
    const owner = takenBy.get(id);
    if (owner && owner !== r.zohoId) {
      problems.push(`${r.number} already belongs to Zoho ${owner}, cannot also be ${r.zohoId}`);
      continue;
    }
    todo.push({ zohoId: r.zohoId, eggsyId: id, number: r.number });
  }

  for (const r of rows.slice(0, 8)) console.log(`    ${r.zohoId}  ->  ${r.number}   ${r.date}  ${r.who}`);
  if (rows.length > 8) console.log(`    ... and ${rows.length - 8} more`);
  console.log(`\n    to link ....... ${todo.length}`);
  console.log(`    already linked  ${already}`);
  if (problems.length) {
    console.log(`    problems ...... ${problems.length}`);
    for (const p of problems.slice(0, 10)) console.log(`      ${p}`);
    throw new Error("not linking anything while a pair is in doubt");
  }

  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Re-run with --commit.\n");
    await pool.end();
    return;
  }
  if (todo.length) {
    await db.insert(zohoIdMap).values(
      todo.map((t) => ({ entity: "invoice", zohoId: t.zohoId, eggsyId: t.eggsyId })),
    );
  }
  console.log(`\n  Linked ${todo.length} invoice(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
