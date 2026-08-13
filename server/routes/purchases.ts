import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  bankAccounts,
  billLineTags,
  billLines,
  bills,
  contacts,
  expenses,
  items,
  journalEntryLineTags,
  journalEntryLines,
  paymentMode,
  reportingTagOptions,
  reportingTags,
  purchaseOrderLines,
  purchaseOrders,
  users,
  vendorCreditApplications,
  vendorCreditLines,
  vendorCredits,
  vendorPaymentApplications,
  vendorPayments,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError, postJournal, reverseJournal } from "../services/posting";
import { readCustomFieldValues, saveCustomFieldValues } from "../services/custom-fields";
import {
  computeDocumentTotals,
  fromPaise,
  toPaise,
  type DocLineInput,
} from "../services/documents";

export const purchasesRouter = Router();

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lineSchema = z.object({
  itemId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  hsnOrSac: z.string().max(10).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/),
  unit: z.string().max(20).optional(),
  rate: money,
  discountPercent: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  taxId: z.string().uuid().optional(),
});

/**
 * Bills carry reporting tags; purchase orders and vendor credits do not, so
 * they keep the plain line schema. Accepting a field one of them would quietly
 * drop is worse than refusing it.
 */
const billLineSchema = lineSchema.extend({
  /** Reporting tag options for this line — one option per tag. */
  tagOptionIds: z.array(z.string().uuid()).max(10).optional(),
});

async function loadVendor(tx: Tx, id: string) {
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
async function resolveLineAccounts<T extends { itemId?: string; accountId?: string; name: string }>(
  tx: Tx,
  lines: T[],
): Promise<(T & { accountId: string })[]> {
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
    if (!acct?.isActive) throw new PostingError(`Account for line "${line.name}" is missing or inactive`);
    out.push({ ...line, accountId });
  }
  return out;
}

