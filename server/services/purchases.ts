/**
 * Creating a bill, a vendor credit, and applying one to the other.
 *
 * These live here rather than in the route file because more than one module
 * raises a payable. Procurement settles a truck into a Bill and, when anything
 * is deducted, a Vendor Credit applied to it — the same documents a person
 * would key by hand, produced by the same code, so the two paths cannot drift.
 *
 * Everything takes a transaction handle: a document and its journal entry
 * commit together or not at all.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  billLineTags,
  billLines,
  bills,
  contacts,
  items,
  reportingTagOptions,
  vendorCreditApplications,
  vendorCreditLines,
  vendorCredits,
} from "@shared/schema";
import type { Db, Tx } from "../db";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError, postJournal } from "./posting";
import { computeDocumentTotals, fromPaise, toPaise, type DocLineInput } from "./documents";

/**
 * A line as the routes and other modules supply it.
 *
 * Structural rather than derived from a Zod schema, so a caller that builds
 * lines in code (procurement settlement) is on the same footing as one that
 * parsed them from a request body.
 */
export interface PurchaseLineInput {
  itemId?: string;
  accountId?: string;
  name: string;
  description?: string;
  hsnOrSac?: string;
  quantity: string;
  unit?: string;
  rate: string;
  discountPercent?: string;
  taxId?: string;
  /** Reporting tag options for this line — one option per tag. Bills only. */
  tagOptionIds?: string[];
}

export async function loadVendor(tx: Tx, id: string) {
  const [vendor] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), inArray(contacts.type, ["vendor", "both"])))
    .limit(1);
  if (!vendor) throw new PostingError("Vendor not found");
  if (!vendor.isActive) throw new PostingError("Vendor is inactive");
  return vendor;
}

/**
 * Resolve the debit account for each purchase line: explicit accountId wins,
 * else the item's purchase account. Throws if neither exists.
 */
export async function resolveLineAccounts<
  T extends { itemId?: string; accountId?: string; name: string },
>(tx: Tx, lines: T[]): Promise<(T & { accountId: string })[]> {
  const out: (T & { accountId: string })[] = [];
  for (const line of lines) {
    let accountId = line.accountId;
    if (!accountId && line.itemId) {
      const [item] = await tx
        .select({ purchaseAccountId: items.purchaseAccountId })
        .from(items)
        .where(eq(items.id, line.itemId))
        .limit(1);
      accountId = item?.purchaseAccountId ?? undefined;
    }
    if (!accountId) {
      throw new PostingError(
        `Line "${line.name}" needs an expense account (set one on the line or the item)`,
      );
    }
    const [acct] = await tx
      .select({ id: accounts.id, isActive: accounts.isActive })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!acct?.isActive) {
      throw new PostingError(`Account for line "${line.name}" is missing or inactive`);
    }
    out.push({ ...line, accountId });
  }
  return out;
}

