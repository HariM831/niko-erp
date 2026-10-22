/**
 * Fold a bill imported from Zoho into the one niko already had.
 *
 *   npx tsx scripts/zoho/merge-duplicate-bills.ts BILL-002272=BILL-002140 ...
 *   ... --commit
 *
 * niko raises its own bills from goods receipts and gate settlements. Zoho
 * holds the same purchase, and the catch-up imported it because nothing
 * joined the two — five bills, ₹26,96,350, and two of them proven rather than
 * inferred: both copies carry the vendor's own number, M.B Suppliers' 01 and
 * 02.
 *
 * The copy to keep is niko's: the goods receipt, the stock and the payments
 * hang off it. What the import brought that is worth keeping is the LINK, so
 * this moves the Zoho id onto niko's bill before deleting the import. Without
 * that the next loader would see an unlinked Zoho bill and import it again.
 *
 * It refuses any pair that is not plainly the same purchase — same vendor,
 * same day, same figure — and any copy with money still applied to it, which
 * has to be dealt with first.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../../server/db";

const COMMIT = process.argv.includes("--commit");
const pairs = process.argv
  .slice(2)
  .filter((a) => a.includes("="))
  .map((a) => {
    const [drop, keep] = a.split("=");
    return { drop: drop!, keep: keep! };
  });

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  if (!pairs.length) {
    console.error("Usage: merge-duplicate-bills.ts <imported>=<kept> ... [--commit]");
    process.exitCode = 1;
    return;
  }
  console.log(`\n  ${pairs.length} pair(s) — ${COMMIT ? "FOLDING" : "dry run"}\n`);

  const rows = (
    await db.execute(sql`
      SELECT b.id::text, b.number, b.bill_date::text AS date, b.total::float8 AS total,
             b.vendor_id::text, c.display_name AS vendor, b.vendor_bill_number AS their_number,
             coalesce((SELECT sum(amount_applied) FROM vendor_payment_applications WHERE bill_id = b.id), 0)::float8 AS applied,
             (SELECT z.zoho_id FROM zoho_id_map z WHERE z.entity = 'bill' AND z.eggsy_id = b.id) AS zoho
        FROM bills b JOIN contacts c ON c.id = b.vendor_id
       WHERE b.number IN (${sql.join(pairs.flatMap((p) => [sql`${p.drop}`, sql`${p.keep}`]), sql`, `)})
    `)
  ).rows as Array<{ id: string; number: string; date: string; total: number; vendor_id: string;
                    vendor: string; their_number: string | null; applied: number; zoho: string | null }>;
  const byNumber = new Map(rows.map((r) => [r.number, r]));

  const ready: Array<{ drop: typeof rows[number]; keep: typeof rows[number] }> = [];
  for (const p of pairs) {
    const drop = byNumber.get(p.drop);
    const keep = byNumber.get(p.keep);
    if (!drop || !keep) throw new Error(`${!drop ? p.drop : p.keep} is not in the books`);
    if (drop.vendor_id !== keep.vendor_id) throw new Error(`${p.drop} and ${p.keep} are different vendors`);
    if (drop.date !== keep.date) throw new Error(`${p.drop} is ${drop.date}, ${p.keep} is ${keep.date}`);
    if (Math.abs(drop.total - keep.total) > 1) throw new Error(`${p.drop} is ${money(drop.total)}, ${p.keep} is ${money(keep.total)}`);
    if (drop.applied > 1) throw new Error(`${p.drop} still has ${money(drop.applied)} applied to it — deal with the payments first`);
    if (!drop.zoho) throw new Error(`${p.drop} carries no Zoho link; there is nothing to move`);
    if (keep.zoho) throw new Error(`${p.keep} already carries a Zoho link`);
    console.log(
      `    ${drop.number} -> ${keep.number}   ${drop.date}  ${drop.vendor.slice(0, 24).padEnd(25)}` +
        `${money(drop.total).padStart(12)}   ${drop.their_number ?? keep.their_number ?? "no vendor number"}` +
        `${keep.applied ? `   kept copy carries ${money(keep.applied)}` : ""}`,
    );
    ready.push({ drop, keep });
  }

  if (!COMMIT) {
    console.log(`\n  Dry run — nothing written. Re-run with --commit.\n`);
    await pool.end();
    return;
  }
  await db.transaction(async (tx) => {
    for (const { drop, keep } of ready) {
      await tx.execute(sql`
        UPDATE zoho_id_map SET eggsy_id = ${keep.id}::uuid
         WHERE entity = 'bill' AND eggsy_id = ${drop.id}::uuid
      `);
      await tx.execute(sql`
        DELETE FROM journal_entry_lines WHERE entry_id IN
          (SELECT id FROM journal_entries WHERE source_type = 'bill' AND source_id = ${drop.id}::uuid)
      `);
      await tx.execute(sql`UPDATE bills SET journal_entry_id = NULL WHERE id = ${drop.id}::uuid`);
      await tx.execute(sql`DELETE FROM journal_entries WHERE source_type = 'bill' AND source_id = ${drop.id}::uuid`);
      await tx.execute(sql`DELETE FROM bill_lines WHERE bill_id = ${drop.id}::uuid`);
      await tx.execute(sql`DELETE FROM bills WHERE id = ${drop.id}::uuid`);
      console.log(`    folded ${drop.number} into ${keep.number}`);
    }
  });
  console.log(`\n  ${ready.length} folded. Zoho now points at the bill niko raised.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
