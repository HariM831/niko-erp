/**
 * Phase 3: expenses — the largest document count in the books, and the
 * simplest shape.
 *
 *   npx tsx scripts/zoho/load-expenses.ts             # say what would happen
 *   npx tsx scripts/zoho/load-expenses.ts --commit    # do it
 *
 * Every one is a single line charged to a single account and paid from one
 * bank, which is exactly EGGSY's model, so nothing has to be reshaped. Two
 * things to know:
 *
 *   Zoho gives expenses no number at all. EGGSY requires one, so they are
 *   issued here in date order — meaning a re-run produces the same numbers, but
 *   also that nothing in EGGSY will match a reference anyone quotes from Zoho.
 *
 *   Only 2 of 2,604 name a vendor. The rest are genuinely unattributed, which
 *   is why Purchases by Vendor collects them under "Others" rather than
 *   dropping them.
 */
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { bankAccounts, expenses, users, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { buildExpenseJeLines } from "../../server/routes/purchases";
import { postJournal } from "../../server/services/posting";

interface ZohoExpense {
  expense_id: string;
  date: string;
  account_id: string;
  account_name?: string;
  paid_through_account_id: string;
  vendor_id?: string;
  amount: number;
  total: number;
  tax_amount?: number;
  reference_number?: string;
  description?: string;
}

const money = (n: number | undefined) => (n ?? 0).toFixed(2);

async function main() {
  const commit = process.argv.includes("--commit");
  const raw = await readFile(".zoho-dump/detail/expenses.jsonl", "utf8");
  const all: ZohoExpense[] = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  all.sort((a, b) => a.date.localeCompare(b.date) || a.expense_id.localeCompare(b.expense_id));

  const idsOf = async (entity: string) =>
    new Map(
      (
        await db
          .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
          .from(zohoIdMap)
          .where(eq(zohoIdMap.entity, entity))
      ).map((r) => [r.zohoId, r.eggsyId]),
    );
  const accountFor = await idsOf("account");
  const contactFor = await idsOf("contact");
  const bankFor = await idsOf("bank_account");
  const done = await idsOf("expense");
  const todo = all.filter((e) => !done.has(e.expense_id));

  // The GL account behind each bank, needed for the credit side of the posting.
  const glOfBank = new Map(
    (await db.select({ id: bankAccounts.id, glAccountId: bankAccounts.glAccountId }).from(bankAccounts)).map(
      (b) => [b.id, b.glAccountId],
    ),
  );

  const problems: string[] = [];
  for (const e of todo) {
    if (!accountFor.has(e.account_id)) {
      problems.push(`${e.date} ${e.account_name}: expense account not imported`);
    }
    if (!bankFor.has(e.paid_through_account_id)) {
      problems.push(`${e.date} ${e.account_name}: paid-through bank not imported`);
    }
    if (e.vendor_id && !contactFor.has(e.vendor_id)) {
      problems.push(`${e.date} ${e.account_name}: vendor not imported`);
    }
    if (Number(e.total) === 0) problems.push(`${e.date} ${e.account_name}: zero value`);
  }
  if (problems.length) {
    throw new Error(
      `Cannot import — ${problems.length} problem(s):\n  ${problems.slice(0, 15).join("\n  ")}`,
    );
  }

  console.log(`${all.length} expenses — ${todo.length} to import, ${done.size} already done`);
  console.log(`  value ${todo.reduce((s, e) => s + Number(e.total), 0).toLocaleString("en-IN")}`);
  console.log(`  dates ${todo[0]?.date} .. ${todo[todo.length - 1]?.date}`);
  console.log(`  naming a vendor ${todo.filter((e) => e.vendor_id).length}`);

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("No user to attribute the import to");

  const [{ next }] = await db
    .select({ next: sql<number>`COALESCE(MAX(SUBSTRING(number FROM '[0-9]+$')::int), 0) + 1` })
    .from(expenses);
  let seq = Number(next ?? 1);

  await db.transaction(async (tx) => {
    for (const e of todo) {
      const number = `EXP-${String(seq++).padStart(6, "0")}`;
      const bankId = bankFor.get(e.paid_through_account_id)!;
      const expenseAccountId = accountFor.get(e.account_id)!;

      const [row] = await tx
        .insert(expenses)
        .values({
          number,
          expenseDate: e.date,
          expenseAccountId,
          paidThroughId: bankId,
          vendorId: e.vendor_id ? (contactFor.get(e.vendor_id) ?? null) : null,
          amount: money(e.amount),
          // No tax anywhere in these books; verified zero across all 2,604.
          taxId: null,
          taxAmount: "0",
          reference: e.reference_number?.trim() || null,
          notes: e.description?.trim() || null,
          createdBy: admin.id,
        })
        .returning({ id: expenses.id });

      const jeId = await postJournal(tx, {
        entryDate: e.date,
        narration: `Expense ${number}${e.account_name ? ` — ${e.account_name}` : ""}`,
        sourceType: "expense",
        sourceId: row!.id,
        postedBy: admin.id,
        // The application's own builder, so an imported expense posts exactly
        // as one entered today would.
        lines: buildExpenseJeLines({
          expenseAccountId,
          bankGlAccountId: glOfBank.get(bankId)!,
          amount: money(e.amount),
          taxP: 0,
          number,
        }),
      });
      await tx.update(expenses).set({ journalEntryId: jeId }).where(eq(expenses.id, row!.id));

      await tx.insert(zohoIdMap).values({
        entity: "expense",
        zohoId: e.expense_id,
        eggsyId: row!.id,
        label: `${number} ${e.account_name ?? ""}`.trim(),
      });
    }
  });

  console.log(`\nCommitted ${todo.length} expenses, all posted, numbered EXP-* in date order.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