export function computeDueDate(billDate: string, termsDays: number): string {
  const d = new Date(`${billDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + termsDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Bill journal: DR each line's account (net of discount), DR input GST,
 * CR Accounts Payable for the grand total. Round-off folds into the
 * first line's account group.
 */
export function buildBillJeLines(
  grouped: Map<string, { accountId: string; netP: number; tagOptionIds?: string[] }>,
  taxTotalP: number,
  roundOffP: number,
  totalP: number,
  billNumber: string,
  adjustment?: { paise: number; accountId: string | null },
  tdsP = 0,
) {
  const jeLines: Array<{
    accountId?: string;
    systemKey?: string;
    debit?: string;
    credit?: string;
    description?: string;
    tagOptionIds?: string[];
  }> = [];
  let first = true;
  for (const { accountId, netP, tagOptionIds } of grouped.values()) {
    const withRound = first ? netP + roundOffP : netP;
    first = false;
    if (withRound !== 0) {
      // Normally a debit: goods increase an expense. A bill may also carry
      // NEGATIVE lines — the deductions procurement settles against the goods —
      // and where those outweigh the goods on one account the account is
      // credited instead. Posting refuses negative amounts by design, so the
      // sign has to be expressed by the side it lands on, not by the figure.
      jeLines.push({
        accountId,
        ...(withRound > 0
          ? { debit: fromPaise(withRound) }
          : { credit: fromPaise(-withRound) }),
        description: `Bill ${billNumber}`,
        tagOptionIds,
      });
    }
  }
  if (taxTotalP > 0) jeLines.push({ systemKey: "input_gst", debit: fromPaise(taxTotalP) });

  // The adjustment is inside the payable, so its own account takes the other
  // side — debited when it increases what is owed, credited when it reduces it.
  if (adjustment && adjustment.paise !== 0) {
    if (!adjustment.accountId) {
      throw new PostingError(`Bill ${billNumber} has an adjustment but no account to post it to`);
    }
    jeLines.push(
      adjustment.paise > 0
        ? { accountId: adjustment.accountId, debit: fromPaise(adjustment.paise) }
        : { accountId: adjustment.accountId, credit: fromPaise(-adjustment.paise) },
    );
  }

  // Withheld tax is owed to the government rather than the vendor, so it
  // splits off the payable rather than reducing the cost.
  if (tdsP > 0) jeLines.push({ systemKey: "tds_payable", credit: fromPaise(tdsP) });
  jeLines.push({ systemKey: "ap", credit: fromPaise(totalP) });
  return jeLines;
}

/**
 * Split freight across lines in proportion to line value, in integer paise.
 * The rounding remainder lands on the largest line so the parts always sum
 * back to the whole.
 */
export function allocateFreight(lineAmountsP: number[], freightP: number): number[] {
  const allocated = lineAmountsP.map(() => 0);
  if (freightP <= 0) return allocated;
  const totalP = lineAmountsP.reduce((s, a) => s + a, 0);
  if (totalP <= 0) return allocated;

  let assigned = 0;
  for (let i = 0; i < lineAmountsP.length; i++) {
    allocated[i] = Math.floor((lineAmountsP[i]! * freightP) / totalP);
    assigned += allocated[i]!;
  }
  const remainder = freightP - assigned;
  if (remainder !== 0) {
    let largest = 0;
    for (let i = 1; i < lineAmountsP.length; i++) {
      if (lineAmountsP[i]! > lineAmountsP[largest]!) largest = i;
    }
    allocated[largest] = allocated[largest]! + remainder;
  }
  return allocated;
}

export interface BillComputation {
  resolvedLines: Awaited<ReturnType<typeof resolveLineAccounts>>;
  totals: Awaited<ReturnType<typeof computeDocumentTotals>>;
  computedLines: Awaited<ReturnType<typeof computeDocumentTotals>>["lines"];
  headerTotals: Omit<Awaited<ReturnType<typeof computeDocumentTotals>>, "lines">;
  freightP: number;
  allocatedP: number[];
  lineAmountsP: number[];
  /** Tax withheld at source, in paise. Reduces what the vendor is paid. */
  tdsP: number;
}

/**
 * Totals + freight allocation for a bill's lines. Freight is COSTING data only:
 * the third-party transporter is paid separately, so it never touches this
 * vendor's payable — it just tells us what the goods really cost per unit.
 * Shared by create and edit so the two can't drift apart.
 */
export async function computeBill(
  tx: Tx,
  vendor: typeof contacts.$inferSelect,
  lines: PurchaseLineInput[],
  freightAmount?: string,
  adjustment?: { amount: string; accountId?: string | null; description?: string | null },
  tdsAmount?: string,
): Promise<BillComputation> {
  const resolvedLines = await resolveLineAccounts(tx, lines);
  const totals = await computeDocumentTotals(
    tx,
    resolvedLines as DocLineInput[],
    vendor.placeOfSupplyState,
    adjustment,
  );
  const { lines: computedLines, ...rest } = totals;
  // Tax deducted at source is withheld from the vendor, so it comes off what
  // they are owed: the expense stays gross and the payable is net.
  const tdsP = toPaise(tdsAmount ?? "0");
  const headerTotals = { ...rest, total: fromPaise(toPaise(rest.total) - tdsP) };

  /**
   * A bill may carry negative lines — procurement settles deductions against
   * the goods on one document — but it may not come to less than nothing.
   *
   * At that point it is not a bill, it is a credit note, and forcing it through
   * would post a negative credit to Accounts Payable and leave a payable the
   * vendor owes US sitting in the payables ledger. Refused here rather than
   * deeper down, where the message would be about journal amounts instead of
   * about the document somebody is trying to raise.
   */
  if (toPaise(headerTotals.total) < 0) {
    const negativeP = computedLines
      .filter((l) => toPaise(l.amount) < 0)
      .reduce((s, l) => s - toPaise(l.amount), 0);
    throw new PostingError(
      `This bill comes to ${fromPaise(toPaise(headerTotals.total))} — deductions of ` +
        `${fromPaise(negativeP)} exceed the goods on it. Raise a vendor credit for the ` +
        `difference instead; a bill cannot be owed to us.`,
    );
  }
  const freightP = toPaise(freightAmount ?? "0");
  const lineAmountsP = computedLines.map((l) => toPaise(l.amount));
  const allocatedP = allocateFreight(lineAmountsP, freightP);
  return {
    resolvedLines,
    totals: { ...totals, total: headerTotals.total },
    computedLines,
    headerTotals,
    freightP,
    allocatedP,
    lineAmountsP,
    tdsP,
  };
}

/** Bill line rows with their costing columns filled in. */
export function billLineValues(c: BillComputation, billId: string) {
  return c.computedLines.map((l, i) => {
    const landedP = c.lineAmountsP[i]! + c.allocatedP[i]!;
    const qtyNum = Number(l.quantity);
    // tagOptionIds rides along on the computed line but is not a bill_lines
    // column — it belongs to bill_line_tags, inserted once the line has an id.
    const { tagOptionIds: _tags, ...columns } = l;
    return {
      ...columns,
      accountId: c.resolvedLines[i]!.accountId,
      billId,
      allocatedFreight: fromPaise(c.allocatedP[i]!),
      landedUnitCost: qtyNum > 0 ? fromPaise(Math.round(landedP / qtyNum)) : "0",
    };
  });
}

/** Stable key for a set of tags, so two lines tagged alike group together. */
const tagKey = (ids: string[] | undefined) => [...(ids ?? [])].sort().join(",");

/**
 * Persist each bill line's tags. Runs after the lines exist because the join
 * needs their ids. The unique index on (line, tag) is the backstop; this
 * refuses the same case with a message naming the problem.
 */
export async function saveBillLineTags(
  tx: Tx,
  c: BillComputation,
  insertedIds: Array<{ id: string; lineOrder: number }>,
): Promise<void> {
  const optionIds = [...new Set(c.computedLines.flatMap((l) => l.tagOptionIds ?? []))];
  if (!optionIds.length) return;

  const options = await tx
    .select({
      id: reportingTagOptions.id,
      tagId: reportingTagOptions.tagId,
      name: reportingTagOptions.name,
      isActive: reportingTagOptions.isActive,
    })
    .from(reportingTagOptions)
    .where(inArray(reportingTagOptions.id, optionIds));
  const byId = new Map(options.map((o) => [o.id, o]));
  const idByOrder = new Map(insertedIds.map((r) => [r.lineOrder, r.id]));

  const rows: Array<{ billLineId: string; tagId: string; optionId: string }> = [];
  c.computedLines.forEach((l, i) => {
    const billLineId = idByOrder.get(l.lineOrder ?? i);
    if (!billLineId) return;
    const seen = new Set<string>();
    for (const optionId of l.tagOptionIds ?? []) {
      const option = byId.get(optionId);
      if (!option) throw new PostingError("Unknown reporting tag option");
      if (!option.isActive) {
        throw new PostingError(`Tag option "${option.name}" is no longer in use`);
      }
      if (seen.has(option.tagId)) {
        throw new PostingError("A line can only carry one option per tag");
      }
      seen.add(option.tagId);
      rows.push({ billLineId, tagId: option.tagId, optionId });
    }
  });
  if (rows.length) await tx.insert(billLineTags).values(rows);
}

/**
 * The goods entry: line accounts debited, AP credited. Freight is excluded by design.
 *
 * Lines are grouped by account AND by their tags. Grouping on the account alone
 * would merge diesel for one vehicle with diesel for another into a single
 * ledger line, and the second vehicle's tag would have nowhere to go.
 */
export function billGoodsJeLines(c: BillComputation, number: string) {
  const grouped = new Map<string, { accountId: string; netP: number; tagOptionIds?: string[] }>();
  c.computedLines.forEach((l, i) => {
    const accountId = c.resolvedLines[i]!.accountId;
    const key = `${accountId}|${tagKey(l.tagOptionIds)}`;
    const existing = grouped.get(key);
    if (existing) existing.netP += toPaise(l.amount);
    else grouped.set(key, { accountId, netP: toPaise(l.amount), tagOptionIds: l.tagOptionIds });
  });
  const taxTotalP = toPaise(c.totals.cgst) + toPaise(c.totals.sgst) + toPaise(c.totals.igst);
  return buildBillJeLines(
    grouped,
    taxTotalP,
    toPaise(c.totals.roundOff),
    toPaise(c.totals.total),
    number,
    { paise: toPaise(c.totals.adjustment), accountId: c.totals.adjustmentAccountId },
    c.tdsP,
  );
}

/**
 * The transporter's charge is its own expense: DR freight expense, CR what we owe
 * them. Deliberately a separate entry so the goods vendor's payable stays clean.
 */
export async function postFreightJournal(
  tx: Tx,
  args: {
    freightP: number;
    freightAccountId?: string;
    freightVendorId?: string;
    billNumber: string;
    entryDate: string;
    postedBy: string;
  },
): Promise<string | null> {
  if (args.freightP <= 0) return null;
  if (!args.freightAccountId) {
    throw new PostingError("Freight needs an expense account to charge it to");
  }
  const carrier = args.freightVendorId
    ? await tx.query.contacts.findFirst({ where: eq(contacts.id, args.freightVendorId) })
    : null;
  return postJournal(tx, {
    entryDate: args.entryDate,
    narration: `Freight on ${args.billNumber}${carrier ? ` — ${carrier.displayName}` : ""}`,
    sourceType: "bill",
    postedBy: args.postedBy,
    lines: [
      {
        accountId: args.freightAccountId,
        debit: fromPaise(args.freightP),
        description: `Freight on ${args.billNumber}`,
      },
      { systemKey: "ap", credit: fromPaise(args.freightP) },
    ],
  });
}

export interface CreateBillArgs {
  vendor: typeof contacts.$inferSelect;
  /** Draw the bill number from this series; omitted means the default. */
  seriesId?: string;
  billDate: string;
  dueDate?: string;
  vendorBillNumber?: string;
  reference?: string;
  freightAmount?: string;
  freightVendorId?: string;
  freightAccountId?: string;
  notes?: string;
  purchaseOrderId?: string;
  adjustment?: { amount: string; accountId: string; description?: string };
  tdsAmount?: string;
  tdsSection?: string;
  lines: PurchaseLineInput[];
  postedBy: string;
}

/** Shared by direct bill creation and PO conversion. Posts the JE immediately (status "open"). */
/**
 * Keep each item's purchase rate at what the latest bill actually paid.
 *
 * The rate is read back from the ledger — the most recent non-void bill line
 * for the item, by bill date — rather than trusting the document in hand, so a
 * backdated bill cannot overwrite a newer price and voiding a bill walks the
 * rate back to the one before it. Deduction lines (negative) and unpriced
 * lines are ignored. Pass no ids to resync the whole master.
 */
export async function syncPurchaseRates(tx: Tx | Db, itemIds?: string[]): Promise<number> {
  const scope = itemIds?.length ? sql`AND i.id = ANY(${itemIds}::uuid[])` : sql``;
  const result = await tx.execute(sql`
    UPDATE items i
    SET cost_price = latest.rate::numeric(14,2)
    FROM (
      SELECT DISTINCT ON (bl.item_id) bl.item_id, bl.rate
      FROM bill_lines bl
      JOIN bills b ON b.id = bl.bill_id
      WHERE b.status <> 'void' AND bl.item_id IS NOT NULL AND bl.rate::numeric > 0 AND bl.amount::numeric > 0
      ORDER BY bl.item_id, b.bill_date DESC, b.created_at DESC
    ) latest
    WHERE i.id = latest.item_id
      AND i.cost_price IS DISTINCT FROM latest.rate::numeric(14,2)
      ${scope}
  `);
  return result.rowCount ?? 0;
}

export async function createBill(tx: Tx, args: CreateBillArgs) {
  const vendor = args.vendor;
  const c = await computeBill(
    tx,
    vendor,
    args.lines,
    args.freightAmount,
    args.adjustment,
    args.tdsAmount,
  );
  const { headerTotals, freightP } = c;
  const number = await nextDocumentNumber(tx, "bill", args.seriesId);
  const dueDate = args.dueDate ?? computeDueDate(args.billDate, args.vendor.paymentTermsDays);

  const [bill] = await tx
    .insert(bills)
    .values({
      number,
      vendorBillNumber: args.vendorBillNumber,
      vendorId: args.vendor.id,
      status: "open",
      billDate: args.billDate,
      dueDate,
      reference: args.reference,
      purchaseOrderId: args.purchaseOrderId,
      ...headerTotals,
      freightAmount: fromPaise(freightP),
      freightVendorId: args.freightVendorId,
      freightAccountId: args.freightAccountId,
      tdsAmount: fromPaise(c.tdsP),
      tdsSection: args.tdsSection,
      balanceDue: headerTotals.total,
      notes: args.notes,
      createdBy: args.postedBy,
    })
    .returning();

  const insertedLines = await tx
    .insert(billLines)
    .values(billLineValues(c, bill!.id))
    .returning({ id: billLines.id, lineOrder: billLines.lineOrder });
  await saveBillLineTags(tx, c, insertedLines);

  // The item master's purchase rate follows the latest bill.
  const billedItemIds = [...new Set(c.computedLines.map((l) => l.itemId).filter((v): v is string => !!v))];
  if (billedItemIds.length) await syncPurchaseRates(tx, billedItemIds);

  const jeId = await postJournal(tx, {
    entryDate: args.billDate,
    narration: `Bill ${number} — ${args.vendor.displayName}`,
    sourceType: "bill",
    sourceId: bill!.id,
    postedBy: args.postedBy,
    lines: billGoodsJeLines(c, number),
  });
  const freightJeId = await postFreightJournal(tx, {
    freightP,
    freightAccountId: args.freightAccountId,
    freightVendorId: args.freightVendorId,
    billNumber: number,
    entryDate: args.billDate,
    postedBy: args.postedBy,
  });

  const [updated] = await tx
    .update(bills)
    .set({ journalEntryId: jeId, freightJournalEntryId: freightJeId ?? undefined })
    .where(eq(bills.id, bill!.id))
    .returning();
  return updated!;
}

/** Reverse of a bill's posting: DR AP, CR the line accounts + input GST. */
export function buildVendorCreditJeLines(
  computedLines: Awaited<ReturnType<typeof computeDocumentTotals>>["lines"],
  resolvedLines: Awaited<ReturnType<typeof resolveLineAccounts>>,
  totals: Awaited<ReturnType<typeof computeDocumentTotals>>,
  number: string,
) {
  const grouped = new Map<string, number>();
  computedLines.forEach((l, i) => {
    const acct = resolvedLines[i]!.accountId;
    grouped.set(acct, (grouped.get(acct) ?? 0) + toPaise(l.amount));
  });
  const taxTotalP = toPaise(totals.cgst) + toPaise(totals.sgst) + toPaise(totals.igst);

  const jeLines: Array<{
    accountId?: string;
    systemKey?: string;
    debit?: string;
    credit?: string;
    description?: string;
  }> = [{ systemKey: "ap", debit: totals.total, description: `Vendor credit ${number}` }];
  let first = true;
  for (const [accountId, netP] of grouped) {
    const withRound = first ? netP + toPaise(totals.roundOff) : netP;
    first = false;
    if (withRound !== 0) jeLines.push({ accountId, credit: fromPaise(withRound) });
  }
  if (taxTotalP > 0) jeLines.push({ systemKey: "input_gst", credit: fromPaise(taxTotalP) });
  return jeLines;
}

export interface CreateVendorCreditArgs {
  vendor: typeof contacts.$inferSelect;
  seriesId?: string;
  creditDate: string;
  reference?: string;
  /** The bill this credit relates to; applying it is a separate step. */
  billId?: string;
  notes?: string;
  /**
   * Overrides the journal narration.
   *
   * A credit raised by a machine should say what it worked out and how. Six
   * months on, "Vendor credit VC-000016" tells a reader nothing; "490 kg short
   * of 40,790 × ₹23.10/kg" lets them check the arithmetic without opening the
   * receipt it came from.
   */
  narration?: string;
  /**
   * `ruleId`/`ruleVersion` pass straight through `computeDocumentTotals`, which
   * spreads each input line, so a rule-driven deduction lands on its credit
   * line without any threading here.
   */
  lines: Array<PurchaseLineInput & { ruleId?: string | null; ruleVersion?: number | null }>;
  postedBy: string;
}

export async function createVendorCredit(tx: Tx, args: CreateVendorCreditArgs) {
  const vendor = args.vendor;
  const resolvedLines = await resolveLineAccounts(tx, args.lines);
  const totals = await computeDocumentTotals(
    tx,
    resolvedLines as DocLineInput[],
    vendor.placeOfSupplyState,
  );
  const number = await nextDocumentNumber(tx, "vendor_credit", args.seriesId);
  const { lines: computedLines, ...headerTotals } = totals;

  const [vc] = await tx
    .insert(vendorCredits)
    .values({
      number,
      vendorId: vendor.id,
      status: "open",
      creditDate: args.creditDate,
      reference: args.reference,
      billId: args.billId,
      ...headerTotals,
      balance: headerTotals.total,
      notes: args.notes,
      createdBy: args.postedBy,
    })
    .returning();
  await tx.insert(vendorCreditLines).values(
    computedLines.map((l, i) => ({
      ...l,
      accountId: resolvedLines[i]!.accountId,
      vendorCreditId: vc!.id,
    })),
  );

  const jeId = await postJournal(tx, {
    entryDate: args.creditDate,
    narration: args.narration ?? `Vendor credit ${number} — ${vendor.displayName}`,
    sourceType: "vendor_credit",
    sourceId: vc!.id,
    postedBy: args.postedBy,
    lines: buildVendorCreditJeLines(computedLines, resolvedLines, totals, number),
  });
  const [updated] = await tx
    .update(vendorCredits)
    .set({ journalEntryId: jeId })
    .where(eq(vendorCredits.id, vc!.id))
    .returning();
  return updated!;
}

/**
 * Apply an open vendor credit against one or more of that vendor's bills.
 *
 * No journal is posted: the credit already moved AP when it was raised, so
 * this only records which bills it covers and walks their balances down.
 */
export async function applyVendorCredit(
  tx: Tx,
  args: {
    vendorCreditId: string;
    applications: Array<{ billId: string; amount: string }>;
  },
) {
  const vc = await tx.query.vendorCredits.findFirst({
    where: eq(vendorCredits.id, args.vendorCreditId),
  });
  if (!vc) throw new PostingError("Vendor credit not found");
  if (vc.status !== "open") throw new PostingError("Vendor credit is not open");

  let appliedP = 0;
  for (const app of args.applications) {
    const bill = await tx.query.bills.findFirst({ where: eq(bills.id, app.billId) });
    if (!bill) throw new PostingError(`Bill not found: ${app.billId}`);
    if (bill.vendorId !== vc.vendorId) {
      throw new PostingError(`Bill ${bill.number} belongs to a different vendor`);
    }
    if (bill.status !== "open" && bill.status !== "partially_paid") {
      throw new PostingError(`Bill ${bill.number} is not open`);
    }
    const appP = toPaise(app.amount);
    if (appP <= 0) throw new PostingError("Application amounts must be positive");
    if (appP > toPaise(bill.balanceDue)) {
      throw new PostingError(`Amount exceeds balance due on ${bill.number}`);
    }
    appliedP += appP;

    await tx.insert(vendorCreditApplications).values({
      vendorCreditId: vc.id,
      billId: bill.id,
      amountApplied: app.amount,
    });
    const newBalanceP = toPaise(bill.balanceDue) - appP;
    // A credit is not a payment. Reducing a bill by a credit note leaves it
    // OPEN at a smaller balance — nobody has sent money, and calling it
    // partially paid puts the bill at odds with Payments Made and makes
    // "what have we actually paid this vendor" unanswerable without digging.
    //
    // A bill already part-paid in cash keeps that status; a credit that clears
    // the balance outright still becomes paid, because nothing more is owed.
    const status =
      newBalanceP === 0 ? "paid" : bill.status === "partially_paid" ? "partially_paid" : "open";
    await tx
      .update(bills)
      .set({ balanceDue: fromPaise(newBalanceP), status, updatedAt: new Date() })
      .where(eq(bills.id, bill.id));
  }

  if (appliedP > toPaise(vc.balance)) {
    throw new PostingError("Applied total exceeds the vendor credit balance");
  }
  const newBalanceP = toPaise(vc.balance) - appliedP;
  const [updated] = await tx
    .update(vendorCredits)
    .set({
      balance: fromPaise(newBalanceP),
      status: newBalanceP === 0 ? "closed" : "open",
    })
    .where(eq(vendorCredits.id, vc.id))
    .returning();
  return updated!;
}

/** Existing lines of a vendor credit, shaped for a re-state. */
export async function vendorCreditLineInputs(tx: Tx, vendorCreditId: string): Promise<PurchaseLineInput[]> {
  const existing = await tx
    .select()
    .from(vendorCreditLines)
    .where(eq(vendorCreditLines.vendorCreditId, vendorCreditId))
    .orderBy(asc(vendorCreditLines.lineOrder));
  return existing.map((l) => ({
    itemId: l.itemId ?? undefined,
    accountId: l.accountId ?? undefined,
    name: l.name,
    description: l.description ?? undefined,
    hsnOrSac: l.hsnOrSac ?? undefined,
    quantity: l.quantity,
    unit: l.unit ?? undefined,
    rate: l.rate,
    discountPercent: l.discountPercent,
    taxId: l.taxId ?? undefined,
  }));
}
