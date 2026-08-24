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
  journalEntryLineTags,
  journalEntryLines,
  paymentMode,
  inventoryTransactions,
  items,
  officeReceiptLines,
  officeReceipts,
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
import { mainStore, moveStock } from "../services/inventory";
import { advancedSearch, listLimit, quickSearch } from "../services/document-search";
import {
  billSearch,
  expenseSearch,
  purchaseOrderSearch,
  vendorCreditSearch,
  vendorPaymentSearch,
} from "../services/search-specs";
import { readCustomFieldValues, saveCustomFieldValues } from "../services/custom-fields";
import {
  computeDocumentTotals,
  fromPaise,
  toPaise,
  type DocLineInput,
} from "../services/documents";
import {
  applyVendorCredit,
  billGoodsJeLines,
  billLineValues,
  buildVendorCreditJeLines,
  computeBill,
  computeDueDate,
  createBill,
  createVendorCredit,
  loadVendor,
  postFreightJournal,
  resolveLineAccounts,
  saveBillLineTags,
  vendorCreditLineInputs,
} from "../services/purchases";
import { describeSpecsForOrder } from "../services/qc";
import { syncPurchaseRates } from "../services/purchases";

export const purchasesRouter = Router();

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);
/**
 * A rate is not an amount. Money lands in the ledger at two decimals, but a
 * per-unit rate is stored at six and needs them: feed comes in at ₹52.815/kg,
 * and rounding that to ₹52.82 moves a 43-tonne truck by ₹216. Validating a
 * rate with the money rule refused the real figure outright.
 */
const rate = z.string().regex(/^\d+(\.\d{1,6})?$/);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lineSchema = z.object({
  itemId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  hsnOrSac: z.string().max(10).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/),
  unit: z.string().max(20).optional(),
  rate,
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
  /**
   * A bill line may be negative, and among purchase documents only a bill line
   * may. Office settles a truck as goods at the vendor's own figure
   * followed by a negative line per deduction, so editing such a bill has to be
   * able to send the deduction back unchanged. An order or a credit note has no
   * business carrying one.
   */
  rate: z.string().regex(/^-?\d+(\.\d{1,6})?$/),
});


