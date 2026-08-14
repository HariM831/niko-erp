/**
 * Phase 3: the vendor credits Zoho's list endpoint denies exist.
 *
 *   npx tsx scripts/zoho/load-vendor-credits.ts             # dry run
 *   npx tsx scripts/zoho/load-vendor-credits.ts --commit    # do it
 *
 * Twelve credits, ₹37,32,360, applied across 20 bills. They are why seven
 * vendors read as still owing money Zoho considers settled — Vastech's bill 89
 * was paid ₹4,81,235 in cash and ₹30,32,753 in credit — and why Feed &
 * Additives and Poultry Sheds were overstated.
 *
 * Posted as the reverse of a bill: the payable is debited and the accounts the
 * original cost went to are credited, so the expense unwinds where it was
 * charged rather than in a lump.
 *
 * All twelve are closed with a zero balance, which is Zoho's state, so the
 * applications are recorded but the bills' own balances are left alone — those
 * already came across net of the credit.
 */
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import {
  contacts,
  users,
  vendorCreditApplications,
  vendorCreditLines,
  vendorCredits,
  zohoIdMap,
} from "@shared/schema";
import { db, pool } from "../../server/db";
import { postJournal } from "../../server/services/posting";

interface ZohoLine {
  item_id?: string;
  account_id?: string;
  account_name?: string;
  name?: string;
  description?: string;
  unit?: string;
  quantity: number;
  rate: number;
  item_total: number;
  hsn_or_sac?: string;
}

interface ZohoVendorCredit {
  vendor_credit_id: string;
  vendor_credit_number: string;
  vendor_id: string;
  vendor_name?: string;
  date: string;
  status: string;
  reference_number?: string;
  notes?: string;
  sub_total: number;
  adjustment?: number;
  adjustment_account_id?: string;
  total: number;
  balance: number;
  line_items: ZohoLine[];
  bills_credited?: Array<{ bill_id: string; bill_number: string; amount: number }>;
}

const STATUS: Record<string, "draft" | "open" | "closed" | "void"> = {
  draft: "draft",
  open: "open",
  closed: "closed",
  void: "void",
  voided: "void",
};

const money = (n: number | undefined) => (n ?? 0).toFixed(2);
const paise = (n: number | undefined) => Math.round((n ?? 0) * 100);

