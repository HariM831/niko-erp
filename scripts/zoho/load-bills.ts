/**
 * Phase 3: bills, posted through niko's own engine.
 *
 *   npx tsx scripts/zoho/load-bills.ts             # say what would happen
 *   npx tsx scripts/zoho/load-bills.ts --commit    # do it
 *
 * Better behaved than the invoices in one important way: every bill line names
 * an account, so none of the catch-all reclassification that the sales side
 * needed applies here. 1,959 of the 2,502 lines carry no item and no
 * description, which is normal for purchases — a freight charge or a service is
 * coded straight to an expense account.
 *
 * Two things the sales side did not have:
 *
 *   TDS. 89 bills withhold tax at source, ₹2.90 lakh in total. Zoho withholds
 *   it on the bill, so the expense is gross and the payable is net; that is now
 *   how niko posts it too.
 *
 *   Numbering. Zoho's bill_number is the vendor's own invoice number, not ours.
 *   It goes to vendorBillNumber and niko issues its own sequence.
 */
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { billLines, bills, contacts, journalEntries, users, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { postStoredBillJournal } from "../../server/routes/purchases";
import { postJournal } from "../../server/services/posting";

interface ZohoLine {
  item_id?: string;
  name?: string;
  description?: string;
  unit?: string;
  quantity: number;
  rate: number;
  item_total: number;
  account_id?: string;
  account_name?: string;
  hsn_or_sac?: string;
}

interface ZohoBill {
  bill_id: string;
  bill_number: string;
  vendor_id: string;
  status: string;
  date: string;
  due_date: string;
  reference_number?: string;
  notes?: string;
  sub_total: number;
  discount_total?: number;
  adjustment?: number;
  adjustment_description?: string;
  adjustment_account_id?: string;
  discount_account_id?: string;
  tds_amount?: number;
  tds_section?: string;
  total: number;
  balance: number;
  line_items: ZohoLine[];
}

/** Zoho's overdue is derived from the due date in niko, so it maps to open. */
const STATUS: Record<string, "draft" | "open" | "partially_paid" | "paid" | "void"> = {
  draft: "draft",
  open: "open",
  overdue: "open",
  unpaid: "open",
  partially_paid: "partially_paid",
  paid: "paid",
  void: "void",
  voided: "void",
};

const money = (n: number | undefined) => (n ?? 0).toFixed(2);
const paise = (n: number | undefined) => Math.round((n ?? 0) * 100);

async function main() {
  const commit = process.argv.includes("--commit");
  const raw = await readFile(".zoho-dump/detail/bills.jsonl", "utf8");
  const all: ZohoBill[] = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  all.sort((a, b) => a.date.localeCompare(b.date) || a.bill_id.localeCompare(b.bill_id));

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
  const done = await idsOf("bill");
  const todo = all.filter((b) => !done.has(b.bill_id));

  const problems: string[] = [];
  for (const b of todo) {
    if (!contactFor.has(b.vendor_id)) problems.push(`${b.bill_number}: vendor not imported`);
    if (!STATUS[b.status]) problems.push(`${b.bill_number}: unknown status "${b.status}"`);
    for (const l of b.line_items ?? []) {
      // Every purchase line must name an account: niko has no catch-all to
      // fall back to on the expense side, and inventing one would bury a cost.
      if (!l.account_id) problems.push(`${b.bill_number}: a line names no account`);
      else if (!accountFor.has(l.account_id)) {
        problems.push(`${b.bill_number}: account ${l.account_id} not imported`);
      }
      if (l.item_id && !itemFor.has(l.item_id)) {
        problems.push(`${b.bill_number}: item ${l.item_id} not imported`);
      }
    }
    // Lines, less what is withheld and discounted, plus the adjustment, must be
    // the total — or the journal will not balance.
    const lineSum = (b.line_items ?? []).reduce((s, l) => s + paise(l.item_total), 0);
    const expected =
      paise(b.total) + paise(b.tds_amount) + paise(b.discount_total) - paise(b.adjustment);
    if (lineSum !== expected) {
      problems.push(
        `${b.bill_number}: lines ${lineSum / 100} vs expected ${expected / 100} ` +
          `(total ${b.total}, tds ${b.tds_amount ?? 0}, discount ${b.discount_total ?? 0}, adj ${b.adjustment ?? 0})`,
      );
    }
  }
  if (problems.length) {
    throw new Error(
      `Cannot import — ${problems.length} problem(s):\n  ${problems.slice(0, 15).join("\n  ")}`,
    );
  }

  console.log(`${all.length} bills — ${todo.length} to import, ${done.size} already done`);
  console.log(`  value ${todo.reduce((s, b) => s + Number(b.total), 0).toLocaleString("en-IN")}`);
  console.log(`  dates ${todo[0]?.date} .. ${todo[todo.length - 1]?.date}`);
  console.log(`  lines ${todo.reduce((s, b) => s + (b.line_items?.length ?? 0), 0)}`);
  console.log(`  withholding TDS ${todo.filter((b) => Number(b.tds_amount ?? 0) !== 0).length}`);
  console.log(`  with an adjustment ${todo.filter((b) => Number(b.adjustment ?? 0) !== 0).length}`);
  console.log(`  with a header discount ${todo.filter((b) => Number(b.discount_total ?? 0) !== 0).length}`);

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("No user to attribute the import to");

  // niko issues its own bill numbers; Zoho's belong to the vendor. Numbered in
  // date order so a re-run produces the same sequence.
  const [{ next }] = await db
    .select({ next: sql<number>`COALESCE(MAX(SUBSTRING(number FROM '[0-9]+$')::int), 0) + 1` })
    .from(bills);
  let seq = Number(next ?? 1);
  let posted = 0;
  let zeroValue = 0;

  await db.transaction(async (tx) => {
    for (const b of todo) {
      const vendorId = contactFor.get(b.vendor_id)!;
      const number = `BILL-${String(seq++).padStart(6, "0")}`;
      // A header discount behaves exactly like a negative adjustment, as on the
      // sales side; only six bills have one and none also has an adjustment.
      const adjP = paise(b.adjustment) - paise(b.discount_total);
      const adjAccount = paise(b.discount_total)
        ? b.discount_account_id
        : b.adjustment_account_id;

      const [row] = await tx
        .insert(bills)
        .values({
          number,
          vendorBillNumber: b.bill_number?.trim() || null,
          vendorId,
          status: STATUS[b.status]!,
          billDate: b.date,
          dueDate: b.due_date || b.date,
          reference: b.reference_number?.trim() || null,
          subTotal: money(b.sub_total),
          discountTotal: "0",
          cgst: "0",
          sgst: "0",
          igst: "0",
          adjustment: (adjP / 100).toFixed(2),
          adjustmentAccountId: adjP !== 0 ? (accountFor.get(adjAccount ?? "") ?? null) : null,
          adjustmentDescription: b.adjustment_description?.trim() || null,
          roundOff: "0",
          tdsAmount: money(b.tds_amount),
          tdsSection: b.tds_section?.slice(0, 12) || null,
          total: money(b.total),
          balanceDue: money(b.balance),
          notes: b.notes?.trim() || null,
          createdBy: admin.id,
        })
        .returning();

      const lines = (b.line_items ?? []).map((l, i) => ({
        billId: row!.id,
        itemId: l.item_id ? (itemFor.get(l.item_id) ?? null) : null,
        accountId: accountFor.get(l.account_id!)!,
        // Most purchase lines have no description at all. The account they were
        // coded to is the only thing on record about them, so it stands in
        // rather than a made-up placeholder.
        name: l.name?.trim() || l.account_name?.trim() || "Purchase",
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
      if (lines.length) await tx.insert(billLines).values(lines);

      // Void bills never posted in Zoho and must not post here. Nor do the four
      // zero-value delivery challans: a bill for nothing has no journal, and
      // forcing one would mean inventing a line to balance it against.
      const hasMoney =
        paise(b.total) !== 0 ||
        paise(b.tds_amount) !== 0 ||
        (b.line_items ?? []).some((l) => paise(l.item_total) !== 0);
      if (hasMoney && STATUS[b.status] !== "void" && STATUS[b.status] !== "draft") {
        const jeId = await postStoredBillJournal(tx, row!.id, admin.id);
        await tx.update(bills).set({ journalEntryId: jeId }).where(eq(bills.id, row!.id));
        posted += 1;
      } else if (!hasMoney) {
        zeroValue += 1;
      }

      await tx.insert(zohoIdMap).values({
        entity: "bill",
        zohoId: b.bill_id,
        eggsyId: row!.id,
        label: `${number} (${b.bill_number})`,
      });
    }
  });

  /*
   * A bill with BOTH a header discount and an adjustment.
   *
   * niko's bill has one adjustment and one account for it, so the two are
   * netted onto the discount account — right in total, and wrong by the
   * adjustment on two accounts. There were none of these when that was written;
   * by the cutoff there was one (ST/2790: 1% discount of 1,447.10 and a 0.10
   * shortage deduction), and ten paise is still a difference. The adjustment is
   * moved to its own account by a journal beside the bill's. Run over every
   * imported bill each time, and it looks before it posts, so a second run adds
   * nothing.
   */
  let split = 0;
  await db.transaction(async (tx) => {
    const mapped = new Map(
      (await tx.select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId }).from(zohoIdMap).where(eq(zohoIdMap.entity, "bill"))).map((r) => [r.zohoId, r.eggsyId]),
    );
    for (const b of all) {
      const adjP = paise(b.adjustment);
      if (!paise(b.discount_total) || !adjP) continue;
      const billId = mapped.get(b.bill_id);
      const discountAcc = accountFor.get(b.discount_account_id ?? "");
      const adjustmentAcc = accountFor.get(b.adjustment_account_id ?? "");
      if (!billId || !discountAcc || !adjustmentAcc || discountAcc === adjustmentAcc) continue;
      const narration = `Bill ${b.bill_number} — adjustment apart from the discount`;
      const [done] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.sourceId, billId), eq(journalEntries.narration, narration)));
      if (done) continue;
      const [billRow] = await tx.select({ journalEntryId: bills.journalEntryId }).from(bills).where(eq(bills.id, billId));
      if (!billRow?.journalEntryId) continue; // void or draft: nothing was posted to correct
      const amount = (Math.abs(adjP) / 100).toFixed(2);
      // A positive adjustment raised the bill: it is a debit to its own account.
      const [toAdj, toDisc] = adjP > 0 ? (["debit", "credit"] as const) : (["credit", "debit"] as const);
      await postJournal(tx, {
        entryDate: b.date,
        narration,
        sourceType: "bill",
        sourceId: billId,
        postedBy: admin.id,
        lines: [
          { accountId: adjustmentAcc, [toAdj]: amount },
          { accountId: discountAcc, [toDisc]: amount },
        ] as never,
      });
      split += 1;
    }
  });
  if (split) console.log(`  ${split} bill(s) with both a discount and an adjustment: adjustment moved to its own account`);

  console.log(`\nCommitted ${todo.length} bills, numbered BILL-* in date order.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