function handlePostingError(err: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
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

/** The gradient hero strip on the Purchase Orders list — same shape as Bills'. */
purchasesRouter.get("/orders/summary", requirePermission("purchases", "view"), async (_req, res) => {
  const [agg] = await db.execute(sql`
    SELECT
      COALESCE(SUM(total) FILTER (WHERE status IN ('issued', 'partially_billed')), 0)::numeric(14,2) AS open_value,
      COALESCE(SUM(total) FILTER (WHERE status = 'draft'), 0)::numeric(14,2) AS draft_value,
      COALESCE(SUM(total) FILTER (WHERE status = 'billed' AND order_date >= date_trunc('month', CURRENT_DATE)), 0)::numeric(14,2) AS billed_this_month
    FROM purchase_orders
  `).then((r) => r.rows as Array<Record<string, string>>);

  // "Overdue for delivery" mirrors the same red flag the list's own Delivery
  // Date column already shows per row — an issued PO past its expected date.
  const [overdue] = await db.execute(sql`
    SELECT COALESCE(SUM(total), 0)::numeric(14,2) AS overdue_value
    FROM purchase_orders
    WHERE status IN ('issued', 'partially_billed')
      AND expected_delivery_date IS NOT NULL
      AND expected_delivery_date < CURRENT_DATE
  `).then((r) => r.rows as Array<{ overdue_value: string }>);

  res.json({
    openValue: agg?.open_value ?? "0.00",
    draftValue: agg?.draft_value ?? "0.00",
    billedThisMonth: agg?.billed_this_month ?? "0.00",
    overdueForDelivery: overdue?.overdue_value ?? "0.00",
  });
});

purchasesRouter.get("/orders", requirePermission("purchases", "view"), async (req, res) => {
  const query = req.query as Record<string, string | undefined>;
  const { vendorId, status, from, to, search } = query;
  const conditions = [];
  if (vendorId) conditions.push(eq(purchaseOrders.vendorId, vendorId));
  if (status) conditions.push(eq(purchaseOrders.status, status as typeof purchaseOrders.$inferSelect.status));
  if (from) conditions.push(gte(purchaseOrders.orderDate, from));
  if (to) conditions.push(lte(purchaseOrders.orderDate, to));
  const quick = quickSearch(purchaseOrderSearch, search);
  if (quick) conditions.push(quick);
  const advanced = advancedSearch(purchaseOrderSearch, query);
  conditions.push(...advanced);

  const rows = db
    .select({ ...getTableColumns(purchaseOrders), contactName: contacts.displayName })
    .from(purchaseOrders)
    .leftJoin(contacts, eq(contacts.id, purchaseOrders.vendorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(purchaseOrders.orderDate));
  const limit = listLimit(query, !!quick || advanced.length > 0);
  res.json(limit === undefined ? await rows : await rows.limit(limit));
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

        // Stamped at creation only. Editing the order later leaves whatever
        // notes the user then types — an agreed standard is agreed on the day,
        // and quietly rewriting it to today's spec would defeat recording it.
        const specNote = await describeSpecsForOrder(tx, computedLines);
        const notes = [body.notes?.trim(), specNote].filter(Boolean).join("\n\n") || undefined;

        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            number,
            vendorId: vendor.id,
            orderDate: body.orderDate,
            expectedDeliveryDate: body.expectedDeliveryDate,
            reference: body.reference,
            ...headerTotals,
            notes,
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
  /** Tax withheld from the vendor under section 194 and the like. */
  tdsAmount: money.optional(),
  tdsSection: z.string().max(12).optional(),
  lines: z.array(billLineSchema).min(1).max(200),
});


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
  const query = req.query as Record<string, string | undefined>;
  const { vendorId, status, from, to, search } = query;
  const conditions = [];
  if (vendorId) conditions.push(eq(bills.vendorId, vendorId));
  if (status) conditions.push(eq(bills.status, status as typeof bills.$inferSelect.status));
  if (from) conditions.push(gte(bills.billDate, from));
  if (to) conditions.push(lte(bills.billDate, to));
  const quick = quickSearch(billSearch, search);
  if (quick) conditions.push(quick);
  const advanced = advancedSearch(billSearch, query);
  conditions.push(...advanced);

  const rows = db
    .select({
      ...getTableColumns(bills),
      contactName: contacts.displayName,
      createdByName: users.name,
    })
    .from(bills)
    .leftJoin(contacts, eq(contacts.id, bills.vendorId))
    .leftJoin(users, eq(users.id, bills.createdBy))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(bills.billDate));
  const limit = listLimit(query, !!quick || advanced.length > 0);
  res.json(limit === undefined ? await rows : await rows.limit(limit));
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

  // Credits applied to this bill, with their journal, so a deduction can be
  // read from the bill it reduced rather than hunted for under Vendor Credits.
  // The balance moved for a reason and the reason belongs here.
  const credits = await db
    .select({
      id: vendorCredits.id,
      number: vendorCredits.number,
      creditDate: vendorCredits.creditDate,
      notes: vendorCredits.notes,
      journalEntryId: vendorCredits.journalEntryId,
      amountApplied: vendorCreditApplications.amountApplied,
    })
    .from(vendorCreditApplications)
    .innerJoin(vendorCredits, eq(vendorCredits.id, vendorCreditApplications.vendorCreditId))
    .where(eq(vendorCreditApplications.billId, bill.id));
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
    credits,
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
          tdsAmount: body.tdsAmount,
          tdsSection: body.tdsSection,
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

        const c = await computeBill(
          tx,
          vendor,
          inputLines,
          freightAmount,
          {
            amount: body.adjustment?.amount ?? bill.adjustment,
            accountId: body.adjustment?.accountId ?? bill.adjustmentAccountId,
            description: body.adjustment?.description ?? bill.adjustmentDescription,
          },
          body.tdsAmount ?? bill.tdsAmount,
        );
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

        /**
         * Stock goes back out with the money.
         *
         * The void reverses the journal, so the debit to the stock account is
         * undone; leave the quantity behind and Stock on Hand claims forty
         * tonnes of maize the ledger says was never bought.
         */
        const stockBack = await tx
          .select({ itemId: billLines.itemId, quantity: billLines.quantity, amount: billLines.amount })
          .from(billLines)
          .innerJoin(items, eq(items.id, billLines.itemId))
          .where(and(eq(billLines.billId, bill.id), eq(items.trackInventory, true)));
        await moveStock(tx, {
          movements: stockBack
            .filter((l) => Number(l.amount) > 0)
            .map((l) => ({
              itemId: l.itemId!,
              quantity: `-${Number(l.quantity).toFixed(3)}`,
              value: `-${Number(l.amount).toFixed(2)}`,
            })),
          transactionDate: req.body.voidDate,
          sourceType: "bill",
          sourceId: bill.id,
          // The same store the goods went into: reversing them somewhere else
          // would leave one store long and another short.
          stockLocationId: stockBack[0]
            ? ((await tx
                .select({ id: inventoryTransactions.stockLocationId })
                .from(inventoryTransactions)
                .where(
                  and(
                    eq(inventoryTransactions.sourceType, "bill"),
                    eq(inventoryTransactions.sourceId, bill.id),
                  ),
                )
                .limit(1))[0]?.id ?? (await mainStore(tx)))
            : await mainStore(tx),
        });

        // The item master's purchase rate follows the latest LIVE bill, so a
        // void walks it back to the one before.
        const voidedItems = await tx
          .select({ itemId: billLines.itemId })
          .from(billLines)
          .where(eq(billLines.billId, bill.id));
        const ids = [...new Set(voidedItems.map((l) => l.itemId).filter((v): v is string => !!v))];
        if (ids.length) await syncPurchaseRates(tx, ids);

        /**
         * A goods receipt is settled by its bill, so voiding the bill unsettles
         * it — the truck is back at "gated out, unpaid" and can be settled
         * again.
         *
         * "Settled" is otherwise terminal, and it should be: nobody re-bills a
         * truck on a whim. But the freeze belongs to the BILL, not to a flag on
         * the receipt. Without this the only way to correct a wrong settlement
         * is to key a bill by hand and leave the receipt pointing at a void
         * document, which is how a goods receipt and the ledger stop agreeing.
         */
        const toReopen = await tx
          .select({ id: officeReceipts.id, number: officeReceipts.number })
          .from(officeReceipts)
          .where(
            and(eq(officeReceipts.billId, bill.id), eq(officeReceipts.status, "settled")),
          );

        for (const r of toReopen) {
          /**
           * Give the order back what settling took.
           *
           * Settling discharges the purchase order by what the vendor sent.
           * Leave that behind on a void and the order reads as fully delivered
           * against a bill that no longer exists — the receipt can never be
           * matched to it again, and re-settling the same truck would discharge
           * it a second time.
           */
          const settledLines = await tx
            .select({
              poLineId: officeReceiptLines.poLineId,
              qty: officeReceiptLines.billQuantityKg,
            })
            .from(officeReceiptLines)
            .where(
              and(
                eq(officeReceiptLines.receiptId, r.id),
                eq(officeReceiptLines.status, "settled"),
              ),
            );
          for (const l of settledLines) {
            if (!l.poLineId) continue;
            await tx
              .update(purchaseOrderLines)
              .set({
                deliveredQuantity: sql`GREATEST(0, ${purchaseOrderLines.deliveredQuantity} - ${l.qty})`,
                billedQuantity: sql`GREATEST(0, ${purchaseOrderLines.billedQuantity} - ${l.qty})`,
              })
              .where(eq(purchaseOrderLines.id, l.poLineId));
          }
          // The lines go back to unloaded — off the truck, not yet billed.
          await tx
            .update(officeReceiptLines)
            .set({ status: "unloaded" })
            .where(
              and(
                eq(officeReceiptLines.receiptId, r.id),
                eq(officeReceiptLines.status, "settled"),
              ),
            );
        }

        const reopened = await tx
          .update(officeReceipts)
          .set({
            status: "gate_out",
            billId: null,
            settledAt: null,
            settledBy: null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(officeReceipts.billId, bill.id), eq(officeReceipts.status, "settled")),
          )
          .returning({ number: officeReceipts.number });

        return { ...updated!, reopenedReceipts: reopened.map((r) => r.number) };
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
  const query = req.query as Record<string, string | undefined>;
  const { vendorId, from, to, search } = query;
  const conditions = [];
  if (vendorId) conditions.push(eq(vendorPayments.vendorId, vendorId));
  if (from) conditions.push(gte(vendorPayments.paymentDate, from));
  if (to) conditions.push(lte(vendorPayments.paymentDate, to));
  const quick = quickSearch(vendorPaymentSearch, search);
  if (quick) conditions.push(quick);
  const advanced = advancedSearch(vendorPaymentSearch, query);
  conditions.push(...advanced);

  const base = db
    .select({ ...getTableColumns(vendorPayments), contactName: contacts.displayName })
    .from(vendorPayments)
    .leftJoin(contacts, eq(contacts.id, vendorPayments.vendorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(vendorPayments.paymentDate));
  const limit = listLimit(query, !!quick || advanced.length > 0);
  const rows = limit === undefined ? await base : await base.limit(limit);

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
    const query = req.query as Record<string, string | undefined>;
    const { vendorId, status, search } = query;
    const conditions = [];
    if (vendorId) conditions.push(eq(vendorCredits.vendorId, vendorId));
    if (status) conditions.push(eq(vendorCredits.status, status as typeof vendorCredits.$inferSelect.status));
    const quick = quickSearch(vendorCreditSearch, search);
    if (quick) conditions.push(quick);
    const advanced = advancedSearch(vendorCreditSearch, query);
    conditions.push(...advanced);

    const rows = db
      .select({ ...getTableColumns(vendorCredits), contactName: contacts.displayName })
      .from(vendorCredits)
      .leftJoin(contacts, eq(contacts.id, vendorCredits.vendorId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(vendorCredits.creditDate));
    const limit = listLimit(query, !!quick || advanced.length > 0);
    res.json(limit === undefined ? await rows : await rows.limit(limit));
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

        const inputLines = body.lines ?? (await vendorCreditLineInputs(tx, vc.id));

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
      const result = await db.transaction(async (tx) =>
        createVendorCredit(tx, {
          vendor: await loadVendor(tx, body.vendorId),
          seriesId: body.seriesId,
          creditDate: body.creditDate,
          reference: body.reference,
          billId: body.billId,
          notes: body.notes,
          lines: body.lines,
          postedBy: req.session.user!.id,
        }),
      );
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
      const result = await db.transaction(async (tx) =>
        applyVendorCredit(tx, {
          vendorCreditId: req.params.id!,
          applications: body.applications,
        }),
      );
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
  const query = req.query as Record<string, string | undefined>;
  const { from, to, search } = query;
  const conditions = [];
  if (from) conditions.push(gte(expenses.expenseDate, from));
  if (to) conditions.push(lte(expenses.expenseDate, to));
  const quick = quickSearch(expenseSearch, search);
  if (quick) conditions.push(quick);
  const advanced = advancedSearch(expenseSearch, query);
  conditions.push(...advanced);

  const rows = db
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
    .orderBy(desc(expenses.expenseDate));
  const limit = listLimit(query, !!quick || advanced.length > 0);
  res.json(limit === undefined ? await rows : await rows.limit(limit));
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

export function buildExpenseJeLines(args: {
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

/**
 * Post a bill from the rows already stored against it.
 *
 * The create path computes totals and posts in one pass, which is right when a
 * person is typing a bill. An import is the other way round: the amounts are
 * already known and authoritative, and recomputing them from quantity times
 * rate moves 190 of Amino's lines — up to 213 rupees on one — because Zoho
 * prices to six decimals. So this reads what is stored and posts exactly that.
 */
export async function postStoredBillJournal(
  tx: Tx,
  billId: string,
  postedBy: string,
): Promise<string> {
  const bill = await tx.query.bills.findFirst({ where: eq(bills.id, billId) });
  if (!bill) throw new PostingError("Bill not found");
  const [vendor] = await tx
    .select({ displayName: contacts.displayName })
    .from(contacts)
    .where(eq(contacts.id, bill.vendorId))
    .limit(1);

  const lines = await tx
    .select({ accountId: billLines.accountId, amount: billLines.amount })
    .from(billLines)
    .where(eq(billLines.billId, billId));

  const grouped = new Map<string, number>();
  for (const l of lines) {
    if (!l.accountId) throw new PostingError(`Bill ${bill.number} has a line with no account`);
    grouped.set(l.accountId, (grouped.get(l.accountId) ?? 0) + toPaise(l.amount));
  }

  const jeLines: Array<{
    accountId?: string;
    systemKey?: string;
    debit?: string;
    credit?: string;
    description?: string;
  }> = [];
  for (const [accountId, paise] of grouped) {
    if (paise !== 0) {
      jeLines.push({ accountId, debit: fromPaise(paise), description: `Bill ${bill.number}` });
    }
  }

  const adjP = toPaise(bill.adjustment);
  if (adjP !== 0) {
    if (!bill.adjustmentAccountId) {
      throw new PostingError(`Bill ${bill.number} has an adjustment but no account for it`);
    }
    jeLines.push(
      adjP > 0
        ? { accountId: bill.adjustmentAccountId, debit: fromPaise(adjP) }
        : { accountId: bill.adjustmentAccountId, credit: fromPaise(-adjP) },
    );
  }

  const tdsP = toPaise(bill.tdsAmount);
  if (tdsP > 0) jeLines.push({ systemKey: "tds_payable", credit: fromPaise(tdsP) });
  jeLines.push({ systemKey: "ap", credit: bill.total });

  return postJournal(tx, {
    entryDate: bill.billDate,
    narration: `Bill ${bill.number} — ${vendor?.displayName ?? ""}`,
    sourceType: "bill",
    sourceId: bill.id,
    postedBy,
    lines: jeLines,
  });
}

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

  const c = await computeBill(
    tx,
    vendor,
    await storedBillLines(tx, id),
    bill.freightAmount,
    {
      amount: bill.adjustment,
      accountId: bill.adjustmentAccountId,
      description: bill.adjustmentDescription,
    },
    bill.tdsAmount,
  );
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
