/**
 * Move a bill's lines from one account to another and re-post the bill.
 *
 *   npx tsx scripts/recode-bill-line.ts BILL-001007 1095 1101
 *   npx tsx scripts/recode-bill-line.ts BILL-001007 1095 1101 --commit
 *
 * For a bill that is paid, so its amounts are locked on screen, but whose cost
 * went to the wrong head. BILL-001007 (Praveen Steel Furniture, 25 Dec 2025,
 * three almirahs for the Thelamara office) was coded to 1095 Prepaid Expenses,
 * the account that holds vendor advances, so furniture sat among the advances
 * (22 Oct 2026: the user chose Furniture & Fixtures, 1101).
 *
 * Only the account changes. Amounts, payments and the payable stay as they
 * are; the bill's journal is reversed and posted again on its own date.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { repostBill } from "../server/routes/purchases";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const COMMIT = process.argv.includes("--commit");
const AS = process.argv.find((a) => a.startsWith("--as="))?.slice(5) ?? "admin";

async function main() {
  const [billNo, fromCode, toCode] = args;
  if (!billNo || !fromCode || !toCode) throw new Error("usage: recode-bill-line.ts <bill#> <from code> <to code> [--commit]");
  const [bill] = (
    await db.execute(sql`SELECT id::text, number, status FROM bills WHERE number = ${billNo}`)
  ).rows as Array<{ id: string; number: string; status: string }>;
  if (!bill) throw new Error(`no bill ${billNo}`);
  const accts = (
    await db.execute(sql`SELECT id::text, code, name, is_active FROM accounts WHERE code IN (${fromCode}, ${toCode})`)
  ).rows as Array<{ id: string; code: string; name: string; is_active: boolean }>;
  const from = accts.find((a) => a.code === fromCode);
  const to = accts.find((a) => a.code === toCode);
  if (!from || !to) throw new Error("both account codes must exist");
  if (!to.is_active) throw new Error(`${to.code} ${to.name} is inactive`);
  const lines = (
    await db.execute(sql`
      SELECT id::text, name, description, amount::text FROM bill_lines
       WHERE bill_id = ${bill.id}::uuid AND account_id = ${from.id}::uuid ORDER BY line_order`)
  ).rows as Array<{ id: string; name: string; description: string | null; amount: string }>;
  console.log(`\n  ${bill.number} (${bill.status}): ${lines.length} line(s) from ${from.code} ${from.name} to ${to.code} ${to.name}`);
  for (const l of lines) console.log(`    ${l.name}${l.description ? ` · ${l.description}` : ""}  ${l.amount}`);
  if (!lines.length) throw new Error("nothing on that account");
  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Add --commit to write.");
    await pool.end();
    return;
  }
  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = ${AS} LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error(`no user '${AS}'`);
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE bill_lines SET account_id = ${to.id}::uuid WHERE bill_id = ${bill.id}::uuid AND account_id = ${from.id}::uuid`);
    await repostBill(tx, bill.id, user.id);
  });
  console.log("\n  Re-coded and re-posted.");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