function computeDueDate(billDate: string, termsDays: number): string {
  const d = new Date(`${billDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + termsDays);
  return d.toISOString().slice(0, 10);
}

function handlePostingError(err: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * Bill journal: DR each line's account (net of discount), DR input GST,
 * CR Accounts Payable for the grand total. Round-off folds into the
 * first line's account group.
 */
function buildBillJeLines(
  grouped: Map<string, { accountId: string; netP: number; tagOptionIds?: string[] }>,
  taxTotalP: number,
  roundOffP: number,
  totalP: number,
  billNumber: string,
  adjustment?: { paise: number; accountId: string | null },
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
      jeLines.push({
        accountId,
        debit: fromPaise(withRound),
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

  jeLines.push({ systemKey: "ap", credit: fromPaise(totalP) });
  return jeLines;
}

// ============================ Purchase Orders ============================

const poSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  vendorId: z.string().uuid(),
  orderDate: dateStr,
  expectedDeliveryDate: dateStr.optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  termsAndConditions: z.string().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

purchasesRouter.get("/orders", requirePermission("purchases", "view"), async (req, res) => {
  const { vendorId, status, from, to } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (vendorId) conditions.push(eq(purchaseOrders.vendorId, vendorId));
  if (status) conditions.push(eq(purchaseOrders.status, status as typeof purchaseOrders.$inferSelect.status));
  if (from) conditions.push(gte(purchaseOrders.orderDate, from));
  if (to) conditions.push(lte(purchaseOrders.orderDate, to));
  const rows = await db
    .select({ ...getTableColumns(purchaseOrders), contactName: contacts.displayName })
    .from(purchaseOrders)
    .leftJoin(contacts, eq(contacts.id, purchaseOrders.vendorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(purchaseOrders.orderDate))
    .limit(200);
  res.json(rows);
});

purchasesRouter.get("/orders/:id", requirePermission("purchases", "view"), async (req, res) => {
  const po = await db.query.purchaseOrders.findFirst({
    where: eq(purchaseOrders.id, req.params.id!),
  });
  if (!po) return res.status(404).json({ error: "Purchase order not found" });
  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(asc(purchaseOrderLines.lineOrder));
  res.json({ ...po, lines });
});

/** A PO posts no journal, so editing is a plain re-state — but not once it's been billed. */
purchasesRouter.patch(
  "/orders/:id",
  requirePermission("purchases", "edit"),
  validateBody(poSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof poSchema>>;
    try {
      const result = await db.transaction(async (tx) => {
        const po = await tx.query.purchaseOrders.findFirst({
          where: eq(purchaseOrders.id, req.params.id!),
        });
        if (!po) throw new PostingError("Purchase order not found");
        if (po.status === "billed" || po.status === "partially_billed") {
          throw new PostingError("This purchase order has been billed — edit the bill instead");
        }
        if (po.status === "cancelled") throw new PostingError("A cancelled purchase order cannot be edited");

        const vendor = await loadVendor(tx, body.vendorId ?? po.vendorId);
        let totalsPatch = {};
        if (body.lines) {
          const resolvedLines = await resolveLineAccounts(tx, body.lines);
          const totals = await computeDocumentTotals(
            tx,
            resolvedLines as DocLineInput[],
            vendor.placeOfSupplyState,
          );
          const { lines: computedLines, ...headerTotals } = totals;
          await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
          await tx.insert(purchaseOrderLines).values(
            computedLines.map((l, i) => ({
              ...l,
              accountId: resolvedLines[i]!.accountId,
              purchaseOrderId: po.id,
            })),
          );
          totalsPatch = headerTotals;
        }

        const [updated] = await tx
          .update(purchaseOrders)
          .set({
            vendorId: vendor.id,
            orderDate: body.orderDate ?? po.orderDate,
            expectedDeliveryDate: body.expectedDeliveryDate ?? po.expectedDeliveryDate,
            reference: body.reference ?? po.reference,
            notes: body.notes ?? po.notes,
            termsAndConditions: body.termsAndConditions ?? po.termsAndConditions,
            ...totalsPatch,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrders.id, po.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.post(
  "/orders",
  requirePermission("purchases", "create"),
  validateBody(poSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof poSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        const vendor = await loadVendor(tx, body.vendorId);
        const resolvedLines = await resolveLineAccounts(tx, body.lines);
        const totals = await computeDocumentTotals(
          tx,
          resolvedLines as DocLineInput[],
          vendor.placeOfSupplyState,
        );
        const number = await nextDocumentNumber(tx, "purchase_order", body.seriesId);
        const { lines: computedLines, ...headerTotals } = totals;
        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            number,
            vendorId: vendor.id,
            orderDate: body.orderDate,
            expectedDeliveryDate: body.expectedDeliveryDate,
            reference: body.reference,
            ...headerTotals,
            notes: body.notes,
            termsAndConditions: body.termsAndConditions,
            createdBy: req.session.user!.id,
          })
          .returning();
        await tx.insert(purchaseOrderLines).values(
          computedLines.map((l, i) => ({
            ...l,
            accountId: resolvedLines[i]!.accountId,
            purchaseOrderId: po!.id,
          })),
        );
        return po!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.post(
  "/orders/:id/status",
  requirePermission("purchases", "edit"),
  validateBody(z.object({ status: z.enum(["issued", "closed", "cancelled"]) })),
  async (req, res) => {
    const allowed: Record<string, string[]> = {
      draft: ["issued", "cancelled"],
      issued: ["closed", "cancelled"],
      partially_billed: ["closed"],
      billed: ["closed"],
    };
    const po = await db.query.purchaseOrders.findFirst({
      where: eq(purchaseOrders.id, req.params.id!),
    });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });
    if (!allowed[po.status]?.includes(req.body.status)) {
      return res
        .status(422)
        .json({ error: `Cannot move purchase order from ${po.status} to ${req.body.status}` });
    }
    const [updated] = await db
      .update(purchaseOrders)
      .set({ status: req.body.status, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, po.id))
      .returning();
    res.json(updated);
  },
);

/** Convert an issued PO to a bill, carrying lines and tracking billed qty. */
purchasesRouter.post(
  "/orders/:id/convert-to-bill",
  requirePermission("purchases", "create"),
  validateBody(
    z.object({
      billDate: dateStr,
      vendorBillNumber: z.string().optional(),
    }),
  ),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const po = await tx.query.purchaseOrders.findFirst({
          where: eq(purchaseOrders.id, req.params.id!),
        });
        if (!po) throw new PostingError("Purchase order not found");
        if (po.status !== "issued" && po.status !== "partially_billed") {
          throw new PostingError(`Cannot bill a purchase order in status "${po.status}"`);
        }
        const vendor = await loadVendor(tx, po.vendorId);
        const poLines = await tx
          .select()
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
          .orderBy(asc(purchaseOrderLines.lineOrder));

        const bill = await createBill(tx, {
          vendor,
          billDate: req.body.billDate,
          vendorBillNumber: req.body.vendorBillNumber,
          purchaseOrderId: po.id,
          lines: poLines.map((l) => ({
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
          })),
          postedBy: req.session.user!.id,
        });

        for (const l of poLines) {
          await tx
            .update(purchaseOrderLines)
            .set({ billedQuantity: l.quantity })
            .where(eq(purchaseOrderLines.id, l.id));
        }
        await tx
          .update(purchaseOrders)
          .set({ status: "billed", updatedAt: new Date() })
          .where(eq(purchaseOrders.id, po.id));
        return bill;
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

// ============================ Bills ============================

const billSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  vendorId: z.string().uuid(),
  billDate: dateStr,
  dueDate: dateStr.optional(),
  vendorBillNumber: z.string().optional(),
  reference: z.string().optional(),
  freightAmount: money.optional(),
  freightVendorId: z.string().uuid().optional(),
  freightAccountId: z.string().uuid().optional(),
  notes: z.string().optional(),
  /** Custom field values, keyed by field id. */
  customFields: z.record(z.string(), z.any()).optional(),
  /**
   * A manual correction to the total, posted to its own account rather than
   * folded into revenue or cost.
   */
  adjustment: z
    .object({
      amount: money,
      accountId: z.string().uuid(),
      description: z.string().max(100).optional(),
    })
    .optional(),
  lines: z.array(billLineSchema).min(1).max(200),
});

interface CreateBillArgs {
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
  lines: Array<z.infer<typeof lineSchema>>;
  postedBy: string;
}

/**
 * Split freight across lines in proportion to line value, in integer paise.
 * The rounding remainder lands on the largest line so the parts always sum
 * back to the freight total exactly. Costing only — see createBill.
 */
function allocateFreight(lineAmountsP: number[], freightP: number): number[] {
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

/** Shared by direct bill creation and PO conversion. Posts the JE immediately (status "open"). */
interface BillComputation {
  resolvedLines: Awaited<ReturnType<typeof resolveLineAccounts>>;
  totals: Awaited<ReturnType<typeof computeDocumentTotals>>;
  computedLines: Awaited<ReturnType<typeof computeDocumentTotals>>["lines"];
  headerTotals: Omit<Awaited<ReturnType<typeof computeDocumentTotals>>, "lines">;
  freightP: number;
  allocatedP: number[];
  lineAmountsP: number[];
}

/**
 * Totals + freight allocation for a bill's lines. Freight is COSTING data only:
 * the third-party transporter is paid separately, so it never touches this
 * vendor's payable — it just tells us what the goods really cost per unit.
 * Shared by create and edit so the two can't drift apart.
 */
async function computeBill(
  tx: Tx,
  vendor: typeof contacts.$inferSelect,
  lines: Array<z.infer<typeof lineSchema>>,
  freightAmount?: string,
  adjustment?: { amount: string; accountId?: string | null; description?: string | null },
): Promise<BillComputation> {
  const resolvedLines = await resolveLineAccounts(tx, lines);
  const totals = await computeDocumentTotals(
    tx,
    resolvedLines as DocLineInput[],
    vendor.placeOfSupplyState,
    adjustment,
  );
  const { lines: computedLines, ...headerTotals } = totals;
  const freightP = toPaise(freightAmount ?? "0");
  const lineAmountsP = computedLines.map((l) => toPaise(l.amount));
  const allocatedP = allocateFreight(lineAmountsP, freightP);
  return { resolvedLines, totals, computedLines, headerTotals, freightP, allocatedP, lineAmountsP };
}

/** Bill line rows with their costing columns filled in. */
function billLineValues(c: BillComputation, billId: string) {
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
async function saveBillLineTags(
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
function billGoodsJeLines(c: BillComputation, number: string) {
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
  );
}

/**
 * The transporter's charge is its own expense: DR freight expense, CR what we owe
 * them. Deliberately a separate entry so the goods vendor's payable stays clean.
 */
async function postFreightJournal(
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

async function createBill(tx: Tx, args: CreateBillArgs) {
  const vendor = args.vendor;
  const c = await computeBill(tx, vendor, args.lines, args.freightAmount, args.adjustment);
  const { computedLines, headerTotals, freightP, allocatedP, lineAmountsP, resolvedLines } = c;
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

/** Zoho's "Payment Summary" banner on the Bills list. */
purchasesRouter.get("/bills/summary", requirePermission("purchases", "view"), async (_req, res) => {
  const [agg] = await db.execute(sql`
    SELECT
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('open', 'partially_paid')), 0)::numeric(14,2) AS total_outstanding,
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('open', 'partially_paid') AND due_date = CURRENT_DATE), 0)::numeric(14,2) AS due_today,
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('open', 'partially_paid') AND due_date > CURRENT_DATE AND due_date <= CURRENT_DATE + INTERVAL '30 days'), 0)::numeric(14,2) AS due_within_30,
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('open', 'partially_paid') AND due_date < CURRENT_DATE), 0)::numeric(14,2) AS overdue
    FROM bills
  `).then((r) => r.rows as Array<Record<string, string>>);
  res.json({
    totalOutstanding: agg?.total_outstanding ?? "0.00",
    dueToday: agg?.due_today ?? "0.00",
    dueWithin30Days: agg?.due_within_30 ?? "0.00",
    overdue: agg?.overdue ?? "0.00",
  });
});

purchasesRouter.get("/bills", requirePermission("purchases", "view"), async (req, res) => {
  const { vendorId, status, from, to } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (vendorId) conditions.push(eq(bills.vendorId, vendorId));
  if (status) conditions.push(eq(bills.status, status as typeof bills.$inferSelect.status));
  if (from) conditions.push(gte(bills.billDate, from));
  if (to) conditions.push(lte(bills.billDate, to));
  const rows = await db
    .select({
      ...getTableColumns(bills),
      contactName: contacts.displayName,
      createdByName: users.name,
    })
    .from(bills)
    .leftJoin(contacts, eq(contacts.id, bills.vendorId))
    .leftJoin(users, eq(users.id, bills.createdBy))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(bills.billDate))
    .limit(200);
  res.json(rows);
});

purchasesRouter.get("/bills/:id", requirePermission("purchases", "view"), async (req, res) => {
  const bill = await db.query.bills.findFirst({ where: eq(bills.id, req.params.id!) });
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  const [lines, applications] = await Promise.all([
    db
      .select()
      .from(billLines)
      .where(eq(billLines.billId, bill.id))
      .orderBy(asc(billLines.lineOrder)),
    db
      .select({
        paymentId: vendorPaymentApplications.paymentId,
        amountApplied: vendorPaymentApplications.amountApplied,
        paymentNumber: vendorPayments.number,
        paymentDate: vendorPayments.paymentDate,
      })
      .from(vendorPaymentApplications)
      .innerJoin(vendorPayments, eq(vendorPayments.id, vendorPaymentApplications.paymentId))
      .where(eq(vendorPaymentApplications.billId, bill.id)),
  ]);
  const carrier = bill.freightVendorId
    ? await db.query.contacts.findFirst({ where: eq(contacts.id, bill.freightVendorId) })
    : null;

  const lineTags = lines.length
    ? await db
        .select({
          billLineId: billLineTags.billLineId,
          tagId: billLineTags.tagId,
          optionId: billLineTags.optionId,
          tagName: reportingTags.name,
          optionName: reportingTagOptions.name,
        })
        .from(billLineTags)
        .innerJoin(reportingTags, eq(reportingTags.id, billLineTags.tagId))
        .innerJoin(reportingTagOptions, eq(reportingTagOptions.id, billLineTags.optionId))
        .where(
          inArray(
            billLineTags.billLineId,
            lines.map((l) => l.id),
          ),
        )
    : [];

  const customFieldValues = await readCustomFieldValues(db, "bill", bill.id);

  res.json({
    ...bill,
    customFieldValues,
    lines: lines.map((l) => ({
      ...l,
      tags: lineTags.filter((t) => t.billLineId === l.id),
      tagOptionIds: lineTags.filter((t) => t.billLineId === l.id).map((t) => t.optionId),
    })),
    payments: applications,
    freightVendorName: carrier?.displayName ?? null,
  });
});

purchasesRouter.post(
  "/bills",
  requirePermission("purchases", "create"),
  validateBody(billSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof billSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        const vendor = await loadVendor(tx, body.vendorId);
        const bill = await createBill(tx, {
          vendor,
          seriesId: body.seriesId,
          billDate: body.billDate,
          dueDate: body.dueDate,
          vendorBillNumber: body.vendorBillNumber,
          reference: body.reference,
          freightAmount: body.freightAmount,
          freightVendorId: body.freightVendorId,
          freightAccountId: body.freightAccountId,
          notes: body.notes,
          adjustment: body.adjustment,
          lines: body.lines,
          postedBy: req.session.user!.id,
        });
        await saveCustomFieldValues(tx, "bill", bill.id, body.customFields);
        return bill;
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/**
 * Editing a bill re-states it: the original journals are reversed and fresh ones
 * posted, so the ledger keeps a full audit trail instead of being rewritten in
 * place. Blocked once money has moved against the bill.
 */
purchasesRouter.patch(
  "/bills/:id",
  requirePermission("purchases", "edit"),
  validateBody(billSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof billSchema>>;
    try {
      const result = await db.transaction(async (tx) => {
        const bill = await tx.query.bills.findFirst({ where: eq(bills.id, req.params.id!) });
        if (!bill) throw new PostingError("Bill not found");
        if (bill.status === "void") throw new PostingError("A void bill cannot be edited");
        if (toPaise(bill.balanceDue) !== toPaise(bill.total)) {
          throw new PostingError("Bill has payments or credits applied — unapply them first");
        }

        const vendor = await loadVendor(tx, body.vendorId ?? bill.vendorId);
        const billDate = body.billDate ?? bill.billDate;
        const freightAmount = body.freightAmount ?? bill.freightAmount;
        const freightAccountId = body.freightAccountId ?? bill.freightAccountId ?? undefined;
        const freightVendorId = body.freightVendorId ?? bill.freightVendorId ?? undefined;

        // Reverse first so the re-post lands on a clean slate.
        for (const je of [bill.journalEntryId, bill.freightJournalEntryId]) {
          if (je) await reverseJournal(tx, je, billDate, req.session.user!.id);
        }

        // Lines may be unchanged — fall back to what's already stored so freight
        // still re-allocates correctly against them.
        let inputLines: Array<z.infer<typeof lineSchema>>;
        if (body.lines) {
          inputLines = body.lines;
        } else {
          const existing = await tx
            .select()
            .from(billLines)
            .where(eq(billLines.billId, bill.id))
            .orderBy(asc(billLines.lineOrder));
          inputLines = existing.map((l) => ({
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

        await saveCustomFieldValues(tx, "bill", bill.id, body.customFields);

        const c = await computeBill(tx, vendor, inputLines, freightAmount, {
          amount: body.adjustment?.amount ?? bill.adjustment,
          accountId: body.adjustment?.accountId ?? bill.adjustmentAccountId,
          description: body.adjustment?.description ?? bill.adjustmentDescription,
        });
        await tx.delete(billLines).where(eq(billLines.billId, bill.id));
        const editedLines = await tx
          .insert(billLines)
          .values(billLineValues(c, bill.id))
          .returning({ id: billLines.id, lineOrder: billLines.lineOrder });
        await saveBillLineTags(tx, c, editedLines);

        const jeId = await postJournal(tx, {
          entryDate: billDate,
          narration: `Bill ${bill.number} — ${vendor.displayName}`,
          sourceType: "bill",
          sourceId: bill.id,
          postedBy: req.session.user!.id,
          lines: billGoodsJeLines(c, bill.number),
        });
        const freightJeId = await postFreightJournal(tx, {
          freightP: c.freightP,
          freightAccountId,
          freightVendorId,
          billNumber: bill.number,
          entryDate: billDate,
          postedBy: req.session.user!.id,
        });

        const [updated] = await tx
          .update(bills)
          .set({
            vendorId: vendor.id,
            billDate,
            dueDate: body.dueDate ?? bill.dueDate,
            vendorBillNumber: body.vendorBillNumber ?? bill.vendorBillNumber,
            reference: body.reference ?? bill.reference,
            notes: body.notes ?? bill.notes,
            ...c.headerTotals,
            balanceDue: c.headerTotals.total,
            freightAmount: fromPaise(c.freightP),
            freightVendorId: freightVendorId ?? null,
            freightAccountId: freightAccountId ?? null,
            journalEntryId: jeId,
            freightJournalEntryId: freightJeId,
            updatedAt: new Date(),
          })
          .where(eq(bills.id, bill.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.post(
  "/bills/:id/void",
  requirePermission("purchases", "delete"),
  validateBody(z.object({ voidDate: dateStr })),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const bill = await tx.query.bills.findFirst({ where: eq(bills.id, req.params.id!) });
        if (!bill) throw new PostingError("Bill not found");
        if (bill.status === "void") throw new PostingError("Bill is already void");
        if (toPaise(bill.balanceDue) !== toPaise(bill.total)) {
          throw new PostingError("Bill has payments or credits applied — unapply them first");
        }
        // Both the goods entry and the separate freight entry have to come back off.
        for (const je of [bill.journalEntryId, bill.freightJournalEntryId]) {
          if (je) await reverseJournal(tx, je, req.body.voidDate, req.session.user!.id);
        }
        const [updated] = await tx
          .update(bills)
          .set({ status: "void", balanceDue: "0.00", updatedAt: new Date() })
          .where(eq(bills.id, bill.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

// ============================ Payments Made ============================

const vendorPaymentSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  vendorId: z.string().uuid(),
  paymentDate: dateStr,
  amount: money,
  tdsAmount: money.optional(),
  mode: z.enum(paymentMode.enumValues).optional(),
  reference: z.string().optional(),
  bankAccountId: z.string().uuid(),
  notes: z.string().optional(),
  applications: z
    .array(z.object({ billId: z.string().uuid(), amount: money }))
    .max(100)
    .default([]),
});

purchasesRouter.get("/payments", requirePermission("purchases", "view"), async (req, res) => {
  const { vendorId, from, to } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (vendorId) conditions.push(eq(vendorPayments.vendorId, vendorId));
  if (from) conditions.push(gte(vendorPayments.paymentDate, from));
  if (to) conditions.push(lte(vendorPayments.paymentDate, to));
  const rows = await db
    .select({ ...getTableColumns(vendorPayments), contactName: contacts.displayName })
    .from(vendorPayments)
    .leftJoin(contacts, eq(contacts.id, vendorPayments.vendorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(vendorPayments.paymentDate))
    .limit(200);

  // Applied bill numbers per payment, Zoho's "Bill#" column.
  const billNumbers = await db
    .select({
      paymentId: vendorPaymentApplications.paymentId,
      numbers: sql<string>`STRING_AGG(${bills.number}, ', ' ORDER BY ${bills.number})`,
    })
    .from(vendorPaymentApplications)
    .innerJoin(bills, eq(bills.id, vendorPaymentApplications.billId))
    .groupBy(vendorPaymentApplications.paymentId);
  const numbersByPayment = new Map(billNumbers.map((r) => [r.paymentId, r.numbers]));

  res.json(rows.map((r) => ({ ...r, billNumbers: numbersByPayment.get(r.id) ?? null })));
});

purchasesRouter.get("/payments/:id", requirePermission("purchases", "view"), async (req, res) => {
  const payment = await db.query.vendorPayments.findFirst({
    where: eq(vendorPayments.id, req.params.id!),
  });
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  const [contact] = await db
    .select({ displayName: contacts.displayName })
    .from(contacts)
    .where(eq(contacts.id, payment.vendorId))
    .limit(1);
  const applications = await db
    .select({
      billId: vendorPaymentApplications.billId,
      amountApplied: vendorPaymentApplications.amountApplied,
      billNumber: bills.number,
      billDate: bills.billDate,
      billTotal: bills.total,
    })
    .from(vendorPaymentApplications)
    .innerJoin(bills, eq(bills.id, vendorPaymentApplications.billId))
    .where(eq(vendorPaymentApplications.paymentId, payment.id));
  res.json({ ...payment, contactName: contact?.displayName ?? null, applications });
});

/**
 * Payment amount is the gross AP settled; cash out = amount - TDS withheld.
 * JE: DR Accounts Payable (gross), CR Bank (net), CR TDS Payable (withheld).
 */
purchasesRouter.post(
  "/payments",
  requirePermission("purchases", "create"),
  validateBody(vendorPaymentSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof vendorPaymentSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        const vendor = await loadVendor(tx, body.vendorId);
        const [bank] = await tx
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, body.bankAccountId))
          .limit(1);
        if (!bank) throw new PostingError("Bank account not found");

        const amountP = toPaise(body.amount);
        const tdsP = toPaise(body.tdsAmount ?? "0");
        if (amountP <= 0) throw new PostingError("Payment amount must be positive");
        if (tdsP < 0 || tdsP >= amountP) {
          throw new PostingError("TDS must be non-negative and less than the payment amount");
        }

        let appliedP = 0;
        for (const app of body.applications) {
          const bill = await tx.query.bills.findFirst({ where: eq(bills.id, app.billId) });
          if (!bill) throw new PostingError(`Bill not found: ${app.billId}`);
          if (bill.vendorId !== vendor.id) {
            throw new PostingError(`Bill ${bill.number} belongs to a different vendor`);
          }
          if (bill.status !== "open" && bill.status !== "partially_paid") {
            throw new PostingError(`Bill ${bill.number} is not open for payment`);
          }
          const appP = toPaise(app.amount);
          if (appP <= 0) throw new PostingError("Application amounts must be positive");
          if (appP > toPaise(bill.balanceDue)) {
            throw new PostingError(`Amount exceeds balance due on ${bill.number}`);
          }
          appliedP += appP;
        }
        if (appliedP > amountP) throw new PostingError("Applied total exceeds the payment amount");
        const unappliedP = amountP - appliedP;

        const number = await nextDocumentNumber(tx, "vendor_payment", body.seriesId);
        const [payment] = await tx
          .insert(vendorPayments)
          .values({
            number,
            vendorId: vendor.id,
            paymentDate: body.paymentDate,
            amount: body.amount,
            unappliedAmount: fromPaise(unappliedP),
            mode: body.mode ?? "bank_transfer",
            reference: body.reference,
            bankAccountId: bank.id,
            tdsAmount: fromPaise(tdsP),
            notes: body.notes,
            createdBy: req.session.user!.id,
          })
          .returning();

        for (const app of body.applications) {
          await tx.insert(vendorPaymentApplications).values({
            paymentId: payment!.id,
            billId: app.billId,
            amountApplied: app.amount,
          });
          const bill = (await tx.query.bills.findFirst({ where: eq(bills.id, app.billId) }))!;
          const newBalanceP = toPaise(bill.balanceDue) - toPaise(app.amount);
          await tx
            .update(bills)
            .set({
              balanceDue: fromPaise(newBalanceP),
              status: newBalanceP === 0 ? "paid" : "partially_paid",
              updatedAt: new Date(),
            })
            .where(eq(bills.id, bill.id));
        }

        const jeLines: Array<{ accountId?: string; systemKey?: string; debit?: string; credit?: string; description?: string }> = [
          { systemKey: "ap", debit: body.amount, description: `Payment ${number}` },
          { accountId: bank.glAccountId, credit: fromPaise(amountP - tdsP) },
        ];
        if (tdsP > 0) jeLines.push({ systemKey: "tds_payable", credit: fromPaise(tdsP) });

        const jeId = await postJournal(tx, {
          entryDate: body.paymentDate,
          narration: `Payment ${number} — ${vendor.displayName}`,
          sourceType: "vendor_payment",
          sourceId: payment!.id,
          postedBy: req.session.user!.id,
          lines: jeLines,
        });
        const [updated] = await tx
          .update(vendorPayments)
          .set({ journalEntryId: jeId })
          .where(eq(vendorPayments.id, payment!.id))
          .returning();
        return updated!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/**
 * Editing a payment re-states it end to end: the existing applications are undone
 * (restoring each bill's balance and status), the journal is reversed, then the new
 * allocation is applied and a fresh journal posted.
 */
purchasesRouter.patch(
  "/payments/:id",
  requirePermission("purchases", "edit"),
  validateBody(vendorPaymentSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof vendorPaymentSchema>>;
    try {
      const result = await db.transaction(async (tx) => {
        const payment = await tx.query.vendorPayments.findFirst({
          where: eq(vendorPayments.id, req.params.id!),
        });
        if (!payment) throw new PostingError("Payment not found");

        // Undo the old allocation so bills are back to pre-payment balances.
        const oldApps = await tx
          .select()
          .from(vendorPaymentApplications)
          .where(eq(vendorPaymentApplications.paymentId, payment.id));
        for (const app of oldApps) {
          const bill = await tx.query.bills.findFirst({ where: eq(bills.id, app.billId) });
          if (!bill) continue;
          const restoredP = toPaise(bill.balanceDue) + toPaise(app.amountApplied);
          await tx
            .update(bills)
            .set({
              balanceDue: fromPaise(restoredP),
              status: restoredP === toPaise(bill.total) ? "open" : "partially_paid",
              updatedAt: new Date(),
            })
            .where(eq(bills.id, bill.id));
        }
        await tx
          .delete(vendorPaymentApplications)
          .where(eq(vendorPaymentApplications.paymentId, payment.id));

        const vendor = await loadVendor(tx, body.vendorId ?? payment.vendorId);
        const paymentDate = body.paymentDate ?? payment.paymentDate;
        const amount = body.amount ?? payment.amount;
        const amountP = toPaise(amount);
        if (amountP <= 0) throw new PostingError("Payment amount must be positive");
        const tdsP = toPaise(body.tdsAmount ?? payment.tdsAmount);
        if (tdsP >= amountP) throw new PostingError("TDS cannot be the whole payment");

        const [bank] = await tx
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, body.bankAccountId ?? payment.bankAccountId!))
          .limit(1);
        if (!bank) throw new PostingError("Bank account not found");

        const applications =
          body.applications ?? oldApps.map((a) => ({ billId: a.billId, amount: a.amountApplied }));

        let appliedP = 0;
        for (const app of applications) {
          const bill = await tx.query.bills.findFirst({ where: eq(bills.id, app.billId) });
          if (!bill) throw new PostingError(`Bill not found: ${app.billId}`);
          if (bill.vendorId !== vendor.id) {
            throw new PostingError(`Bill ${bill.number} belongs to a different vendor`);
          }
          const appP = toPaise(app.amount);
          if (appP <= 0) throw new PostingError("Application amounts must be positive");
          if (appP > toPaise(bill.balanceDue)) {
            throw new PostingError(`Amount exceeds balance due on ${bill.number}`);
          }
          appliedP += appP;
        }
        if (appliedP > amountP) throw new PostingError("Applied total exceeds the payment amount");

        for (const app of applications) {
          await tx.insert(vendorPaymentApplications).values({
            paymentId: payment.id,
            billId: app.billId,
            amountApplied: app.amount,
          });
          const bill = (await tx.query.bills.findFirst({ where: eq(bills.id, app.billId) }))!;
          const newBalanceP = toPaise(bill.balanceDue) - toPaise(app.amount);
          await tx
            .update(bills)
            .set({
              balanceDue: fromPaise(newBalanceP),
              status: newBalanceP === 0 ? "paid" : "partially_paid",
              updatedAt: new Date(),
            })
            .where(eq(bills.id, bill.id));
        }

        if (payment.journalEntryId) {
          await reverseJournal(tx, payment.journalEntryId, paymentDate, req.session.user!.id);
        }
        const jeLines: Array<{ accountId?: string; systemKey?: string; debit?: string; credit?: string; description?: string }> = [
          { systemKey: "ap", debit: amount, description: `Payment ${payment.number}` },
          { accountId: bank.glAccountId, credit: fromPaise(amountP - tdsP) },
        ];
        if (tdsP > 0) jeLines.push({ systemKey: "tds_payable", credit: fromPaise(tdsP) });

        const jeId = await postJournal(tx, {
          entryDate: paymentDate,
          narration: `Payment ${payment.number} — ${vendor.displayName}`,
          sourceType: "vendor_payment",
          sourceId: payment.id,
          postedBy: req.session.user!.id,
          lines: jeLines,
        });

        const [updated] = await tx
          .update(vendorPayments)
          .set({
            vendorId: vendor.id,
            paymentDate,
            amount,
            unappliedAmount: fromPaise(amountP - appliedP),
            tdsAmount: fromPaise(tdsP),
            mode: body.mode ?? payment.mode,
            reference: body.reference ?? payment.reference,
            bankAccountId: bank.id,
            notes: body.notes ?? payment.notes,
            journalEntryId: jeId,
          })
          .where(eq(vendorPayments.id, payment.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

// ============================ Vendor Credits ============================

const vendorCreditSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  vendorId: z.string().uuid(),
  creditDate: dateStr,
  reference: z.string().optional(),
  billId: z.string().uuid().optional(),
  notes: z.string().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

purchasesRouter.get(
  "/vendor-credits",
  requirePermission("purchases", "view"),
  async (req, res) => {
    const { vendorId, status } = req.query as Record<string, string | undefined>;
    const conditions = [];
    if (vendorId) conditions.push(eq(vendorCredits.vendorId, vendorId));
    if (status) conditions.push(eq(vendorCredits.status, status as typeof vendorCredits.$inferSelect.status));
    const rows = await db
      .select({ ...getTableColumns(vendorCredits), contactName: contacts.displayName })
      .from(vendorCredits)
      .leftJoin(contacts, eq(contacts.id, vendorCredits.vendorId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(vendorCredits.creditDate))
      .limit(200);
    res.json(rows);
  },
);

purchasesRouter.get(
  "/vendor-credits/:id",
  requirePermission("purchases", "view"),
  async (req, res) => {
    const credit = await db.query.vendorCredits.findFirst({
      where: eq(vendorCredits.id, req.params.id!),
    });
    if (!credit) return res.status(404).json({ error: "Vendor credit not found" });
    const [lines, applications] = await Promise.all([
      db
        .select()
        .from(vendorCreditLines)
        .where(eq(vendorCreditLines.vendorCreditId, credit.id))
        .orderBy(asc(vendorCreditLines.lineOrder)),
      db
        .select({
          billId: vendorCreditApplications.billId,
          amountApplied: vendorCreditApplications.amountApplied,
          billNumber: bills.number,
          billDate: bills.billDate,
        })
        .from(vendorCreditApplications)
        .innerJoin(bills, eq(bills.id, vendorCreditApplications.billId))
        .where(eq(vendorCreditApplications.vendorCreditId, credit.id)),
    ]);
    res.json({ ...credit, lines, applications });
  },
);

/** Reverse of a bill's posting: DR AP, CR the line accounts + input GST. */
function buildVendorCreditJeLines(
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

  const jeLines: Array<{ accountId?: string; systemKey?: string; debit?: string; credit?: string; description?: string }> = [
    { systemKey: "ap", debit: totals.total, description: `Vendor credit ${number}` },
  ];
  let first = true;
  for (const [accountId, netP] of grouped) {
    const withRound = first ? netP + toPaise(totals.roundOff) : netP;
    first = false;
    if (withRound !== 0) jeLines.push({ accountId, credit: fromPaise(withRound) });
  }
  if (taxTotalP > 0) jeLines.push({ systemKey: "input_gst", credit: fromPaise(taxTotalP) });
  return jeLines;
}

/**
 * Editing re-states the credit: the original journal is reversed and a fresh one
 * posted. Blocked once any of it has been applied against a bill.
 */
purchasesRouter.patch(
  "/vendor-credits/:id",
  requirePermission("purchases", "edit"),
  validateBody(vendorCreditSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof vendorCreditSchema>>;
    try {
      const result = await db.transaction(async (tx) => {
        const vc = await tx.query.vendorCredits.findFirst({
          where: eq(vendorCredits.id, req.params.id!),
        });
        if (!vc) throw new PostingError("Vendor credit not found");
        if (vc.status === "void") throw new PostingError("A void vendor credit cannot be edited");
        if (toPaise(vc.balance) !== toPaise(vc.total)) {
          throw new PostingError("This credit is partly applied to a bill — unapply it first");
        }

        const vendor = await loadVendor(tx, body.vendorId ?? vc.vendorId);
        const creditDate = body.creditDate ?? vc.creditDate;

        let inputLines: Array<z.infer<typeof lineSchema>>;
        if (body.lines) {
          inputLines = body.lines;
        } else {
          const existing = await tx
            .select()
            .from(vendorCreditLines)
            .where(eq(vendorCreditLines.vendorCreditId, vc.id))
            .orderBy(asc(vendorCreditLines.lineOrder));
          inputLines = existing.map((l) => ({
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

        if (vc.journalEntryId) {
          await reverseJournal(tx, vc.journalEntryId, creditDate, req.session.user!.id);
        }

        const resolvedLines = await resolveLineAccounts(tx, inputLines);
        const totals = await computeDocumentTotals(
          tx,
          resolvedLines as DocLineInput[],
          vendor.placeOfSupplyState,
        );
        const { lines: computedLines, ...headerTotals } = totals;

        await tx.delete(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, vc.id));
        await tx.insert(vendorCreditLines).values(
          computedLines.map((l, i) => ({
            ...l,
            accountId: resolvedLines[i]!.accountId,
            vendorCreditId: vc.id,
          })),
        );

        const jeId = await postJournal(tx, {
          entryDate: creditDate,
          narration: `Vendor credit ${vc.number} — ${vendor.displayName}`,
          sourceType: "vendor_credit",
          sourceId: vc.id,
          postedBy: req.session.user!.id,
          lines: buildVendorCreditJeLines(computedLines, resolvedLines, totals, vc.number),
        });

        const [updated] = await tx
          .update(vendorCredits)
          .set({
            vendorId: vendor.id,
            creditDate,
            reference: body.reference ?? vc.reference,
            notes: body.notes ?? vc.notes,
            ...headerTotals,
            balance: headerTotals.total,
            journalEntryId: jeId,
          })
          .where(eq(vendorCredits.id, vc.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.post(
  "/vendor-credits",
  requirePermission("purchases", "create"),
  validateBody(vendorCreditSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof vendorCreditSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        const vendor = await loadVendor(tx, body.vendorId);
        const resolvedLines = await resolveLineAccounts(tx, body.lines);
        const totals = await computeDocumentTotals(
          tx,
          resolvedLines as DocLineInput[],
          vendor.placeOfSupplyState,
        );
        const number = await nextDocumentNumber(tx, "vendor_credit", body.seriesId);
        const { lines: computedLines, ...headerTotals } = totals;

        const [vc] = await tx
          .insert(vendorCredits)
          .values({
            number,
            vendorId: vendor.id,
            status: "open",
            creditDate: body.creditDate,
            reference: body.reference,
            billId: body.billId,
            ...headerTotals,
            balance: headerTotals.total,
            notes: body.notes,
            createdBy: req.session.user!.id,
          })
          .returning();
        await tx.insert(vendorCreditLines).values(
          computedLines.map((l, i) => ({
            ...l,
            accountId: resolvedLines[i]!.accountId,
            vendorCreditId: vc!.id,
          })),
        );

        const jeLines = buildVendorCreditJeLines(computedLines, resolvedLines, totals, number);

        const jeId = await postJournal(tx, {
          entryDate: body.creditDate,
          narration: `Vendor credit ${number} — ${vendor.displayName}`,
          sourceType: "vendor_credit",
          sourceId: vc!.id,
          postedBy: req.session.user!.id,
          lines: jeLines,
        });
        const [updated] = await tx
          .update(vendorCredits)
          .set({ journalEntryId: jeId })
          .where(eq(vendorCredits.id, vc!.id))
          .returning();
        return updated!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.post(
  "/vendor-credits/:id/apply",
  requirePermission("purchases", "edit"),
  validateBody(
    z.object({
      applications: z
        .array(z.object({ billId: z.string().uuid(), amount: money }))
        .min(1)
        .max(100),
    }),
  ),
  async (req, res) => {
    const body = req.body as { applications: Array<{ billId: string; amount: string }> };
    try {
      const result = await db.transaction(async (tx) => {
        const vc = await tx.query.vendorCredits.findFirst({
          where: eq(vendorCredits.id, req.params.id!),
        });
        if (!vc) throw new PostingError("Vendor credit not found");
        if (vc.status !== "open") throw new PostingError("Vendor credit is not open");

        let appliedP = 0;
        for (const app of body.applications) {
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
          await tx
            .update(bills)
            .set({
              balanceDue: fromPaise(newBalanceP),
              status: newBalanceP === 0 ? "paid" : "partially_paid",
              updatedAt: new Date(),
            })
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
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

// ============================ Expenses ============================

const expenseSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  expenseDate: dateStr,
  expenseAccountId: z.string().uuid(),
  paidThroughId: z.string().uuid(),
  vendorId: z.string().uuid().optional(),
  amount: money,
  taxId: z.string().uuid().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  /** Reporting tags for the cost — one option per tag. */
  tagOptionIds: z.array(z.string().uuid()).max(10).optional(),
  /** Custom field values, keyed by field id. */
  customFields: z.record(z.string(), z.any()).optional(),
});

purchasesRouter.get("/expenses", requirePermission("purchases", "view"), async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (from) conditions.push(gte(expenses.expenseDate, from));
  if (to) conditions.push(lte(expenses.expenseDate, to));
  const rows = await db
    .select({
      ...getTableColumns(expenses),
      contactName: contacts.displayName,
      expenseAccountName: accounts.name,
      paidThroughName: bankAccounts.name,
    })
    .from(expenses)
    .leftJoin(contacts, eq(contacts.id, expenses.vendorId))
    .leftJoin(accounts, eq(accounts.id, expenses.expenseAccountId))
    .leftJoin(bankAccounts, eq(bankAccounts.id, expenses.paidThroughId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(expenses.expenseDate))
    .limit(200);
  res.json(rows);
});

purchasesRouter.get("/expenses/:id", requirePermission("purchases", "view"), async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id!) });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  const [acct] = await db
    .select({ code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, expense.expenseAccountId))
    .limit(1);
  const [paidThrough] = await db
    .select({ name: bankAccounts.name })
    .from(bankAccounts)
    .where(eq(bankAccounts.id, expense.paidThroughId))
    .limit(1);
  const vendor = expense.vendorId
    ? await db.query.contacts.findFirst({ where: eq(contacts.id, expense.vendorId) })
    : null;
  const tags = expense.journalEntryId
    ? await db
        .select({
          tagId: journalEntryLineTags.tagId,
          optionId: journalEntryLineTags.optionId,
          tagName: reportingTags.name,
          optionName: reportingTagOptions.name,
        })
        .from(journalEntryLineTags)
        .innerJoin(journalEntryLines, eq(journalEntryLines.id, journalEntryLineTags.lineId))
        .innerJoin(reportingTags, eq(reportingTags.id, journalEntryLineTags.tagId))
        .innerJoin(reportingTagOptions, eq(reportingTagOptions.id, journalEntryLineTags.optionId))
        .where(
          and(
            eq(journalEntryLines.entryId, expense.journalEntryId),
            eq(journalEntryLines.accountId, expense.expenseAccountId),
          ),
        )
    : [];

  const customFieldValues = await readCustomFieldValues(db, "expense", expense.id);

  res.json({
    ...expense,
    customFieldValues,
    expenseAccountName: acct ? `${acct.code} · ${acct.name}` : null,
    paidThroughName: paidThrough?.name ?? null,
    contactName: vendor?.displayName ?? null,
    tags,
    tagOptionIds: tags.map((t) => t.optionId),
  });
});

/** Tax on an expense, in paise. */
async function expenseTaxPaise(tx: Tx, amount: string, taxId?: string) {
  if (!taxId) return 0;
  const totals = await computeDocumentTotals(
    tx,
    [{ name: "expense", quantity: "1", rate: amount, taxId }],
    null,
  );
  return toPaise(totals.cgst) + toPaise(totals.sgst) + toPaise(totals.igst);
}

/** DR expense (+ input GST if taxed), CR the paid-through bank/cash account. */
/**
 * The tags currently on an expense, read off its journal.
 *
 * An expense has one cost account, so its tags live unambiguously on that one
 * journal line and need no storage of their own. Anything that re-posts an
 * expense has to read them back first, or reversing the old journal would drop
 * them silently.
 */
async function expenseTagOptionIds(
  tx: Tx,
  journalEntryId: string | null,
  expenseAccountId: string,
): Promise<string[]> {
  if (!journalEntryId) return [];
  const rows = await tx
    .select({ optionId: journalEntryLineTags.optionId })
    .from(journalEntryLineTags)
    .innerJoin(journalEntryLines, eq(journalEntryLines.id, journalEntryLineTags.lineId))
    .where(
      and(
        eq(journalEntryLines.entryId, journalEntryId),
        eq(journalEntryLines.accountId, expenseAccountId),
      ),
    );
  return rows.map((r) => r.optionId);
}

function buildExpenseJeLines(args: {
  expenseAccountId: string;
  bankGlAccountId: string;
  amount: string;
  taxP: number;
  number: string;
  tagOptionIds?: string[];
}) {
  const jeLines: Array<{
    accountId?: string;
    systemKey?: string;
    debit?: string;
    credit?: string;
    description?: string;
    tagOptionIds?: string[];
  }> = [
    {
      accountId: args.expenseAccountId,
      debit: args.amount,
      description: `Expense ${args.number}`,
      // The cost line is the one worth tagging: the bank credit is just where
      // the money came from, not what it was spent on.
      tagOptionIds: args.tagOptionIds,
    },
    { accountId: args.bankGlAccountId, credit: fromPaise(toPaise(args.amount) + args.taxP) },
  ];
  if (args.taxP > 0) jeLines.push({ systemKey: "input_gst", debit: fromPaise(args.taxP) });
  return jeLines;
}

/** Editing re-states the expense: original journal reversed, a fresh one posted. */
purchasesRouter.patch(
  "/expenses/:id",
  requirePermission("purchases", "edit"),
  validateBody(expenseSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof expenseSchema>>;
    try {
      const result = await db.transaction(async (tx) => {
        const expense = await tx.query.expenses.findFirst({
          where: eq(expenses.id, req.params.id!),
        });
        if (!expense) throw new PostingError("Expense not found");

        const paidThroughId = body.paidThroughId ?? expense.paidThroughId;
        const [bank] = await tx
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, paidThroughId))
          .limit(1);
        if (!bank) throw new PostingError("Paid-through account not found");
        if (body.vendorId) await loadVendor(tx, body.vendorId);

        const amount = body.amount ?? expense.amount;
        const amountP = toPaise(amount);
        if (amountP <= 0) throw new PostingError("Expense amount must be positive");

        const expenseDate = body.expenseDate ?? expense.expenseDate;
        const expenseAccountId = body.expenseAccountId ?? expense.expenseAccountId;
        const taxId = body.taxId ?? expense.taxId ?? undefined;
        const taxP = await expenseTaxPaise(tx, amount, taxId);

        // A patch that says nothing about tags keeps the ones already there,
        // so editing an amount cannot quietly untag the cost.
        const tagOptionIds =
          body.tagOptionIds ??
          (await expenseTagOptionIds(tx, expense.journalEntryId, expense.expenseAccountId));

        await saveCustomFieldValues(tx, "expense", expense.id, body.customFields);

        if (expense.journalEntryId) {
          await reverseJournal(tx, expense.journalEntryId, expenseDate, req.session.user!.id);
        }
        const jeId = await postJournal(tx, {
          entryDate: expenseDate,
          narration: `Expense ${expense.number}`,
          sourceType: "expense",
          sourceId: expense.id,
          postedBy: req.session.user!.id,
          lines: buildExpenseJeLines({
            expenseAccountId,
            bankGlAccountId: bank.glAccountId,
            amount,
            taxP,
            number: expense.number,
            tagOptionIds,
          }),
        });

        const [updated] = await tx
          .update(expenses)
          .set({
            expenseDate,
            expenseAccountId,
            paidThroughId: bank.id,
            vendorId: body.vendorId ?? expense.vendorId,
            amount,
            taxId: taxId ?? null,
            taxAmount: fromPaise(taxP),
            reference: body.reference ?? expense.reference,
            notes: body.notes ?? expense.notes,
            journalEntryId: jeId,
          })
          .where(eq(expenses.id, expense.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.post(
  "/expenses",
  requirePermission("purchases", "create"),
  validateBody(expenseSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof expenseSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        const [bank] = await tx
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, body.paidThroughId))
          .limit(1);
        if (!bank) throw new PostingError("Paid-through account not found");
        if (body.vendorId) await loadVendor(tx, body.vendorId);

        const amountP = toPaise(body.amount);
        if (amountP <= 0) throw new PostingError("Expense amount must be positive");

        const taxP = await expenseTaxPaise(tx, body.amount, body.taxId);

        const number = await nextDocumentNumber(tx, "expense", body.seriesId);
        const [expense] = await tx
          .insert(expenses)
          .values({
            number,
            expenseDate: body.expenseDate,
            expenseAccountId: body.expenseAccountId,
            paidThroughId: bank.id,
            vendorId: body.vendorId,
            amount: body.amount,
            taxId: body.taxId,
            taxAmount: fromPaise(taxP),
            reference: body.reference,
            notes: body.notes,
            createdBy: req.session.user!.id,
          })
          .returning();

        const jeLines = buildExpenseJeLines({
          expenseAccountId: body.expenseAccountId,
          bankGlAccountId: bank.glAccountId,
          amount: body.amount,
          taxP,
          number,
          tagOptionIds: body.tagOptionIds,
        });

        await saveCustomFieldValues(tx, "expense", expense!.id, body.customFields);

        const jeId = await postJournal(tx, {
          entryDate: body.expenseDate,
          narration: `Expense ${number}`,
          sourceType: "expense",
          sourceId: expense!.id,
          postedBy: req.session.user!.id,
          lines: jeLines,
        });
        const [updated] = await tx
          .update(expenses)
          .set({ journalEntryId: jeId })
          .where(eq(expenses.id, expense!.id))
          .returning();
        return updated!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

// ---------- Re-post helpers (used by Bulk Update) ----------
//
// Each one reverses a document's existing posting and re-posts it from whatever
// is currently stored, without changing any user-visible field. Bulk Update calls
// these after swapping the account on the lines, so the ledger catches up with
// the new account while the document itself reads exactly as before.

/** Re-reads stored bill lines in the shape the compute helpers expect. */
async function storedBillLines(tx: Tx, billId: string) {
  const rows = await tx
    .select()
    .from(billLines)
    .where(eq(billLines.billId, billId))
    .orderBy(asc(billLines.lineOrder));
  return rows.map((l) => ({
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

export async function repostBill(tx: Tx, id: string, userId: string): Promise<void> {
  const bill = await tx.query.bills.findFirst({ where: eq(bills.id, id) });
  if (!bill) throw new PostingError("Bill not found");
  if (bill.status === "void") throw new PostingError(`Bill ${bill.number} is void`);
  const vendor = await loadVendor(tx, bill.vendorId);

  for (const je of [bill.journalEntryId, bill.freightJournalEntryId]) {
    if (je) await reverseJournal(tx, je, bill.billDate, userId);
  }

  const c = await computeBill(tx, vendor, await storedBillLines(tx, id), bill.freightAmount, {
    amount: bill.adjustment,
    accountId: bill.adjustmentAccountId,
    description: bill.adjustmentDescription,
  });
  await tx.delete(billLines).where(eq(billLines.billId, id));
  await tx.insert(billLines).values(billLineValues(c, id));

  const jeId = await postJournal(tx, {
    entryDate: bill.billDate,
    narration: `Bill ${bill.number} — ${vendor.displayName}`,
    sourceType: "bill",
    sourceId: id,
    postedBy: userId,
    lines: billGoodsJeLines(c, bill.number),
  });
  const freightJeId = await postFreightJournal(tx, {
    freightP: c.freightP,
    freightAccountId: bill.freightAccountId ?? undefined,
    freightVendorId: bill.freightVendorId ?? undefined,
    billNumber: bill.number,
    entryDate: bill.billDate,
    postedBy: userId,
  });
  await tx
    .update(bills)
    .set({ journalEntryId: jeId, freightJournalEntryId: freightJeId })
    .where(eq(bills.id, id));
}

export async function repostVendorCredit(tx: Tx, id: string, userId: string): Promise<void> {
  const vc = await tx.query.vendorCredits.findFirst({ where: eq(vendorCredits.id, id) });
  if (!vc) throw new PostingError("Vendor credit not found");
  if (vc.status === "void") throw new PostingError(`Vendor credit ${vc.number} is void`);
  const vendor = await loadVendor(tx, vc.vendorId);

  if (vc.journalEntryId) await reverseJournal(tx, vc.journalEntryId, vc.creditDate, userId);

  const stored = await tx
    .select()
    .from(vendorCreditLines)
    .where(eq(vendorCreditLines.vendorCreditId, id))
    .orderBy(asc(vendorCreditLines.lineOrder));
  const inputLines = stored.map((l) => ({
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

  const resolvedLines = await resolveLineAccounts(tx, inputLines);
  const totals = await computeDocumentTotals(tx, resolvedLines as DocLineInput[], vendor.placeOfSupplyState);
  const { lines: computedLines } = totals;

  await tx.delete(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, id));
  await tx
    .insert(vendorCreditLines)
    .values(computedLines.map((l, i) => ({ ...l, accountId: resolvedLines[i]!.accountId, vendorCreditId: id })));

  const jeId = await postJournal(tx, {
    entryDate: vc.creditDate,
    narration: `Vendor credit ${vc.number} — ${vendor.displayName}`,
    sourceType: "vendor_credit",
    sourceId: id,
    postedBy: userId,
    lines: buildVendorCreditJeLines(computedLines, resolvedLines, totals, vc.number),
  });
  await tx.update(vendorCredits).set({ journalEntryId: jeId }).where(eq(vendorCredits.id, id));
}

export async function repostExpense(tx: Tx, id: string, userId: string): Promise<void> {
  const expense = await tx.query.expenses.findFirst({ where: eq(expenses.id, id) });
  if (!expense) throw new PostingError("Expense not found");
  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, expense.paidThroughId))
    .limit(1);
  if (!bank) throw new PostingError("Paid-through account not found");

  // Read the tags before the reversal, or they vanish with the old journal.
  const tagOptionIds = await expenseTagOptionIds(
    tx,
    expense.journalEntryId,
    expense.expenseAccountId,
  );
  if (expense.journalEntryId) {
    await reverseJournal(tx, expense.journalEntryId, expense.expenseDate, userId);
  }
  const jeId = await postJournal(tx, {
    entryDate: expense.expenseDate,
    narration: `Expense ${expense.number}`,
    sourceType: "expense",
    sourceId: id,
    postedBy: userId,
    lines: buildExpenseJeLines({
      expenseAccountId: expense.expenseAccountId,
      bankGlAccountId: bank.glAccountId,
      amount: expense.amount,
      taxP: await expenseTaxPaise(tx, expense.amount, expense.taxId ?? undefined),
      number: expense.number,
      tagOptionIds,
    }),
  });
  await tx.update(expenses).set({ journalEntryId: jeId }).where(eq(expenses.id, id));
}

/** Purchase orders never reach the ledger, so there is nothing to re-post. */
export async function repostPurchaseOrder(_tx: Tx, _id: string, _userId: string): Promise<void> {}
