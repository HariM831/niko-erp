/**
 * Phase 3: manual journals.
 *
 *   npx tsx scripts/zoho/load-journals.ts             # say what would happen
 *   npx tsx scripts/zoho/load-journals.ts --commit    # do it
 *
 * These are the entries with no document behind them — transfers between
 * accounts, depreciation, year-end adjustments — so they carry postings that
 * nothing else in the migration would produce. All 238 balance in Zoho and
 * every line names an account, which is checked again here before anything is
 * written.
 *
 * niko numbers its own journal entries, so Zoho's JN-* goes into the entry's
 * reference where it stays visible and searchable.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { journalEntries, users, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { postJournal } from "../../server/services/posting";

interface ZohoJournalLine {
  account_id: string;
  account_name?: string;
  description?: string;
  debit_or_credit: "debit" | "credit";
  amount: number;
}

interface ZohoJournal {
  journal_id: string;
  entry_number: string;
  journal_date: string;
  reference_number?: string;
  notes?: string;
  status: string;
  line_items: ZohoJournalLine[];
}

const money = (n: number | undefined) => (n ?? 0).toFixed(2);
const paise = (n: number | undefined) => Math.round((n ?? 0) * 100);

async function main() {
  const commit = process.argv.includes("--commit");
  const raw = await readFile(".zoho-dump/detail/journals.jsonl", "utf8");
  const all: ZohoJournal[] = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  all.sort(
    (a, b) => a.journal_date.localeCompare(b.journal_date) || a.journal_id.localeCompare(b.journal_id),
  );

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
  const done = await idsOf("journal");
  const todo = all.filter((j) => !done.has(j.journal_id));

  const problems: string[] = [];
  for (const j of todo) {
    const lines = j.line_items ?? [];
    if (lines.length < 2) problems.push(`${j.entry_number}: fewer than two lines`);
    let dr = 0;
    let cr = 0;
    for (const l of lines) {
      if (!accountFor.has(l.account_id)) {
        problems.push(`${j.entry_number}: account ${l.account_id} not imported`);
      }
      if (l.debit_or_credit === "debit") dr += paise(l.amount);
      else cr += paise(l.amount);
    }
    if (dr !== cr) problems.push(`${j.entry_number}: unbalanced, ${dr / 100} vs ${cr / 100}`);
  }
  if (problems.length) {
    throw new Error(
      `Cannot import — ${problems.length} problem(s):\n  ${problems.slice(0, 15).join("\n  ")}`,
    );
  }

  const value = todo.reduce(
    (s, j) => s + (j.line_items ?? []).filter((l) => l.debit_or_credit === "debit").reduce((t, l) => t + Number(l.amount), 0),
    0,
  );
  console.log(`${all.length} journals — ${todo.length} to import, ${done.size} already done`);
  console.log(`  value ${value.toLocaleString("en-IN")}`);
  console.log(`  dates ${todo[0]?.journal_date} .. ${todo[todo.length - 1]?.journal_date}`);
  console.log(`  lines ${todo.reduce((s, j) => s + (j.line_items?.length ?? 0), 0)}`);

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("No user to attribute the import to");

  await db.transaction(async (tx) => {
    for (const j of todo) {
      const jeId = await postJournal(tx, {
        entryDate: j.journal_date,
        narration: j.notes?.trim() || `Journal ${j.entry_number}`,
        // Zoho's own entry number, kept where it can still be searched for.
        reference: j.entry_number,
        sourceType: "manual",
        postedBy: admin.id,
        lines: (j.line_items ?? []).map((l) => ({
          accountId: accountFor.get(l.account_id)!,
          debit: l.debit_or_credit === "debit" ? money(l.amount) : undefined,
          credit: l.debit_or_credit === "credit" ? money(l.amount) : undefined,
          description: l.description?.trim() || undefined,
        })),
      });

      await tx.insert(zohoIdMap).values({
        entity: "journal",
        zohoId: j.journal_id,
        eggsyId: jeId,
        label: j.entry_number,
      });
    }
  });

  const [{ count }] = await db
    .select({ count: db.$count(journalEntries) })
    .from(journalEntries)
    .limit(1);
  console.log(`\nCommitted ${todo.length} journals. ${count} journal entries in the ledger.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
