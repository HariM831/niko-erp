/**
 * Phase 3: bank accounts, which everything after this depends on.
 *
 *   npx tsx scripts/zoho/load-banks.ts             # say what would happen
 *   npx tsx scripts/zoho/load-banks.ts --commit    # do it
 *
 * Easy to overlook, because "bank account" means two different things in
 * niko: a GL account in the chart, already imported, and a row in
 * bank_accounts that expenses and payments actually point at. The second was
 * empty, so every expense and payment would have failed on a foreign key
 * several thousand records into the import.
 *
 * All eight come across, including Undeposited Funds and the Zoho Payroll
 * account. Both are plumbing rather than real accounts and both sit at zero,
 * but a document referencing one still has to resolve.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { bankAccounts, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";

interface ZohoBank {
  account_id: string;
  account_name: string;
  account_type: string;
  account_number?: string;
  bank_name?: string;
  routing_number?: string;
  is_active?: boolean;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const raw = await readFile(".zoho-dump/list/bankaccounts.jsonl", "utf8");
  const all: ZohoBank[] = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const accountRows = await db
    .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
    .from(zohoIdMap)
    .where(eq(zohoIdMap.entity, "account"));
  const glFor = new Map(accountRows.map((r) => [r.zohoId, r.eggsyId]));

  const done = await db
    .select({ zohoId: zohoIdMap.zohoId })
    .from(zohoIdMap)
    .where(eq(zohoIdMap.entity, "bank_account"));
  const already = new Set(done.map((d) => d.zohoId));
  const todo = all.filter((b) => !already.has(b.account_id));

  // In Zoho a banking account and its chart account share an id, which is what
  // links the two. A missing one means the chart import is incomplete, and
  // guessing by name here would attach money movements to the wrong ledger.
  const orphans = todo.filter((b) => !glFor.has(b.account_id));
  if (orphans.length) {
    throw new Error(
      `Bank accounts with no imported GL account:\n  ` +
        orphans.map((o) => `${o.account_name} (${o.account_id})`).join("\n  "),
    );
  }

  console.log(`${all.length} bank accounts — ${todo.length} to import, ${already.size} done`);
  for (const b of todo) {
    console.log(`  ${b.account_name.padEnd(42)} ${b.account_type}`);
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const b of todo) {
      const [row] = await tx
        .insert(bankAccounts)
        .values({
          name: b.account_name.trim(),
          // Zoho's "cash" covers petty cash and anything not reconciled by feed.
          kind: b.account_type === "cash" ? "cash" : "bank",
          bankName: b.bank_name?.trim() || null,
          accountNumber: b.account_number?.trim().slice(0, 30) || null,
          ifsc: b.routing_number?.trim().slice(0, 11) || null,
          glAccountId: glFor.get(b.account_id)!,
          isActive: b.is_active !== false,
        })
        .returning({ id: bankAccounts.id });

      await tx.insert(zohoIdMap).values({
        entity: "bank_account",
        zohoId: b.account_id,
        eggsyId: row!.id,
        label: b.account_name,
      });
    }
  });

  console.log(`\nCommitted ${todo.length} bank accounts.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