async function main() {
  const commit = process.argv.includes("--commit");
  const all: ZohoVendorCredit[] = (await readFile(".zoho-dump/detail/vendorcredits.jsonl", "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  all.sort((a, b) => a.date.localeCompare(b.date) || a.vendor_credit_id.localeCompare(b.vendor_credit_id));

  const idsOf = async (entity: string) =>
    new Map(
      (
        await db
          .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
          .from(zohoIdMap)
          .where(eq(zohoIdMap.entity, entity))
      ).map((r) => [r.zohoId, r.eggsyId]),
    );
  const contactFor = await idsOf("contact");
  const itemFor = await idsOf("item");
  const accountFor = await idsOf("account");
  const billFor = await idsOf("bill");
  const done = await idsOf("vendor_credit");
  const todo = all.filter((c) => !done.has(c.vendor_credit_id));

  const problems: string[] = [];
  for (const c of todo) {
    if (!contactFor.has(c.vendor_id)) problems.push(`${c.vendor_credit_number}: vendor not imported`);
    if (!STATUS[c.status]) problems.push(`${c.vendor_credit_number}: unknown status "${c.status}"`);
    for (const l of c.line_items ?? []) {
      if (!l.account_id) problems.push(`${c.vendor_credit_number}: a line names no account`);
      else if (!accountFor.has(l.account_id)) {
        problems.push(`${c.vendor_credit_number}: account ${l.account_id} not imported`);
      }
    }
    for (const b of c.bills_credited ?? []) {
      if (!billFor.has(b.bill_id)) {
        problems.push(`${c.vendor_credit_number}: credited to bill ${b.bill_number}, not imported`);
      }
    }
    const lineSum = (c.line_items ?? []).reduce((s, l) => s + paise(l.item_total), 0);
    if (lineSum !== paise(c.total) - paise(c.adjustment)) {
      problems.push(
        `${c.vendor_credit_number}: lines ${lineSum / 100} against a total of ${c.total}`,
      );
    }
  }
  if (problems.length) {
    throw new Error(`Cannot import:\n  ${problems.slice(0, 15).join("\n  ")}`);
  }

  console.log(`${all.length} vendor credits — ${todo.length} to import, ${done.size} already done`);
  console.log(`  value ${todo.reduce((s, c) => s + Number(c.total), 0).toLocaleString("en-IN")}`);
  console.log(`  applied across ${todo.reduce((s, c) => s + (c.bills_credited?.length ?? 0), 0)} bills`);
  for (const c of todo) {
    console.log(
      `     ${c.date}  ${String(c.vendor_credit_number).padEnd(18)} ${String(c.vendor_name).slice(0, 30).padEnd(32)} ${Number(c.total).toLocaleString("en-IN")}`,
    );
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("No user to attribute the import to");

  // EGGSY issues its own numbers; Zoho's belong to the vendor and go to
  // reference, the same rule bills follow.
  const [{ next }] = await db
    .select({ next: sql<number>`COALESCE(MAX(SUBSTRING(number FROM '[0-9]+$')::int), 0) + 1` })
    .from(vendorCredits);
  let seq = Number(next ?? 1);

  await db.transaction(async (tx) => {
    for (const c of todo) {
      const vendorId = contactFor.get(c.vendor_id)!;
      const number = `VC-${String(seq++).padStart(6, "0")}`;

      const [row] = await tx
        .insert(vendorCredits)
        .values({
          number,
          vendorId,
          status: STATUS[c.status]!,
          creditDate: c.date,
          reference: c.reference_number?.trim() || c.vendor_credit_number,
          subTotal: money(c.sub_total),
          discountTotal: "0",
          cgst: "0",
          sgst: "0",
          igst: "0",
          adjustment: money(c.adjustment),
          adjustmentAccountId:
            paise(c.adjustment) !== 0 ? (accountFor.get(c.adjustment_account_id ?? "") ?? null) : null,
          roundOff: "0",
          total: money(c.total),
          balance: money(c.balance),
          notes: c.notes?.trim() || null,
          createdBy: admin.id,
        })
        .returning();

      const lines = (c.line_items ?? []).map((l, i) => ({
        vendorCreditId: row!.id,
        itemId: l.item_id ? (itemFor.get(l.item_id) ?? null) : null,
        accountId: accountFor.get(l.account_id!)!,
        name: l.name?.trim() || l.description?.trim() || l.account_name?.trim() || "Credit",
        description: l.description?.trim() || null,
        hsnOrSac: l.hsn_or_sac?.trim().slice(0, 10) || null,
        quantity: String(l.quantity ?? 0),
        unit: l.unit?.trim().slice(0, 20) || null,
        rate: money(l.rate),
        discountPercent: "0",
        taxAmount: "0",
        amount: money(l.item_total),
        lineOrder: i,
      }));
      if (lines.length) await tx.insert(vendorCreditLines).values(lines);

      for (const b of c.bills_credited ?? []) {
        if (paise(b.amount) === 0) continue;
        await tx.insert(vendorCreditApplications).values({
          vendorCreditId: row!.id,
          billId: billFor.get(b.bill_id)!,
          amountApplied: money(b.amount),
        });
      }

      // The reverse of a bill: debit the payable, credit back the accounts the
      // cost was charged to, grouped so one account gets one line.
      const grouped = new Map<string, number>();
      for (const l of lines) {
        grouped.set(l.accountId, (grouped.get(l.accountId) ?? 0) + paise(Number(l.amount)));
      }
      const [vendor] = await tx
        .select({ displayName: contacts.displayName })
        .from(contacts)
        .where(eq(contacts.id, vendorId))
        .limit(1);

      const jeLines: Array<Record<string, string | undefined>> = [
        { systemKey: "ap", debit: money(c.total), description: `Vendor credit ${number}` },
      ];
      for (const [accountId, p] of grouped) {
        if (p !== 0) jeLines.push({ accountId, credit: (p / 100).toFixed(2) });
      }
      const adjP = paise(c.adjustment);
      if (adjP !== 0) {
        const acct = accountFor.get(c.adjustment_account_id ?? "");
        if (!acct) throw new Error(`${number}: adjustment with no account`);
        jeLines.push(
          adjP > 0
            ? { accountId: acct, credit: (adjP / 100).toFixed(2) }
            : { accountId: acct, debit: (-adjP / 100).toFixed(2) },
        );
      }

      const jeId = await postJournal(tx, {
        entryDate: c.date,
        narration: `Vendor credit ${number} — ${vendor?.displayName ?? ""}`,
        reference: c.vendor_credit_number,
        sourceType: "vendor_credit",
        sourceId: row!.id,
        postedBy: admin.id,
        lines: jeLines as never,
      });
      await tx
        .update(vendorCredits)
        .set({ journalEntryId: jeId })
        .where(eq(vendorCredits.id, row!.id));

      await tx.insert(zohoIdMap).values({
        entity: "vendor_credit",
        zohoId: c.vendor_credit_id,
        eggsyId: row!.id,
        label: `${number} (${c.vendor_credit_number})`,
      });
    }
  });

  console.log(`\nCommitted ${todo.length} vendor credits, all posted.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
