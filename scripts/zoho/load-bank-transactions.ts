/**
 * Phase 3: the money movements that have no document behind them.
 *
 *   npx tsx scripts/zoho/load-bank-transactions.ts             # dry run
 *   npx tsx scripts/zoho/load-bank-transactions.ts --commit    # do it
 *
 * Skipping these was my mistake. I judged them "the bank feed, already carried
 * by the payments and expenses" — and 5,398 of the 6,083 rows are exactly that,
 * with counts matching the imported documents to the record. The other 774 are
 * not: transfers between own accounts, deposits, owner contributions, refunds
 * and loan movements, ~75.2 crore of it, with no other route into the books.
 * Without them the banks were out by crores.
 *
 * Each is posted as a two-line journal: the bank on one side, the account Zoho
 * names as the offset on the other.
 *
 * 43 rows are not loaded — 31 vendor payment refunds, 2 customer refunds and 10
 * loan payments — because Zoho records no offset for them in the list, the
 * detail endpoint refuses to serve them, and the ledger carries an empty
 * offset_account_id. Guessing what a refund was posted against is not
 * something this script will do; they are reported instead.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { accounts, bankAccounts, users, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { postJournal } from "../../server/services/posting";

interface BankTxn {
  transaction_id: string;
  date: string;
  amount: number;
  transaction_type: string;
  transaction_type_formatted?: string;
  account_id: string;
  account_name?: string;
  debit_or_credit: "debit" | "credit";
  description?: string;
  reference_number?: string;
  payee?: string;
  offset_account_name?: string;
}

/**
 * The other side for the transactions Zoho records no offset against.
 *
 * Not inferred from the type alone — each was confirmed against Zoho's own
 * closing balance, which is only reachable by one account:
 *
 *   loan payments      Zoho Payroll - Loan Account is 37,400 short of Zoho's
 *                      figure, exactly their total. Staff loans paid out, not
 *                      borrowings repaid — the narration is empty on all ten,
 *                      so the balance is what identifies it.
 *   customer refunds   Unearned Revenue is 31,00,000 short, exactly their total.
 *   vendor refunds     Advance to Suppliers. A vendor returning money paid
 *                      ahead of any bill hands back the advance, not a payable.
 */
const OFFSET_BY_TYPE: Record<string, { systemKey?: string; code?: string }> = {
  // A vendor returning money it was paid ahead of any bill gives back the
  // advance, not a payable. Posting these to AP overstated it by 21.81 lakh —
  // the same error as debiting AP with the advance in the first place.
  vendorpayment_refund: { systemKey: "vendor_advances" },
  payment_refund: { systemKey: "customer_advances" },
  loan_payment: { code: "1149" },
};

/** Types that arrived as documents already and must not be posted twice. */
const ALREADY_IMPORTED = new Set(["expense", "vendor_payment", "customer_payment", "journal"]);

const money = (n: number | undefined) => (n ?? 0).toFixed(2);

async function main() {
  const commit = process.argv.includes("--commit");

  const rows: BankTxn[] = (await readFile(".zoho-dump/list/banktransactions.jsonl", "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  // Zoho re-serves some rows across page boundaries, so the same transaction
  // appears more than once in the file.
  const unique = [...new Map(rows.map((t) => [t.transaction_id, t])).values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.transaction_id.localeCompare(b.transaction_id),
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
  const bankFor = await idsOf("bank_account");
  const accountFor = await idsOf("account");
  const done = await idsOf("bank_transaction");

  // Offsets are named, not coded, so they have to be resolved by name. Match
  // against Zoho's own chart rather than EGGSY's, because accounts can be
  // renamed on the way in — Chicks(Sales) is Bird (Sales) here.
  const zohoAccounts: Array<{ account_id: string; account_name: string }> = [];
  for (const file of ["chartofaccounts", "chartofaccounts-extra"]) {
    const raw = await readFile(`.zoho-dump/list/${file}.jsonl`, "utf8").catch(() => "");
    for (const line of raw.trim().split("\n").filter(Boolean)) zohoAccounts.push(JSON.parse(line));
  }
  const byName = new Map<string, string[]>();
  for (const a of zohoAccounts) {
    const k = a.account_name.trim().toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), a.account_id]);
  }

  const glOfBank = new Map(
    (
      await db.select({ id: bankAccounts.id, glAccountId: bankAccounts.glAccountId }).from(bankAccounts)
    ).map((b) => [b.id, b.glAccountId]),
  );

  // Accounts reachable by system key or code, for the offsets Zoho leaves blank.
  const named = await db
    .select({ id: accounts.id, code: accounts.code, systemKey: accounts.systemKey })
    .from(accounts);
  const byKey = new Map(named.filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]));
  const byCode = new Map(named.map((a) => [a.code, a.id]));
  const fallbackOffset = (type: string): string | undefined => {
    const spec = OFFSET_BY_TYPE[type];
    if (!spec) return undefined;
    return spec.systemKey ? byKey.get(spec.systemKey) : byCode.get(spec.code!);
  };

  const candidates = unique.filter(
    (t) => !ALREADY_IMPORTED.has(t.transaction_type) && !done.has(t.transaction_id),
  );
  const noOffset = candidates.filter(
    (t) => !t.offset_account_name?.trim() && !fallbackOffset(t.transaction_type),
  );
  const todo = candidates.filter(
    (t) => t.offset_account_name?.trim() || fallbackOffset(t.transaction_type),
  );

  const problems: string[] = [];
  for (const t of todo) {
    if (!bankFor.has(t.account_id)) problems.push(`${t.date} ${t.transaction_type}: bank not imported`);
    if (!t.offset_account_name?.trim()) continue; // resolved by type instead
    const matches = byName.get(t.offset_account_name.trim().toLowerCase()) ?? [];
    if (matches.length === 0) {
      problems.push(`${t.date} ${t.transaction_type}: no account named "${t.offset_account_name}"`);
    } else if (matches.length > 1) {
      // Two accounts share the name, so which one Zoho meant is unknowable.
      problems.push(`${t.date} ${t.transaction_type}: "${t.offset_account_name}" is ambiguous`);
    } else if (!accountFor.has(matches[0]!)) {
      problems.push(`${t.date} ${t.transaction_type}: "${t.offset_account_name}" not imported`);
    }
  }
  if (problems.length) {
    throw new Error(
      `Cannot import — ${problems.length} problem(s):\n  ${problems.slice(0, 15).join("\n  ")}`,
    );
  }

  const byType = new Map<string, { n: number; amt: number }>();
  for (const t of todo) {
    const e = byType.get(t.transaction_type) ?? { n: 0, amt: 0 };
    e.n += 1;
    e.amt += Number(t.amount);
    byType.set(t.transaction_type, e);
  }

  console.log(`${unique.length} bank transactions on file`);
  console.log(`  ${unique.length - candidates.length - done.size} already in the books as documents`);
  console.log(`  ${todo.length} to post, ${todo.reduce((s, t) => s + Number(t.amount), 0).toLocaleString("en-IN")}`);
  for (const [type, e] of [...byType].sort((a, b) => b[1].amt - a[1].amt)) {
    console.log(`     ${type.padEnd(22)} ${String(e.n).padStart(4)}  ${e.amt.toLocaleString("en-IN")}`);
  }
  if (noOffset.length) {
    const val = noOffset.reduce((s, t) => s + Number(t.amount), 0);
    console.log(`  ${noOffset.length} cannot be posted — Zoho records no offset (${val.toLocaleString("en-IN")}):`);
    const g = new Map<string, number>();
    for (const t of noOffset) g.set(t.transaction_type, (g.get(t.transaction_type) ?? 0) + 1);
    for (const [k, n] of g) console.log(`     ${k.padEnd(22)} ${n}`);
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("No user to attribute the import to");

  await db.transaction(async (tx) => {
    for (const t of todo) {
      const bankGl = glOfBank.get(bankFor.get(t.account_id)!)!;
      const offsetGl = t.offset_account_name?.trim()
        ? accountFor.get(byName.get(t.offset_account_name.trim().toLowerCase())![0]!)!
        : fallbackOffset(t.transaction_type)!;
      const amount = money(t.amount);

      // Zoho's debit_or_credit is written from the bank's point of view, so a
      // debit is money arriving and the offset takes the other side.
      const lines =
        t.debit_or_credit === "debit"
          ? [
              { accountId: bankGl, debit: amount },
              { accountId: offsetGl, credit: amount },
            ]
          : [
              { accountId: offsetGl, debit: amount },
              { accountId: bankGl, credit: amount },
            ];

      const label = t.transaction_type_formatted || t.transaction_type;
      const jeId = await postJournal(tx, {
        entryDate: t.date,
        narration:
          t.description?.trim() ||
          `${label}${t.payee ? ` — ${t.payee}` : ""}${t.account_name ? ` (${t.account_name})` : ""}`,
        reference: t.reference_number?.trim() || undefined,
        sourceType: "manual",
        postedBy: admin.id,
        lines: lines.map((l) => ({ ...l, description: label })),
      });

      await tx.insert(zohoIdMap).values({
        entity: "bank_transaction",
        zohoId: t.transaction_id,
        eggsyId: jeId,
        label: `${t.date} ${label} ${amount}`,
      });
    }
  });

  console.log(`\nCommitted ${todo.length} bank transactions.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
