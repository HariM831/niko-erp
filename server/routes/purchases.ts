import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  attachments,
  bankAccounts,
  bankTransactions,
  journalEntries,
  orgProfile,
  paymentBatchLines,
  paymentBatches,
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
  vendorAdvanceRequests,
  vendorPaymentApplications,
  vendorPaymentRefunds,
  vendorPayments,
  ACCOUNT_SOURCES,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError, assertPeriodOpen, postJournal, reverseJournal } from "../services/posting";
import { assertLineFits, carryLinks, linkStatementLine, linkedStatementLine } from "../services/bank-links";
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
  restateBillStock,
  saveBillLineTags,
  vendorCreditLineInputs,
} from "../services/purchases";
import { describeSpecsForOrder } from "../services/qc";
import {
  applyFreightToBillLines,
  deleteFreightPayment,
  payFreight,
  planFreight,
  postFreightCharges,
  voidFreightForBill,
} from "../services/freight";
import { freightCharges, freightPayments } from "@shared/schema";
import {
  buildPaymentFile,
  listPayables,
  transferMode,
  type PaymentFilePayer,
} from "../services/payment-file";
import { syncPurchaseRates } from "../services/purchases";
import { istDate } from "../services/day-resolution";
import { getPreferences } from "../services/preferences";
import { geminiModel, suggestAccounts } from "../services/account-suggestions";
import {
  applyCreditPlan,
  applyCredits,
  creditPlanFor,
  creditsFor,
  dissociatePayment,
  type Application,
  type PlannedApplication,
} from "../services/apply-credits";
import { positionOf, settlePayment } from "../services/payment-ledger";
import { advancesForOrder, cancelAdvanceRequest, createAdvanceRequest } from "../services/vendor-advances";

export const purchasesRouter = Router();

/**
 * The number a bill goes by wherever a person reads it: the vendor's own, as
 * Zoho shows it, else niko's counter for a bill entered without one. Postings
 * and error messages keep the counter — it is unique, the vendor's is not.
 */
const billNoSql = sql<string>`COALESCE(NULLIF(TRIM(${bills.vendorBillNumber}), ''), ${bills.number})`;

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);
/**
 * A rate is not an amount. Money lands in the ledger at two decimals, but a
 * per-unit rate is stored at six and needs them: feed comes in at ₹52.815/kg,
 * and rounding that to ₹52.82 moves a 43-tonne truck by ₹216. Validating a
 * rate with the money rule refused the real figure outright.
 */
const rate = z.string().regex(/^\d+(\.\d{1,6})?$/);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Where a head came from, and what niko offered — see the account-suggestions service. */
const headSource = {
  accountSource: z.enum(ACCOUNT_SOURCES).optional(),
  suggestedAccountId: z.string().uuid().optional(),
};

const lineSchema = z.object({
  itemId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  ...headSource,
  name: z.string().min(1),
  description: z.string().optional(),
  hsnOrSac: z.string().max(10).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/),
  unit: z.string().max(20).optional(),
  rate,
  discountPercent: z
    .string()
    .regex(/^\d+(\.\d{1,3})?$/)
    .refine((v) => Number(v) <= 100, "Discount cannot exceed 100%")
    .optional(),
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
  /** Freight we pay the transporter: per ton on the vendor's billed kilos, or a lump sum a truck. */
  freightBasis: z.enum(["none", "per_ton", "per_truck"]).optional(),
  freightRate: money.optional(),
  /** Custom field values — a location-lookup field is what prints under "Deliver To". */
  customFields: z.record(z.string(), z.any()).optional(),
  lines: z
    .array(
      lineSchema.extend({
        /** The line being edited. Absent on a new line, and on every line of a new order. */
        id: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(200),
});

/** The gradient hero strip on the Purchase Orders list — same shape as Bills'. */
purchasesRouter.get("/orders/summary", requirePermission("purchases", "view"), async (_req, res) => {
  const [agg] = await db.execute(sql`
    SELECT
      COALESCE(SUM(total) FILTER (WHERE status IN ('issued', 'partially_billed')), 0)::numeric(14,2) AS open_value,
      COALESCE(SUM(total) FILTER (WHERE status = 'draft'), 0)::numeric(14,2) AS draft_value,
      COALESCE(SUM(total) FILTER (WHERE status = 'billed' AND order_date >= date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS billed_this_month
    FROM purchase_orders
  `).then((r) => r.rows as Array<Record<string, string>>);

  // "Overdue for delivery" mirrors the same red flag the list's own Delivery
  // Date column already shows per row — an issued PO past its expected date.
  const [overdue] = await db.execute(sql`
    SELECT COALESCE(SUM(total), 0)::numeric(14,2) AS overdue_value
    FROM purchase_orders
    WHERE status IN ('issued', 'partially_billed')
      AND expected_delivery_date IS NOT NULL
      AND expected_delivery_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
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
  // The allowance the gate applies to this order: the org's, plus any extension.
  const [ext] = po.extraAllowanceBy
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, po.extraAllowanceBy))
    : [];
  const orgPct = Number((await getPreferences(db)).poOverDeliveryPct);
  const customFieldValues = await readCustomFieldValues(db, "purchase_order", po.id);
  res.json({
    ...po,
    lines,
    customFieldValues,
    allowance: { orgPct, extraPct: Number(po.extraAllowancePct), by: ext?.name ?? null },
  });
});

/** A PO posts no journal, so editing is a plain re-state — but not once it's been billed. */
purchasesRouter.patch(
  "/orders/:id",
  requirePermission("purchases", "edit"),
  validateBody(poSchema.partial()),
  async (req, res) => {
    const body = req.body as PurchaseOrderEdit;
    try {
      const result = await db.transaction(async (tx) => {
        const po = await editPurchaseOrder(tx, req.params.id!, body);
        await saveCustomFieldValues(tx, "purchase_order", po.id, body.customFields);
        return po;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

export type PurchaseOrderEdit = Partial<z.infer<typeof poSchema>>;

/**
 * Edit an unbilled purchase order in place. The route above is this inside a
 * transaction; scripts/check-po-edit.ts calls it directly and rolls it back.
 */
export async function editPurchaseOrder(tx: Tx, orderId: string, body: PurchaseOrderEdit) {
  const po = await tx.query.purchaseOrders.findFirst({
    where: eq(purchaseOrders.id, orderId),
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

    /**
     * Lines are edited in place, not deleted and written again.
     *
     * A line is what a truck at the gate is matched to, and what the
     * delivered and billed counts accumulate on. Rewriting every line on
     * each save threw those counts away, and once a lorry had been matched
     * — even one turned back at QC — the database refused the save
     * outright, because the goods receipt would have pointed at nothing.
     * So a line that comes back with its id is updated where it stands; a
     * line without one is new; and a line that is gone is removed only if
     * no goods receipt names it.
     */
    const existing = await tx
      .select({ id: purchaseOrderLines.id, name: purchaseOrderLines.name })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    const existingIds = new Set(existing.map((l) => l.id));
    const kept = new Set(body.lines.map((l) => l.id).filter((id): id is string => !!id && existingIds.has(id)));
    const dropped = existing.filter((l) => !kept.has(l.id));
    if (dropped.length) {
      const used = await tx
        .select({
          poLineId: officeReceiptLines.poLineId,
          number: officeReceipts.number,
          vehicle: officeReceipts.vehicleNumber,
        })
        .from(officeReceiptLines)
        .innerJoin(officeReceipts, eq(officeReceipts.id, officeReceiptLines.receiptId))
        .where(inArray(officeReceiptLines.poLineId, dropped.map((l) => l.id)));
      if (used.length) {
        // One sentence per line, naming every truck matched to it.
        const byLine = new Map<string, string[]>();
        for (const u of used) byLine.set(u.poLineId!, [...(byLine.get(u.poLineId!) ?? []), `${u.number} (${u.vehicle})`]);
        const names = new Map(dropped.map((l) => [l.id, l.name]));
        throw new PostingError(
          [...byLine]
            .map(([lineId, trucks]) =>
              `"${names.get(lineId)}" cannot be removed: ${trucks.length === 1 ? "goods receipt" : "goods receipts"} ${trucks.join(", ")} ${trucks.length === 1 ? "was" : "were"} matched to it`,
            )
            .join(". "),
        );
      }
      await tx.delete(purchaseOrderLines).where(inArray(purchaseOrderLines.id, dropped.map((l) => l.id)));
    }
    for (const [i, l] of computedLines.entries()) {
      const values = { ...l, accountId: resolvedLines[i]!.accountId, purchaseOrderId: po.id };
      const id = body.lines[i]!.id;
      if (id && kept.has(id)) {
        await tx.update(purchaseOrderLines).set(values).where(eq(purchaseOrderLines.id, id));
      } else {
        await tx.insert(purchaseOrderLines).values(values);
      }
    }
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
      freightBasis: body.freightBasis ?? po.freightBasis,
      freightRate: body.freightBasis === "none" ? "0" : (body.freightRate ?? po.freightRate),
      ...totalsPatch,
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrders.id, po.id))
    .returning();
  return updated!;
}

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
        const number = await nextDocumentNumber(tx, "purchase_order", body.seriesId, body.orderDate);
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
            freightBasis: body.freightBasis ?? "none",
            freightRate: body.freightBasis && body.freightBasis !== "none" ? (body.freightRate ?? "0") : "0",
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
        await saveCustomFieldValues(tx, "purchase_order", po!.id, body.customFields);
        return po!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/**
 * Let one order take up to 5% more than the org-wide allowance (3 Oct 2026):
 * a purchase manager's decision, kept on the order with the reason. Setting it
 * again replaces it; 0 takes it back.
 */
purchasesRouter.post(
  "/orders/:id/extend",
  requirePermission("purchases", "extend"),
  validateBody(z.object({ pct: z.number().min(0).max(5), reason: z.string().trim().min(3).max(300) })),
  async (req, res) => {
    const { pct, reason } = req.body as { pct: number; reason: string };
    const po = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, req.params.id!) });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });
    if (po.status === "cancelled" || po.status === "closed") {
      return res.status(422).json({ error: `${po.number} is ${po.status} — reopen it before extending` });
    }
    const [row] = await db
      .update(purchaseOrders)
      .set({
        extraAllowancePct: pct.toFixed(2),
        extraAllowanceReason: pct > 0 ? reason : `Taken back: ${reason}`,
        extraAllowanceBy: req.session.user!.id,
        extraAllowanceAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, po.id))
      .returning();
    res.json(row);
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

        /**
         * The PO's freight, for the one truck a whole-order bill stands for.
         * Per ton needs the lines in weight; kilos, quintals or tonnes.
         */
        const KG_PER: Record<string, number> = { kg: 1, kgs: 1, qtl: 100, quintal: 100, t: 1000, ton: 1000, tons: 1000, tonne: 1000, mt: 1000 };
        const accounts = await resolveLineAccounts(
          tx,
          poLines.map((l) => ({ itemId: l.itemId ?? undefined, accountId: l.accountId ?? undefined, name: l.name })),
        );
        const freightPlans = await planFreight(tx, [
          {
            purchaseOrderId: po.id,
            lines: poLines.map((l, i) => {
              const per = KG_PER[(l.unit ?? "").trim().toLowerCase()];
              return {
                key: l.id,
                itemId: l.itemId,
                accountId: accounts[i]!.accountId,
                name: l.name,
                kg: per ? Number(l.quantity) * per : null,
                value: Number(l.amount),
              };
            }),
          },
        ]);
        const poItemIds = poLines.map((l) => l.itemId).filter((v): v is string => !!v);
        const tracked = new Set(
          poItemIds.length
            ? (
                await tx
                  .select({ id: items.id })
                  .from(items)
                  .where(and(inArray(items.id, poItemIds), eq(items.trackInventory, true)))
              ).map((r) => r.id)
            : [],
        );
        const freightStock = freightPlans.flatMap((p) =>
          p.lines
            .filter((fl) => fl.itemId && tracked.has(fl.itemId) && fl.amountP > 0)
            .map((fl) => ({ itemId: fl.itemId!, value: (fl.amountP / 100).toFixed(2) })),
        );

        const bill = await createBill(tx, {
          vendor,
          billDate: req.body.billDate,
          vendorBillNumber: req.body.vendorBillNumber,
          purchaseOrderId: po.id,
          freightStock,
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
        if (freightPlans.length) {
          await postFreightCharges(tx, {
            plans: freightPlans,
            billId: bill.id,
            billNumber: bill.number,
            chargeDate: req.body.billDate,
            userId: req.session.user!.id,
          });
          await applyFreightToBillLines(tx, bill.id);
        }

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
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('open', 'partially_paid') AND due_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date), 0)::numeric(14,2) AS due_today,
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('open', 'partially_paid') AND due_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND due_date <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '30 days'), 0)::numeric(14,2) AS due_within_30,
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('open', 'partially_paid') AND due_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date), 0)::numeric(14,2) AS overdue
    FROM bills b
    LEFT JOIN contacts c ON c.id = b.vendor_id
    WHERE COALESCE(c.is_group_company, FALSE) = FALSE
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
  const { vendorId, from, to, search } = query;
  const conditions = [];
  if (vendorId) conditions.push(eq(bills.vendorId, vendorId));
  /**
   * Group companies belong on the group page and nowhere else.
   *
   * Billing between our own companies is a different act from buying maize on
   * the market: it nets off inside the group, and mixed into this list it
   * inflates the payables figure people read every morning. Owner billing has
   * its own screen and its own endpoints, which is where these belong.
   *
   * Only when no vendor was named — asking for one counterparty is an explicit
   * request, and a drill-down that silently returned nothing is its own bug.
   */
  else conditions.push(sql`COALESCE(${contacts.isGroupCompany}, FALSE) = FALSE`);
  // Status is read by billSearch, which also knows Zoho's "Overdue" and
  // "Unpaid" — readings of a bill, not values of the column.
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
        const existing = await tx
          .select()
          .from(billLines)
          .where(eq(billLines.billId, bill.id))
          .orderBy(asc(billLines.lineOrder));
        const storedLines: Array<z.infer<typeof lineSchema>> = existing.map((l) => ({
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
        const inputLines = body.lines ?? storedLines;
        // The bill as it stood, so its stock can be moved by the difference.
        const before = await computeBill(
          tx,
          await loadVendor(tx, bill.vendorId),
          storedLines,
          bill.freightAmount,
          { amount: bill.adjustment, accountId: bill.adjustmentAccountId, description: bill.adjustmentDescription },
          bill.tdsAmount,
        );

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
        await applyFreightToBillLines(tx, bill.id);
        await restateBillStock(tx, bill.id, before, c);

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

/**
 * Zoho's "Dissociate & Add As Credit": take one payment off this bill and
 * leave the money on the payment as the vendor's credit. The payment itself
 * stays; Delete Payment is DELETE /payments/:id.
 */
purchasesRouter.post(
  "/bills/:id/payments/:paymentId/dissociate",
  requirePermission("purchases", "edit"),
  async (req, res) => {
    try {
      res.json(
        await db.transaction((tx) =>
          dissociatePayment(tx, "vendor", req.params.id!, req.params.paymentId!, req.session.user!.id),
        ),
      );
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/** What this bill could be settled with: the vendor's advances and open credits. */
purchasesRouter.get("/bills/:id/credits", requirePermission("purchases", "view"), async (req, res) => {
  try {
    res.json(await creditsFor("vendor", req.params.id!));
  } catch (err) {
    if (!handlePostingError(err, res)) throw err;
  }
});

/**
 * Settle a bill with money already paid, or with a credit note — Zoho's
 * "Apply Credits". Recording a second payment for an advance already sent is
 * what this exists to stop.
 */
purchasesRouter.post(
  "/bills/:id/apply-credits",
  requirePermission("purchases", "edit"),
  validateBody(
    z.object({
      applications: z
        .array(z.object({ kind: z.enum(["advance", "credit"]), id: z.string().uuid(), amount: money }))
        .min(1)
        .max(100),
    }),
  ),
  async (req, res) => {
    const body = req.body as { applications: Application[] };
    try {
      const result = await db.transaction(async (tx) =>
        applyCredits(tx, "vendor", req.params.id!, body.applications, req.session.user!.id),
      );
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);


/**
 * Everything spare on a vendor's ledger against everything of theirs still
 * open — the proposal only; this posts nothing.
 */
purchasesRouter.get("/vendors/:id/credit-plan", requirePermission("purchases", "view"), async (req, res) => {
  try {
    res.json(await creditPlanFor("vendor", req.params.id!));
  } catch (err) {
    if (!handlePostingError(err, res)) throw err;
  }
});

/**
 * Post that proposal. The client sends back the lines it was shown rather
 * than asking the server to recompute them, so what is posted is what was on
 * screen — and if a bill was paid in the meantime, the per-document guards
 * refuse the line and the whole party rolls back.
 */
purchasesRouter.post(
  "/vendors/:id/apply-credit-plan",
  requirePermission("purchases", "edit"),
  validateBody(
    z.object({
      plan: z
        .array(
          z.object({
            documentId: z.string().uuid(),
            documentNumber: z.string(),
            kind: z.enum(["advance", "credit"]),
            id: z.string().uuid(),
            number: z.string(),
            amount: money,
          }),
        )
        .min(1)
        .max(500),
    }),
  ),
  async (req, res) => {
    const body = req.body as { plan: PlannedApplication[] };
    try {
      res.json(await db.transaction((tx) => applyCreditPlan(tx, "vendor", body.plan, req.session.user!.id)));
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
      const result = await db.transaction((tx) => voidBill(tx, req.params.id!, req.body.voidDate, req.session.user!.id));
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/**
 * Void a bill: reverse its journals, take its stock back out, walk the
 * purchase rates back, and reopen any goods receipt it settled. The route above
 * is this inside a transaction; a check script calls it directly and rolls it
 * back.
 */
export async function voidBill(tx: Tx, billId: string, voidDate: string, userId: string) {
  const bill = await tx.query.bills.findFirst({ where: eq(bills.id, billId) });
  if (!bill) throw new PostingError("Bill not found");
  if (bill.status === "void") throw new PostingError("Bill is already void");
  if (toPaise(bill.balanceDue) !== toPaise(bill.total)) {
    throw new PostingError("Bill has payments or credits applied — unapply them first");
  }
  // Both the goods entry and the separate freight entry have to come back off.
  for (const je of [bill.journalEntryId, bill.freightJournalEntryId]) {
    if (je) await reverseJournal(tx, je, voidDate, userId);
  }
  // And the PO freight raised with it, unless the transporter is already paid.
  await voidFreightForBill(tx, bill.id, voidDate, userId);
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
   *
   * Read back from the movements the bill actually made, not rebuilt
   * from its lines: a gate settlement takes in the weighed net at its
   * landed cost, not the billed kilos, and reversing the billed figure
   * would leave the shortfall behind as stock that never existed. Per
   * store, so the goods come out of the store they went into.
   */
  const stockBack = await tx
    .select({
      itemId: inventoryTransactions.itemId,
      stockLocationId: inventoryTransactions.stockLocationId,
      quantity: sql<string>`sum(${inventoryTransactions.quantity})`,
      value: sql<string>`coalesce(sum(${inventoryTransactions.value}), 0)`,
    })
    .from(inventoryTransactions)
    .where(and(eq(inventoryTransactions.sourceType, "bill"), eq(inventoryTransactions.sourceId, bill.id)))
    .groupBy(inventoryTransactions.itemId, inventoryTransactions.stockLocationId);
  await moveStock(tx, {
    movements: stockBack
      .filter((m) => Math.abs(Number(m.quantity)) > 0.0005)
      .map((m) => ({
        itemId: m.itemId,
        stockLocationId: m.stockLocationId ?? undefined,
        quantity: (-Number(m.quantity)).toFixed(3),
        value: (-Number(m.value)).toFixed(2),
      })),
    transactionDate: voidDate,
    sourceType: "bill",
    sourceId: bill.id,
    stockLocationId: await mainStore(tx),
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
}

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
  /** Made from this bank statement line (Banking › Categorize Manually); linked to it in the same transaction. */
  bankTransactionId: z.string().uuid().optional(),
  applications: z
    .array(z.object({ billId: z.string().uuid(), amount: money }))
    .max(100)
    .default([]),
});

/** The gradient hero strip on the Payments Made list. */
purchasesRouter.get("/payments/summary", requirePermission("purchases", "view"), async (_req, res) => {
  const [agg] = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE payment_date >= date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_month,
      COALESCE(SUM(amount) FILTER (WHERE payment_date >= date_trunc('week', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_week,
      COALESCE(SUM(unapplied_amount) FILTER (WHERE unapplied_amount > 0), 0)::numeric(14,2) AS unapplied,
      COALESCE(SUM(amount) FILTER (WHERE payment_date >= date_trunc('year', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_year
    FROM vendor_payments
  `).then((r) => r.rows as Array<Record<string, string>>);

  res.json({
    thisMonth: agg?.this_month ?? "0.00",
    thisWeek: agg?.this_week ?? "0.00",
    unapplied: agg?.unapplied ?? "0.00",
    thisYear: agg?.this_year ?? "0.00",
  });
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
      numbers: sql<string>`STRING_AGG(${billNoSql}, ', ' ORDER BY ${billNoSql})`,
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
      billNumber: billNoSql,
      billDate: bills.billDate,
      billTotal: bills.total,
    })
    .from(vendorPaymentApplications)
    .innerJoin(bills, eq(bills.id, vendorPaymentApplications.billId))
    .where(eq(vendorPaymentApplications.paymentId, payment.id));
  const refunds = await db
    .select({
      ...getTableColumns(vendorPaymentRefunds),
      bankAccountName: bankAccounts.name,
    })
    .from(vendorPaymentRefunds)
    .leftJoin(bankAccounts, eq(bankAccounts.id, vendorPaymentRefunds.bankAccountId))
    .where(eq(vendorPaymentRefunds.paymentId, payment.id))
    .orderBy(asc(vendorPaymentRefunds.refundDate));
  res.json({ ...payment, contactName: contact?.displayName ?? null, applications, refunds });
});

const vendorRefundSchema = z.object({
  refundDate: dateStr,
  amount: money,
  /** The account the money came back into. */
  bankAccountId: z.string().uuid(),
  reference: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * The vendor sent money back out of an advance — Zoho's Refund on a Payment
 * Made. Only what the payment has spare can come back: money already on a bill
 * is unapplied from it first.
 */
purchasesRouter.post(
  "/payments/:id/refunds",
  requirePermission("purchases", "create"),
  validateBody(vendorRefundSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof vendorRefundSchema>;
    try {
      const refund = await db.transaction((tx) => refundVendorPayment(tx, req.params.id!, body, req.session.user!.id));
      res.status(201).json(refund);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.delete(
  "/payments/:id/refunds/:refundId",
  requirePermission("purchases", "delete"),
  async (req, res) => {
    try {
      const out = await db.transaction((tx) => deleteVendorRefund(tx, req.params.refundId!));
      res.json(out);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

export async function refundVendorPayment(
  tx: Tx,
  paymentId: string,
  body: z.infer<typeof vendorRefundSchema>,
  userId: string,
) {
  const [payment] = await tx
    .select()
    .from(vendorPayments)
    .where(eq(vendorPayments.id, paymentId))
    .for("update")
    .limit(1);
  if (!payment) throw new PostingError("Payment not found");
  await assertPeriodOpen(tx, body.refundDate, "vendor_payment");
  const amountP = toPaise(body.amount);
  if (amountP <= 0) throw new PostingError("The refund must be more than nothing");
  if (amountP > toPaise(payment.unappliedAmount)) {
    throw new PostingError(
      `${payment.number} has only ${payment.unappliedAmount} spare — unapply it from a bill first to refund more`,
    );
  }
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, body.bankAccountId)).limit(1);
  if (!bank) throw new PostingError("Bank account not found");
  const vendor = await loadVendor(tx, payment.vendorId);

  // Sourced to the payment, so its advance and its postings move together
  // (services/payment-ledger.ts). A payment from before 22 Oct 2026 not yet
  // moved still holds its advance inside payables, so that is where it leaves.
  const jeId = await postJournal(tx, {
    entryDate: body.refundDate,
    narration: `Refund on ${payment.number} — ${vendor.displayName}`,
    reference: body.reference,
    sourceType: "vendor_payment",
    sourceId: payment.id,
    postedBy: userId,
    lines: [
      { accountId: bank.glAccountId, debit: fromPaise(amountP) },
      payment.advancesInLedger
        ? { systemKey: "vendor_advances", credit: fromPaise(amountP), description: `Refund on ${payment.number}` }
        : { systemKey: "ap", credit: fromPaise(amountP), description: `Refund on ${payment.number}` },
    ],
  });
  const [refund] = await tx
    .insert(vendorPaymentRefunds)
    .values({
      paymentId: payment.id,
      refundDate: body.refundDate,
      amount: fromPaise(amountP),
      bankAccountId: bank.id,
      reference: body.reference || null,
      notes: body.notes || null,
      journalEntryId: jeId,
      createdBy: userId,
    })
    .returning();
  await tx
    .update(vendorPayments)
    .set({ unappliedAmount: fromPaise(toPaise(payment.unappliedAmount) - amountP) })
    .where(eq(vendorPayments.id, payment.id));
  return refund!;
}

/** Take a refund back off: the money is spare on the payment again. */
export async function deleteVendorRefund(tx: Tx, refundId: string) {
  const [refund] = await tx
    .select()
    .from(vendorPaymentRefunds)
    .where(eq(vendorPaymentRefunds.id, refundId))
    .limit(1);
  if (!refund) throw new PostingError("Refund not found");
  await assertPeriodOpen(tx, refund.refundDate, "vendor_payment");
  if (refund.journalEntryId) {
    const matched = await linkedStatementLine(tx, [refund.journalEntryId]);
    if (matched) throw new PostingError("This refund is matched to a bank statement line — unmatch it in Banking first");
  }
  const [payment] = await tx
    .select()
    .from(vendorPayments)
    .where(eq(vendorPayments.id, refund.paymentId))
    .for("update")
    .limit(1);
  await tx.delete(vendorPaymentRefunds).where(eq(vendorPaymentRefunds.id, refund.id));
  if (refund.journalEntryId) await tx.delete(journalEntries).where(eq(journalEntries.id, refund.journalEntryId));
  await tx
    .update(vendorPayments)
    .set({ unappliedAmount: fromPaise(toPaise(payment!.unappliedAmount) + toPaise(refund.amount)) })
    .where(eq(vendorPayments.id, payment!.id));
  return { number: payment!.number, amount: refund.amount };
}

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
      const result = await db.transaction((tx) => createVendorPayment(tx, body, req.session.user!.id));
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/**
 * Record money paid to a vendor, applied to the bills named and the rest held
 * as an advance. Also what Mark paid on a bank batch calls, once per transfer.
 */
export async function createVendorPayment(
  tx: Tx,
  body: z.infer<typeof vendorPaymentSchema>,
  userId: string,
) {
  const vendor = await loadVendor(tx, body.vendorId);
  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, body.bankAccountId))
    .limit(1);
  if (!bank) throw new PostingError("Bank account not found");
  if (body.bankTransactionId) {
    await assertLineFits(tx, body.bankTransactionId, { bankAccountId: bank.id, date: body.paymentDate });
  }

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
      advancesInLedger: true,
      createdBy: userId,
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

  const jeLines = vendorPaymentJeLines({ number, appliedP, unappliedP, tdsP, bankGlAccountId: bank.glAccountId });

  const jeId = await postJournal(tx, {
    entryDate: body.paymentDate,
    narration: `Payment ${number} — ${vendor.displayName}`,
    reference: body.reference,
    sourceType: "vendor_payment",
    sourceId: payment!.id,
    postedBy: userId,
    lines: jeLines,
  });
  const [updated] = await tx
    .update(vendorPayments)
    .set({ journalEntryId: jeId })
    .where(eq(vendorPayments.id, payment!.id))
    .returning();
  if (body.bankTransactionId) {
    await linkStatementLine(tx, { bankTransactionId: body.bankTransactionId, journalEntryIds: [jeId], kind: "categorized" });
  }
  return updated!;
}

/**
 * A vendor payment's journal: payables for what it settles, Vendor Advances for
 * what it leaves spare, the bank for what left it, TDS for what we kept back.
 *
 * Until 22 Oct 2026 niko debited payables for the whole amount, so an advance
 * hid inside payables while Zoho's payments held theirs in Vendor Advances.
 * One convention now, the selling side's: the vendor's balance reads like a
 * customer's (docs/vendor-advances-and-batches-plan.md).
 */
function vendorPaymentJeLines(args: {
  number: string;
  appliedP: number;
  unappliedP: number;
  tdsP: number;
  bankGlAccountId: string;
}) {
  const lines: Array<{ accountId?: string; systemKey?: string; debit?: string; credit?: string; description?: string }> = [];
  if (args.appliedP > 0) {
    lines.push({ systemKey: "ap", debit: fromPaise(args.appliedP), description: `Payment ${args.number}` });
  }
  if (args.unappliedP > 0) {
    lines.push({ systemKey: "vendor_advances", debit: fromPaise(args.unappliedP), description: `Advance ${args.number}` });
  }
  lines.push({ accountId: args.bankGlAccountId, credit: fromPaise(args.appliedP + args.unappliedP - args.tdsP) });
  if (args.tdsP > 0) lines.push({ systemKey: "tds_payable", credit: fromPaise(args.tdsP) });
  return lines;
}

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
      const result = await db.transaction((tx) => editVendorPayment(tx, req.params.id!, body, req.session.user!.id));
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

export async function editVendorPayment(
  tx: Tx,
  paymentId: string,
  body: Partial<z.infer<typeof vendorPaymentSchema>>,
  userId: string,
) {
  const payment = await tx.query.vendorPayments.findFirst({
    where: eq(vendorPayments.id, paymentId),
  });
  if (!payment) throw new PostingError("Payment not found");
  const before = await positionOf(tx, "vendor", payment.id);

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
  // What the vendor sent back is no longer the payment's to apply.
  const [ref] = await tx
    .select({ v: sql<string>`coalesce(sum(${vendorPaymentRefunds.amount}), 0)` })
    .from(vendorPaymentRefunds)
    .where(eq(vendorPaymentRefunds.paymentId, payment.id));
  const refundedP = toPaise(ref!.v);

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
  if (appliedP > amountP - refundedP) {
    throw new PostingError(
      refundedP > 0
        ? `Applied total exceeds what is left of the payment after ${fromPaise(refundedP)} refunded`
        : "Applied total exceeds the payment amount",
    );
  }

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
    await reverseJournal(tx, payment.journalEntryId, paymentDate, userId);
  }
  // Re-posted under the advances convention whatever it was raised under: the
  // reversal above takes back the old journal whole, so a payment from before
  // 22 Oct 2026 comes across to Vendor Advances here by itself.
  const jeLines = vendorPaymentJeLines({
    number: payment.number,
    appliedP,
    unappliedP: amountP - appliedP,
    tdsP,
    bankGlAccountId: bank.glAccountId,
  });

  const jeId = await postJournal(tx, {
    entryDate: paymentDate,
    narration: `Payment ${payment.number} — ${vendor.displayName}`,
    reference: body.reference ?? payment.reference ?? undefined,
    sourceType: "vendor_payment",
    sourceId: payment.id,
    postedBy: userId,
    lines: jeLines,
  });
  await carryLinks(tx, payment.journalEntryId, jeId, payment.number);

  const [updated] = await tx
    .update(vendorPayments)
    .set({
      vendorId: vendor.id,
      paymentDate,
      amount,
      unappliedAmount: fromPaise(amountP - appliedP - refundedP),
      tdsAmount: fromPaise(tdsP),
      mode: body.mode ?? payment.mode,
      reference: body.reference ?? payment.reference,
      bankAccountId: bank.id,
      notes: body.notes ?? payment.notes,
      journalEntryId: jeId,
      advancesInLedger: true,
    })
    .where(eq(vendorPayments.id, payment.id))
    .returning();
  // Applications made after the receipt kept their own entries; the
  // re-posted journal above restates only the receipt, so post the rest.
  await settlePayment(tx, before, {
    on: paymentDate,
    userId: userId,
    narration: `Payment ${payment.number} edited: earlier applications carried`,
  });
  return updated!;
}

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

/** The gradient hero strip on the Vendor Credits list — same shape as Credit Notes'. */
purchasesRouter.get(
  "/vendor-credits/summary",
  requirePermission("purchases", "view"),
  async (_req, res) => {
    const [agg] = await db.execute(sql`
      SELECT
        COALESCE(SUM(balance) FILTER (WHERE status = 'open'), 0)::numeric(14,2) AS open_balance,
        COALESCE(SUM(total) FILTER (WHERE credit_date >= date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS issued_this_month,
        COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
        COALESCE(SUM(total) FILTER (WHERE status = 'closed'), 0)::numeric(14,2) AS closed_value
      FROM vendor_credits
    `).then((r) => r.rows as Array<Record<string, string>>);

    res.json({
      openBalance: agg?.open_balance ?? "0.00",
      issuedThisMonth: agg?.issued_this_month ?? "0.00",
      openCount: agg?.open_count ?? 0,
      closedValue: agg?.closed_value ?? "0.00",
    });
  },
);

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
          billNumber: billNoSql,
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

// ============================ Freight ============================
//
// Freight agreed on a PO and paid to the transporter by us — see
// services/freight.ts. Each settled truck under such a PO is a charge; a
// payment clears a set of them out of a bank account.

purchasesRouter.get("/freight", requirePermission("purchases", "view"), async (req, res) => {
  const status = String(req.query.status ?? "owed");
  const rows = await db
    .select({
      id: freightCharges.id,
      chargeDate: freightCharges.chargeDate,
      vehicleNumber: freightCharges.vehicleNumber,
      basis: freightCharges.basis,
      rate: freightCharges.rate,
      quantityKg: freightCharges.quantityKg,
      amount: freightCharges.amount,
      billId: freightCharges.billId,
      billNumber: bills.number,
      purchaseOrderId: freightCharges.purchaseOrderId,
      poNumber: purchaseOrders.number,
      vendorName: contacts.displayName,
      receiptId: freightCharges.receiptId,
      receiptNumber: officeReceipts.number,
      paymentId: freightCharges.freightPaymentId,
      paymentNumber: freightPayments.number,
      paymentDate: freightPayments.paymentDate,
    })
    .from(freightCharges)
    .innerJoin(bills, eq(bills.id, freightCharges.billId))
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, freightCharges.purchaseOrderId))
    .innerJoin(contacts, eq(contacts.id, purchaseOrders.vendorId))
    .leftJoin(officeReceipts, eq(officeReceipts.id, freightCharges.receiptId))
    .leftJoin(freightPayments, eq(freightPayments.id, freightCharges.freightPaymentId))
    .where(
      and(
        sql`${freightCharges.voidedAt} IS NULL`,
        status === "owed"
          ? sql`${freightCharges.freightPaymentId} IS NULL`
          : status === "paid"
            ? sql`${freightCharges.freightPaymentId} IS NOT NULL`
            : sql`true`,
      ),
    )
    .orderBy(asc(freightCharges.chargeDate), asc(freightCharges.createdAt));
  res.json(rows);
});

purchasesRouter.get("/freight/payments", requirePermission("purchases", "view"), async (_req, res) => {
  const rows = await db
    .select({
      id: freightPayments.id,
      number: freightPayments.number,
      paymentDate: freightPayments.paymentDate,
      amount: freightPayments.amount,
      transporter: freightPayments.transporter,
      reference: freightPayments.reference,
      notes: freightPayments.notes,
      bankAccountName: bankAccounts.name,
      trucks: sql<string>`(SELECT string_agg(coalesce(c.vehicle_number, '—'), ', ' ORDER BY c.charge_date)
                             FROM freight_charges c WHERE c.freight_payment_id = ${freightPayments.id})`,
    })
    .from(freightPayments)
    .leftJoin(bankAccounts, eq(bankAccounts.id, freightPayments.bankAccountId))
    .orderBy(desc(freightPayments.paymentDate), desc(freightPayments.createdAt));
  res.json(rows);
});

purchasesRouter.post(
  "/freight/payments",
  requirePermission("purchases", "create"),
  validateBody(
    z.object({
      chargeIds: z.array(z.string().uuid()).min(1).max(200),
      paymentDate: dateStr,
      bankAccountId: z.string().uuid(),
      transporter: z.string().max(200).optional(),
      reference: z.string().max(200).optional(),
      notes: z.string().max(1000).optional(),
    }),
  ),
  async (req, res) => {
    try {
      const out = await db.transaction((tx) => payFreight(tx, { ...req.body, userId: req.session.user!.id }));
      res.status(201).json(out);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.delete("/freight/payments/:id", requirePermission("purchases", "delete"), async (req, res) => {
  try {
    await db.transaction((tx) => deleteFreightPayment(tx, req.params.id!, req.session.user!.id));
    res.json({ ok: true });
  } catch (err) {
    if (!handlePostingError(err, res)) throw err;
  }
});

// ======================= Account head suggestions =======================

const suggestSchema = z.object({
  docType: z.enum(["bill", "purchase_order", "vendor_credit", "expense"]),
  vendorId: z.string().uuid().optional(),
  lines: z
    .array(
      z.object({
        key: z.string().min(1).max(40),
        text: z.string().max(500),
        hsnOrSac: z.string().max(10).optional(),
        amount: z.string().max(20).optional(),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * The head niko would put on each hand-typed line: history first, then the
 * model for what history cannot answer. Read-only — the form fills the box and
 * the person keying sees it before anything posts.
 */
purchasesRouter.post(
  "/account-suggestions",
  requirePermission("purchases", "view"),
  validateBody(suggestSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof suggestSchema>;
    const apiKey = process.env.GEMINI_API_KEY;
    res.json(await suggestAccounts(db, body, apiKey ? geminiModel(apiKey) : null));
  },
);

// ============================ Expenses ============================

/** An expense is spending: it never lands in a stock account (6 Oct 2026). */
async function assertNotStock(tx: Tx, accountId: string) {
  const [acct] = await tx
    .select({ subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const isItemStock = await tx
    .select({ id: items.id })
    .from(items)
    .where(eq(items.inventoryAccountId, accountId))
    .limit(1);
  if (acct?.subtype === "stock" || isItemStock.length) {
    throw new PostingError(
      `"${acct?.name ?? "This account"}" is a stock account — an expense is spending and cannot go into stock. Raise a bill against the item instead.`,
    );
  }
}

const expenseSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  /** Made from this bank statement line (Banking › Categorize Manually); linked to it in the same transaction. */
  bankTransactionId: z.string().uuid().optional(),
  expenseDate: dateStr,
  expenseAccountId: z.string().uuid(),
  /**
   * Null — or absent on a new expense — means it has not been paid yet: the
   * cost is owed to the vendor rather than gone from an account. Explicitly
   * nullable so a patch can un-pay one; leaving it out of a patch keeps
   * whatever is already there, like every other field here.
   */
  paidThroughId: z.string().uuid().nullable().optional(),
  vendorId: z.string().uuid().optional(),
  /** Only meaningful while unpaid; defaults to the vendor's payment terms. */
  dueDate: dateStr.nullable().optional(),
  amount: money,
  taxId: z.string().uuid().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  ...headSource,
  /** Reporting tags for the cost — one option per tag. */
  tagOptionIds: z.array(z.string().uuid()).max(10).optional(),
  /** Custom field values, keyed by field id. */
  customFields: z.record(z.string(), z.any()).optional(),
});

/**
 * When an unpaid expense falls due.
 *
 * A typed date wins. Otherwise the vendor's own terms decide, the way they do
 * on a bill — an expense charged to a vendor who is paid in 30 days is not due
 * the afternoon somebody entered it. With no vendor and no terms it falls back
 * to the expense date, which is what "due on receipt" means.
 */
async function resolveExpenseDueDate(
  tx: Tx,
  args: {
    given: string | null | undefined;
    existing: string | null;
    expenseDate: string;
    vendorId: string | null | undefined;
  },
): Promise<string> {
  if (args.given) return args.given;
  if (args.existing) return args.existing;
  const [vendor] = args.vendorId
    ? await tx
        .select({ terms: contacts.paymentTermsDays })
        .from(contacts)
        .where(eq(contacts.id, args.vendorId))
        .limit(1)
    : [];
  return computeDueDate(args.expenseDate, vendor?.terms ?? 0);
}

/** The gradient hero strip on the Expenses list — this month leads, no aging (expenses carry no status). */
purchasesRouter.get("/expenses/summary", requirePermission("purchases", "view"), async (_req, res) => {
  const [agg] = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE expense_date >= date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_month,
      COALESCE(SUM(amount) FILTER (WHERE expense_date >= date_trunc('week', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_week,
      COALESCE(SUM(amount) FILTER (WHERE expense_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '30 days'), 0)::numeric(14,2) AS last_30_days,
      COALESCE(SUM(amount) FILTER (WHERE expense_date >= date_trunc('year', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_year
    FROM expenses
  `).then((r) => r.rows as Array<Record<string, string>>);

  res.json({
    thisMonth: agg?.this_month ?? "0.00",
    thisWeek: agg?.this_week ?? "0.00",
    last30Days: agg?.last_30_days ?? "0.00",
    thisYear: agg?.this_year ?? "0.00",
  });
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
  const [paidThrough] = expense.paidThroughId
    ? await db
        .select({ name: bankAccounts.name })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, expense.paidThroughId))
        .limit(1)
    : [];
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

/**
 * DR the cost, CR wherever the money came from — a bank account when the
 * expense was paid, Accounts Payable when it is still owed.
 */
export function buildExpenseJeLines(args: {
  expenseAccountId: string;
  /** Null on an unpaid expense, which credits Accounts Payable instead. */
  bankGlAccountId: string | null;
  amount: string;
  taxP: number;
  number: string;
  tagOptionIds?: string[];
}) {
  // Eggs are exempt, so there is no output tax and no input credit to claim.
  // Any GST a vendor charges is simply part of what the thing cost — it goes
  // into the expense account with the rest of the value, never to a separate
  // recoverable tax account. See docs/procurement-plan.md §3.
  const grossP = toPaise(args.amount) + args.taxP;
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
      debit: fromPaise(grossP),
      description: `Expense ${args.number}`,
      // The cost line is the one worth tagging: the bank credit is just where
      // the money came from, not what it was spent on.
      tagOptionIds: args.tagOptionIds,
    },
    args.bankGlAccountId
      ? { accountId: args.bankGlAccountId, credit: fromPaise(grossP) }
      : { systemKey: "ap", credit: fromPaise(grossP), description: `Expense ${args.number}` },
  ];
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

        // undefined means "not mentioned", null means "un-pay it" — the two
        // cannot collapse, or filling in an account would be the only edit a
        // patch could ever make to this field.
        const paidThroughId =
          body.paidThroughId === undefined ? expense.paidThroughId : body.paidThroughId;
        const [bank] = paidThroughId
          ? await tx.select().from(bankAccounts).where(eq(bankAccounts.id, paidThroughId)).limit(1)
          : [];
        if (paidThroughId && !bank) throw new PostingError("Paid-through account not found");
        if (body.vendorId) await loadVendor(tx, body.vendorId);
        const vendorId = body.vendorId ?? expense.vendorId;
        if (!paidThroughId && !vendorId) {
          throw new PostingError("An unpaid expense must name the vendor it is owed to");
        }

        const amount = body.amount ?? expense.amount;
        const amountP = toPaise(amount);
        if (amountP <= 0) throw new PostingError("Expense amount must be positive");

        const expenseDate = body.expenseDate ?? expense.expenseDate;
        const expenseAccountId = body.expenseAccountId ?? expense.expenseAccountId;
        if (body.expenseAccountId) await assertNotStock(tx, body.expenseAccountId);
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
          // The bank's All Transactions reads its Reference# off the journal,
          // so without this an expense showed "—" there (22 Oct 2026).
          reference: (body.reference ?? expense.reference)?.trim() || undefined,
          sourceType: "expense",
          sourceId: expense.id,
          postedBy: req.session.user!.id,
          lines: buildExpenseJeLines({
            expenseAccountId,
            bankGlAccountId: bank?.glAccountId ?? null,
            amount,
            taxP,
            number: expense.number,
            tagOptionIds,
          }),
        });
        await carryLinks(tx, expense.journalEntryId, jeId, expense.number);

        const [updated] = await tx
          .update(expenses)
          .set({
            expenseDate,
            expenseAccountId,
            paidThroughId: bank?.id ?? null,
            vendorId,
            amount,
            taxId: taxId ?? null,
            taxAmount: fromPaise(taxP),
            // A due date is a fact about money still owed. Paying the expense
            // retires it rather than leaving a date that has stopped meaning
            // anything on the row.
            dueDate: bank
              ? null
              : await resolveExpenseDueDate(tx, {
                  given: body.dueDate,
                  existing: expense.dueDate,
                  expenseDate,
                  vendorId,
                }),
            reference: body.reference ?? expense.reference,
            notes: body.notes ?? expense.notes,
            accountSource: body.accountSource ?? expense.accountSource,
            suggestedAccountId: body.suggestedAccountId ?? expense.suggestedAccountId,
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
        const [bank] = body.paidThroughId
          ? await tx
              .select()
              .from(bankAccounts)
              .where(eq(bankAccounts.id, body.paidThroughId))
              .limit(1)
          : [];
        if (body.paidThroughId && !bank) throw new PostingError("Paid-through account not found");
        if (body.vendorId) await loadVendor(tx, body.vendorId);
        if (!bank && !body.vendorId) {
          throw new PostingError("An unpaid expense must name the vendor it is owed to");
        }

        const amountP = toPaise(body.amount);
        if (amountP <= 0) throw new PostingError("Expense amount must be positive");
        if (body.bankTransactionId) {
          await assertLineFits(tx, body.bankTransactionId, { bankAccountId: bank?.id, date: body.expenseDate });
        }

        const taxP = await expenseTaxPaise(tx, body.amount, body.taxId);
        await assertNotStock(tx, body.expenseAccountId);

        const number = await nextDocumentNumber(tx, "expense", body.seriesId);
        const [expense] = await tx
          .insert(expenses)
          .values({
            number,
            expenseDate: body.expenseDate,
            expenseAccountId: body.expenseAccountId,
            paidThroughId: bank?.id ?? null,
            vendorId: body.vendorId,
            amount: body.amount,
            taxId: body.taxId,
            taxAmount: fromPaise(taxP),
            dueDate: bank
              ? null
              : await resolveExpenseDueDate(tx, {
                  given: body.dueDate,
                  existing: null,
                  expenseDate: body.expenseDate,
                  vendorId: body.vendorId ?? null,
                }),
            reference: body.reference,
            notes: body.notes,
            accountSource: body.accountSource,
            suggestedAccountId: body.suggestedAccountId,
            createdBy: req.session.user!.id,
          })
          .returning();

        const jeLines = buildExpenseJeLines({
          expenseAccountId: body.expenseAccountId,
          bankGlAccountId: bank?.glAccountId ?? null,
          amount: body.amount,
          taxP,
          number,
          tagOptionIds: body.tagOptionIds,
        });

        await saveCustomFieldValues(tx, "expense", expense!.id, body.customFields);

        const jeId = await postJournal(tx, {
          entryDate: body.expenseDate,
          narration: `Expense ${number}`,
          reference: body.reference?.trim() || undefined,
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
        if (body.bankTransactionId) {
          await linkStatementLine(tx, { bankTransactionId: body.bankTransactionId, journalEntryIds: [jeId], kind: "categorized" });
        }
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
  await applyFreightToBillLines(tx, id);

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
  const [bank] = expense.paidThroughId
    ? await tx
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.id, expense.paidThroughId))
        .limit(1)
    : [];
  if (expense.paidThroughId && !bank) throw new PostingError("Paid-through account not found");

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
    reference: expense.reference?.trim() || undefined,
    sourceType: "expense",
    sourceId: id,
    postedBy: userId,
    lines: buildExpenseJeLines({
      expenseAccountId: expense.expenseAccountId,
      bankGlAccountId: bank?.glAccountId ?? null,
      amount: expense.amount,
      taxP: await expenseTaxPaise(tx, expense.amount, expense.taxId ?? undefined),
      number: expense.number,
      tagOptionIds,
    }),
  });
  await carryLinks(tx, expense.journalEntryId, jeId, expense.number);
  await tx.update(expenses).set({ journalEntryId: jeId }).where(eq(expenses.id, id));
}

/** Purchase orders never reach the ledger, so there is nothing to re-post. */
export async function repostPurchaseOrder(_tx: Tx, _id: string, _userId: string): Promise<void> {}


/* ══ Payments: what is owed, and the file that pays it ═══════════════════ */

/**
 * Everything unpaid, bills and expenses together, for the Payments screen.
 *
 * Documents already in a bank batch drop off by default — the money is on its
 * way and sending it again is the expensive mistake this screen exists to
 * prevent — and come back with ?includeSent=1 when somebody needs to see what
 * went out.
 */
purchasesRouter.get("/payables", requirePermission("purchases", "view"), async (req, res) => {
  const rows = await listPayables(db, {
    vendorId: typeof req.query.vendorId === "string" ? req.query.vendorId : undefined,
    includeSent: req.query.includeSent === "1" || req.query.includeSent === "true",
    // The Vendor Sheet is the market's payables, as every other purchases
    // view is. The group's own companies are settled between the LLPs, not
    // out of this morning's bank file.
    excludeGroup: true,
  });
  res.json(rows);
});

/** The bank accounts a payment file can be raised from — ours, with a code. */
/**
 * Delete a payment made, as Zoho's Delete does: the payment is gone and every
 * bill it paid is owed again.
 *
 * Each bill gets back what this payment took off it, and its status follows
 * (open, or partly paid where something else still pays it). The payment's
 * journals — the one standing, and any an earlier edit reversed — are
 * removed with it, so the bank and the vendor's account read as if it had
 * never been recorded; the activity log keeps who deleted it and when.
 *
 * Refused inside a locked period, and refused while any of its journals is
 * matched to a bank statement line: the statement says the money left, and
 * the match has to be undone in Banking first.
 */
purchasesRouter.delete("/payments/:id", requirePermission("purchases", "delete"), async (req, res) => {
  try {
    const out = await db.transaction((tx) => deleteVendorPayment(tx, req.params.id!, req.session.user!.id));
    res.json(out);
  } catch (err) {
    if (!handlePostingError(err, res)) throw err;
  }
});

export async function deleteVendorPayment(tx: Tx, paymentId: string, userId: string) {
  const payment = await tx.query.vendorPayments.findFirst({ where: eq(vendorPayments.id, paymentId) });
  if (!payment) throw new PostingError("Payment not found");
  await assertPeriodOpen(tx, payment.paymentDate, "vendor_payment");
  const [refunded] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(vendorPaymentRefunds)
    .where(eq(vendorPaymentRefunds.paymentId, payment.id));
  if (refunded!.n > 0) {
    throw new PostingError(`${payment.number} has refunds recorded against it — delete them first`);
  }
  const before = await positionOf(tx, "vendor", payment.id);

  const entries = await tx
    .select({ id: journalEntries.id, isReversal: journalEntries.isReversal })
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, "vendor_payment"), eq(journalEntries.sourceId, payment.id)));
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length) {
    const matched = await linkedStatementLine(tx, entryIds);
    if (matched) {
      throw new PostingError(
        `${payment.number} is matched to a bank statement line — unmatch it in Banking before deleting it`,
      );
    }
  }

  // Every bill it paid is owed again, by what this payment took off it.
  const apps = await tx
    .select()
    .from(vendorPaymentApplications)
    .where(eq(vendorPaymentApplications.paymentId, payment.id));
  const reopened: string[] = [];
  for (const app of apps) {
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
    reopened.push(bill.number);
  }
  await tx.delete(vendorPaymentApplications).where(eq(vendorPaymentApplications.paymentId, payment.id));
  // A payment Mark paid recorded: its transfer is waiting again, and so is its
  // batch, and an advance it paid is open again — still in that batch, so it
  // is either marked paid once more or cancelled there.
  const fromBatch = await tx
    .update(paymentBatchLines)
    .set({ vendorPaymentId: null, recordedAt: null })
    .where(eq(paymentBatchLines.vendorPaymentId, payment.id))
    .returning({ batchId: paymentBatchLines.batchId });
  if (fromBatch.length) {
    await tx
      .update(paymentBatches)
      .set({ paidAt: null, paidBy: null, paidOn: null })
      .where(inArray(paymentBatches.id, [...new Set(fromBatch.map((l) => l.batchId))]));
  }
  await tx
    .update(vendorAdvanceRequests)
    .set({ status: "open", vendorPaymentId: null })
    .where(eq(vendorAdvanceRequests.vendorPaymentId, payment.id));
  await tx.delete(vendorPayments).where(eq(vendorPayments.id, payment.id));

  // Its journals: the reversals an earlier edit made first, then the rest.
  const reversals = entries.filter((e) => e.isReversal).map((e) => e.id);
  const originals = entries.filter((e) => !e.isReversal).map((e) => e.id);
  if (reversals.length) await tx.delete(journalEntries).where(inArray(journalEntries.id, reversals));
  if (originals.length) await tx.delete(journalEntries).where(inArray(journalEntries.id, originals));
  await tx
    .delete(attachments)
    .where(and(eq(attachments.entityType, "vendor_payment"), eq(attachments.entityId, payment.id)));
  // What later applications moved under their own entries goes back with it.
  await settlePayment(tx, before, {
    on: istDate(),
    userId,
    narration: `Payment ${payment.number} deleted: earlier applications handed back`,
    gone: true,
  });
  return { number: payment.number, billsReopened: reopened };
}

purchasesRouter.get(
  "/payment-batches/accounts",
  requirePermission("purchases", "view"),
  async (_req, res) => {
    const rows = await db
      .select({
        id: bankAccounts.id,
        name: bankAccounts.name,
        bankName: bankAccounts.bankName,
        accountNumber: bankAccounts.accountNumber,
        ifsc: bankAccounts.ifsc,
        bankCustomerCode: bankAccounts.bankCustomerCode,
      })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.isActive, true), eq(bankAccounts.kind, "bank")))
      .orderBy(asc(bankAccounts.name));
    res.json(rows);
  },
);

const advanceRequestSchema = z.object({
  seriesId: z.string().uuid().optional(),
  purchaseOrderId: z.string().uuid(),
  amount: money,
  proformaNumber: z.string().trim().max(60).optional(),
  proformaDate: dateStr.optional(),
  notes: z.string().trim().max(500).optional(),
});

/** Ask for an advance against a purchase order — the proforma is attached after. */
purchasesRouter.post(
  "/advances",
  requirePermission("purchases", "create"),
  validateBody(advanceRequestSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof advanceRequestSchema>;
    try {
      const created = await db.transaction((tx) => createAdvanceRequest(tx, body, req.session.user!.id));
      res.status(201).json(created);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

purchasesRouter.post(
  "/advances/:id/cancel",
  requirePermission("purchases", "delete"),
  validateBody(z.object({ reason: z.string().trim().min(1, "Say why it is being cancelled").max(500) })),
  async (req, res) => {
    const { reason } = req.body as { reason: string };
    try {
      const updated = await db.transaction((tx) =>
        cancelAdvanceRequest(tx, req.params.id!, reason, req.session.user!.id),
      );
      res.json(updated);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/** A purchase order's advances, for its page. */
purchasesRouter.get(
  "/orders/:id/advances",
  requirePermission("purchases", "view"),
  async (req, res) => {
    res.json(await advancesForOrder(db, req.params.id!));
  },
);

/**
 * Orders an advance can be asked for on — issued and not billed in full — for
 * the New advance dialog on the Vendor Sheet.
 */
purchasesRouter.get(
  "/advances/orders",
  requirePermission("purchases", "view"),
  async (_req, res) => {
    const rows = await db
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        orderDate: purchaseOrders.orderDate,
        total: purchaseOrders.total,
        vendorId: purchaseOrders.vendorId,
        vendorName: contacts.displayName,
        advanced: sql<string>`(SELECT COALESCE(SUM(r.amount), 0)::numeric(14,2) FROM vendor_advance_requests r
                                WHERE r.purchase_order_id = ${purchaseOrders.id} AND r.status IN ('open', 'paid'))`,
      })
      .from(purchaseOrders)
      .innerJoin(contacts, eq(contacts.id, purchaseOrders.vendorId))
      .where(inArray(purchaseOrders.status, ["issued", "partially_billed"]))
      .orderBy(desc(purchaseOrders.orderDate))
      .limit(500);
    res.json(rows);
  },
);

/**
 * Every batch, newest first: one row each on Sent to bank. A batch reads as
 * Sent until Mark paid records it, Paid after, and Cancelled when the file was
 * withdrawn. The counts are of live transfers — a line the bank bounced and
 * somebody cancelled is no longer part of what the batch pays.
 */
purchasesRouter.get("/payment-batches", requirePermission("purchases", "view"), async (_req, res) => {
  const rows = await db
    .select({
      ...getTableColumns(paymentBatches),
      bankAccountName: bankAccounts.name,
      createdByName: users.name,
      paidByName: sql<string | null>`(SELECT name FROM users WHERE id = ${paymentBatches.paidBy})`,
      lineCount: sql<number>`(SELECT COUNT(*)::int FROM ${paymentBatchLines} WHERE batch_id = ${paymentBatches.id})`,
      liveCount: sql<number>`(SELECT COUNT(*)::int FROM ${paymentBatchLines}
                               WHERE batch_id = ${paymentBatches.id} AND cancelled_at IS NULL)`,
      liveTotal: sql<string>`(SELECT COALESCE(SUM(amount), 0)::numeric(14,2) FROM ${paymentBatchLines}
                               WHERE batch_id = ${paymentBatches.id} AND cancelled_at IS NULL)`,
      vendorCount: sql<number>`(SELECT COUNT(DISTINCT vendor_id)::int FROM ${paymentBatchLines}
                                 WHERE batch_id = ${paymentBatches.id} AND cancelled_at IS NULL)`,
      advanceCount: sql<number>`(SELECT COUNT(*)::int FROM ${paymentBatchLines}
                                  WHERE batch_id = ${paymentBatches.id} AND cancelled_at IS NULL
                                    AND advance_request_id IS NOT NULL)`,
    })
    .from(paymentBatches)
    .leftJoin(bankAccounts, eq(bankAccounts.id, paymentBatches.bankAccountId))
    .leftJoin(users, eq(users.id, paymentBatches.createdBy))
    .orderBy(desc(paymentBatches.batchDate), desc(paymentBatches.createdAt))
    .limit(500);
  res.json(
    rows.map((r) => ({
      ...r,
      status: r.cancelledAt ? "cancelled" : r.paidAt ? "paid" : "sent",
    })),
  );
});

/**
 * One batch for its pop-up: the header, and every transfer in it with the
 * document behind it — a bill, an expense or an advance — and what went to the
 * bank for it. Cancelled transfers are included, marked, so the batch can be
 * read as it was raised.
 */
purchasesRouter.get(
  "/payment-batches/:id",
  requirePermission("purchases", "view"),
  async (req, res) => {
    const [batch] = await db
      .select({
        ...getTableColumns(paymentBatches),
        bankAccountName: bankAccounts.name,
        createdByName: users.name,
        paidByName: sql<string | null>`(SELECT name FROM users WHERE id = ${paymentBatches.paidBy})`,
        cancelledByName: sql<string | null>`(SELECT name FROM users WHERE id = ${paymentBatches.cancelledBy})`,
      })
      .from(paymentBatches)
      .leftJoin(bankAccounts, eq(bankAccounts.id, paymentBatches.bankAccountId))
      .leftJoin(users, eq(users.id, paymentBatches.createdBy))
      .where(eq(paymentBatches.id, req.params.id!))
      .limit(1);
    if (!batch) return res.status(404).json({ error: "Payment batch not found" });
    const lines = (
      await db.execute(sql`
        SELECT l.id, l.amount, l.beneficiary_name, l.account_number, l.ifsc, l.transfer_mode,
               l.remarks, l.line_order, l.cancelled_at, l.cancel_reason, l.recorded_at,
               l.vendor_id, c.display_name AS vendor_name,
               CASE WHEN l.bill_id IS NOT NULL THEN 'bill'
                    WHEN l.expense_id IS NOT NULL THEN 'expense'
                    ELSE 'advance' END AS kind,
               COALESCE(l.bill_id, l.expense_id, l.advance_request_id) AS document_id,
               COALESCE(b.number, e.number, r.number) AS number,
               CASE WHEN b.id IS NOT NULL THEN COALESCE(NULLIF(TRIM(b.vendor_bill_number), ''), b.number)
                    WHEN e.id IS NOT NULL THEN COALESCE(NULLIF(e.reference, ''), e.number)
                    ELSE COALESCE(NULLIF(r.proforma_number, ''), po.number) END AS bill_number,
               CASE WHEN b.id IS NOT NULL THEN
                      (SELECT string_agg(bl.name || COALESCE(' · ' || NULLIF(bl.description, ''), ''), ', '
                                         ORDER BY bl.line_order)
                         FROM bill_lines bl WHERE bl.bill_id = b.id)
                    WHEN e.id IS NOT NULL THEN ea.name
                    ELSE 'Advance on ' || po.number || COALESCE(' · ' || NULLIF(r.notes, ''), '') END AS description,
               COALESCE(b.bill_date, e.expense_date, r.proforma_date) AS document_date,
               COALESCE(b.due_date, e.due_date) AS due_date,
               po.id AS purchase_order_id, po.number AS purchase_order_number,
               r.proforma_number, r.proforma_date,
               vp.id AS payment_id, vp.number AS payment_number
          FROM payment_batch_lines l
          JOIN contacts c ON c.id = l.vendor_id
          LEFT JOIN bills b ON b.id = l.bill_id
          LEFT JOIN expenses e ON e.id = l.expense_id
          LEFT JOIN accounts ea ON ea.id = e.expense_account_id
          LEFT JOIN vendor_advance_requests r ON r.id = l.advance_request_id
          LEFT JOIN purchase_orders po ON po.id = COALESCE(r.purchase_order_id, b.purchase_order_id)
          LEFT JOIN vendor_payments vp ON vp.id = l.vendor_payment_id
         WHERE l.batch_id = ${batch.id}
         ORDER BY l.line_order`)
    ).rows as Array<Record<string, unknown>>;
    const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
    res.json({
      ...batch,
      status: batch.cancelledAt ? "cancelled" : batch.paidAt ? "paid" : "sent",
      lines: lines.map((l) => ({
        id: String(l.id),
        kind: String(l.kind),
        documentId: String(l.document_id),
        number: String(l.number),
        billNumber: str(l.bill_number),
        description: str(l.description),
        documentDate: str(l.document_date),
        dueDate: str(l.due_date),
        vendorId: String(l.vendor_id),
        vendorName: String(l.vendor_name),
        amount: String(l.amount),
        beneficiaryName: String(l.beneficiary_name),
        accountNumber: String(l.account_number),
        ifsc: String(l.ifsc),
        transferMode: String(l.transfer_mode),
        remarks: str(l.remarks),
        cancelledAt: str(l.cancelled_at),
        cancelReason: str(l.cancel_reason),
        recordedAt: str(l.recorded_at),
        purchaseOrderId: str(l.purchase_order_id),
        purchaseOrderNumber: str(l.purchase_order_number),
        proformaNumber: str(l.proforma_number),
        proformaDate: str(l.proforma_date),
        paymentId: str(l.payment_id),
        paymentNumber: str(l.payment_number),
      })),
    });
  },
);

/**
 * The bank's upload sheet for a batch — downloaded from Sent to bank, as often
 * as needed. Only the live transfers go in it: one cancelled before upload
 * must not reach the bank because somebody downloaded the file again.
 */
purchasesRouter.get(
  "/payment-batches/:id/file",
  requirePermission("purchases", "view"),
  async (req, res) => {
    const [batch] = await db
      .select()
      .from(paymentBatches)
      .where(eq(paymentBatches.id, req.params.id!))
      .limit(1);
    if (!batch) return res.status(404).json({ error: "Payment batch not found" });
    const [bank] = await db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.id, batch.bankAccountId))
      .limit(1);
    const lines = await db
      .select()
      .from(paymentBatchLines)
      .where(and(eq(paymentBatchLines.batchId, batch.id), sql`${paymentBatchLines.cancelledAt} IS NULL`))
      .orderBy(asc(paymentBatchLines.lineOrder));
    if (!lines.length) {
      return res.status(422).json({ error: `Every transfer in ${batch.number} is cancelled — there is nothing to send` });
    }
    sendPaymentFile(res, {
      number: batch.number,
      batchDate: batch.batchDate,
      payer: await paymentFilePayer(bank),
      lines: lines.map((l) => ({
        beneficiaryName: l.beneficiaryName,
        accountNumber: l.accountNumber,
        ifsc: l.ifsc,
        amount: l.amount,
        transferMode: l.transferMode,
        remarks: l.remarks,
      })),
      batchId: batch.id,
    });
  },
);

const paymentBatchSchema = z.object({
  seriesId: z.string().uuid().optional(),
  /** The account the bank debits. */
  bankAccountId: z.string().uuid(),
  /** Value date on the instruction; defaults to today. */
  batchDate: dateStr.optional(),
  notes: z.string().optional(),
  /**
   * Send a document that is already in an earlier batch. Off by default: the
   * likeliest reason a bill is on this list twice is that somebody forgot it
   * went out on Tuesday, and the second transfer is real money.
   */
  allowResend: z.boolean().optional(),
  items: z
    .array(
      z.object({
        kind: z.enum(["bill", "expense", "advance"]),
        id: z.string().uuid(),
        /** Part-payment; defaults to the whole outstanding amount. */
        amount: money.optional(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Put the selected bills, expenses and advances in a new batch.
 *
 * This writes an instruction, not a payment: nothing here posts to the ledger
 * and nothing marks a bill paid, because the money has not moved. Nor does it
 * hand back the file — since 22 Oct 2026 the batch waits on Sent to bank, and
 * whoever uploads to the bank downloads it there. Mark paid records the
 * payments once the bank confirms them.
 */
purchasesRouter.post(
  "/payment-batches",
  requirePermission("purchases", "create"),
  validateBody(paymentBatchSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof paymentBatchSchema>;
    try {
      const batch = await db.transaction((tx) => createPaymentBatch(tx, body, req.session.user!.id));
      res.status(201).json(batch);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

export async function createPaymentBatch(
  tx: Tx,
  body: z.infer<typeof paymentBatchSchema>,
  userId: string,
) {
  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, body.bankAccountId))
    .limit(1);
  if (!bank) throw new PostingError("Paying bank account not found");
  if (!bank.isActive) throw new PostingError("That bank account is no longer active");

  // Cheaper to refuse here than after the accounts team has uploaded the
  // file, naming the screen that fixes it. The bank's customer code is
  // not required: without one its column goes out blank and the sheet
  // still carries every account for a bulk transfer.
  const payer = await paymentFilePayer(bank, tx);
  const unset: string[] = [];
  if (!payer.accountNumber) unset.push("this account's number (Banking)");
  if (!payer.customerName) unset.push("the organisation name (Settings)");
  if (unset.length) {
    throw new PostingError(`The bank file needs ${unset.join(", and ")}`);
  }

  // The same document twice in one file is two transfers for one debt.
  const keys = body.items.map((i) => `${i.kind}:${i.id}`);
  if (new Set(keys).size !== keys.length) {
    throw new PostingError("The same document is selected more than once");
  }

  const payables = await listPayables(tx, { includeSent: true });
  const byKey = new Map(payables.map((p) => [`${p.kind}:${p.id}`, p]));

  // Everything wrong with the selection is worth saying at once: a person
  // fixing four vendors' bank details wants all four names, not the first.
  const missingRows: string[] = [];
  const missingBank: string[] = [];
  const alreadySent: string[] = [];
  const badAmount: string[] = [];

  const resolved = body.items.map((item, index) => {
    const row = byKey.get(`${item.kind}:${item.id}`);
    if (!row) {
      missingRows.push(item.id);
      return null;
    }
    if (!row.beneficiaryName || !row.bankAccountNumber || !row.bankIfsc) {
      missingBank.push(row.vendorName);
    }
    if (row.sentBatchId && !body.allowResend) {
      alreadySent.push(`${row.number} (${row.sentBatchNumber})`);
    }
    const amountP = item.amount ? toPaise(item.amount) : toPaise(row.amount);
    // An advance goes for what was asked: part of one would leave a request
    // that is neither open nor paid.
    if (amountP <= 0 || amountP > toPaise(row.amount) || (row.kind === "advance" && amountP !== toPaise(row.amount))) {
      badAmount.push(row.number);
    }
    return { item, row, amountP, index };
  });

  if (missingRows.length) {
    throw new PostingError(
      `${missingRows.length} of the selected documents are no longer unpaid — reload the page`,
    );
  }
  if (missingBank.length) {
    throw new PostingError(
      `No bank details on file for ${[...new Set(missingBank)].join(", ")}`,
    );
  }
  if (alreadySent.length) {
    throw new PostingError(`Already sent to the bank: ${alreadySent.join(", ")}`);
  }
  if (badAmount.length) {
    throw new PostingError(
      `The amount to pay must be positive and no more than the outstanding balance: ${badAmount.join(", ")}`,
    );
  }

  const batchDate = body.batchDate ?? istDate();
  const number = await nextDocumentNumber(tx, "payment_batch", body.seriesId);
  const totalP = resolved.reduce((sum, r) => sum + (r?.amountP ?? 0), 0);

  const [created] = await tx
    .insert(paymentBatches)
    .values({
      number,
      batchDate,
      bankAccountId: bank.id,
      total: fromPaise(totalP),
      notes: body.notes,
      createdBy: userId,
    })
    .returning();

  const values = resolved.filter((r) => r !== null).map((r) => ({
    batchId: created!.id,
    billId: r.row.kind === "bill" ? r.row.id : null,
    expenseId: r.row.kind === "expense" ? r.row.id : null,
    advanceRequestId: r.row.kind === "advance" ? r.row.id : null,
    vendorId: r.row.vendorId,
    amount: fromPaise(r.amountP),
    beneficiaryName: r.row.beneficiaryName!,
    accountNumber: r.row.bankAccountNumber!,
    ifsc: r.row.bankIfsc!,
    transferMode: transferMode(r.row.bankIfsc!, bank.ifsc),
    // What the vendor sees against the credit. Their own bill number where
    // we have it, since that is the one they can look up; for an advance,
    // their proforma's number, or the PO's.
    remarks: r.row.billNumber,
    lineOrder: r.index,
  }));
  await tx.insert(paymentBatchLines).values(values);

  return { id: created!.id, number, batchDate, total: fromPaise(totalP), lineCount: values.length };
}

const markPaidSchema = z.object({
  /** The day the bank paid; defaults to the batch's value date. */
  paymentDate: dateStr.optional(),
});

/**
 * The bank confirmed the file: record what it paid, in one go.
 *
 * Every live transfer not yet recorded becomes what it would have been by
 * hand — a vendor payment against the bill, a vendor payment held as an
 * advance for an advance request, or the paying account filled in on the
 * expense. All or nothing: a bill paid some other way since the file went
 * stops the run by name, and that transfer is cancelled first.
 */
purchasesRouter.post(
  "/payment-batches/:id/mark-paid",
  requirePermission("purchases", "create"),
  validateBody(markPaidSchema),
  async (req, res) => {
    const { paymentDate } = req.body as z.infer<typeof markPaidSchema>;
    try {
      const result = await db.transaction((tx) =>
        markBatchPaid(tx, req.params.id!, { paymentDate }, req.session.user!.id),
      );
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

export async function markBatchPaid(
  tx: Tx,
  batchId: string,
  opts: { paymentDate?: string },
  userId: string,
) {
  const [batch] = await tx
    .select()
    .from(paymentBatches)
    .where(eq(paymentBatches.id, batchId))
    .for("update")
    .limit(1);
  if (!batch) throw new PostingError("Payment batch not found");
  if (batch.cancelledAt) throw new PostingError(`${batch.number} is cancelled`);
  if (batch.paidAt) throw new PostingError(`${batch.number} is already marked paid`);
  const paymentDate = opts.paymentDate ?? batch.batchDate;

  const lines = await tx
    .select()
    .from(paymentBatchLines)
    .where(
      and(
        eq(paymentBatchLines.batchId, batch.id),
        sql`${paymentBatchLines.cancelledAt} IS NULL`,
        sql`${paymentBatchLines.recordedAt} IS NULL`,
      ),
    )
    .orderBy(asc(paymentBatchLines.lineOrder))
    .for("update");
  if (!lines.length) throw new PostingError(`${batch.number} has nothing left to record`);

  const payments: string[] = [];
  for (const line of lines) {
    const what = line.remarks ?? line.id;
    try {
      let vendorPaymentId: string | null = null;
      if (line.billId) {
        const payment = await createVendorPayment(
          tx,
          {
            vendorId: line.vendorId,
            paymentDate,
            amount: line.amount,
            mode: "bank_transfer",
            reference: batch.number,
            bankAccountId: batch.bankAccountId,
            notes: `Paid by bank file ${batch.number}`,
            applications: [{ billId: line.billId, amount: line.amount }],
          },
          userId,
        );
        vendorPaymentId = payment.id;
        payments.push(payment.number);
      } else if (line.advanceRequestId) {
        const [request] = await tx
          .select()
          .from(vendorAdvanceRequests)
          .where(eq(vendorAdvanceRequests.id, line.advanceRequestId))
          .for("update")
          .limit(1);
        if (!request || request.status !== "open") {
          throw new PostingError(`${request?.number ?? "the advance"} is ${request?.status ?? "gone"}`);
        }
        const payment = await createVendorPayment(
          tx,
          {
            vendorId: line.vendorId,
            paymentDate,
            amount: line.amount,
            mode: "bank_transfer",
            reference: batch.number,
            bankAccountId: batch.bankAccountId,
            notes: `Advance ${request.number} paid by bank file ${batch.number}`,
            applications: [],
          },
          userId,
        );
        await tx
          .update(vendorAdvanceRequests)
          .set({ status: "paid", vendorPaymentId: payment.id })
          .where(eq(vendorAdvanceRequests.id, request.id));
        vendorPaymentId = payment.id;
        payments.push(payment.number);
      } else if (line.expenseId) {
        const expense = await tx.query.expenses.findFirst({ where: eq(expenses.id, line.expenseId) });
        if (!expense) throw new PostingError("the expense is gone");
        if (expense.paidThroughId) throw new PostingError(`${expense.number} was marked paid some other way`);
        if (toPaise(line.amount) !== toPaise(expense.amount) + toPaise(expense.taxAmount)) {
          throw new PostingError(`${expense.number} was sent in part — record it on the expense by hand`);
        }
        await tx
          .update(expenses)
          .set({ paidThroughId: batch.bankAccountId, dueDate: null })
          .where(eq(expenses.id, expense.id));
        await repostExpense(tx, expense.id, userId);
      }
      await tx
        .update(paymentBatchLines)
        .set({ vendorPaymentId, recordedAt: new Date() })
        .where(eq(paymentBatchLines.id, line.id));
    } catch (err) {
      if (err instanceof PostingError) throw new PostingError(`${what}: ${err.message}`);
      throw err;
    }
  }

  await tx
    .update(paymentBatches)
    .set({ paidAt: new Date(), paidBy: userId, paidOn: paymentDate })
    .where(eq(paymentBatches.id, batch.id));
  return { number: batch.number, recorded: lines.length, payments };
}

const cancelTransferSchema = z.object({
  /** Why it will not happen — "never uploaded", "bounced: IFSC changed". */
  reason: z.string().trim().min(1, "Say why it is being cancelled").max(500),
});

/**
 * Cancel a whole batch: the file was raised in error or never went to the bank.
 *
 * Every transfer still live in it is cancelled with it, so their documents are
 * back on To pay (or Advances) and can go in another file. The batch and its
 * lines stay on record, marked. Nothing touches the ledger, because raising the
 * file never did. A batch marked paid is refused: its payments are in the
 * books, and they are undone by deleting them.
 */
purchasesRouter.post(
  "/payment-batches/:id/cancel",
  requirePermission("purchases", "delete"),
  validateBody(cancelTransferSchema),
  async (req, res) => {
    const { reason } = req.body as z.infer<typeof cancelTransferSchema>;
    const userId = req.session.user!.id;
    try {
      const result = await db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(paymentBatches)
          .where(eq(paymentBatches.id, req.params.id!))
          .for("update")
          .limit(1);
        if (!batch) throw new PostingError("Payment batch not found");
        if (batch.cancelledAt) throw new PostingError(`${batch.number} is already cancelled`);
        if (batch.paidAt) throw new PostingError(`${batch.number} is marked paid — delete its payments to undo it`);
        const [recorded] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(paymentBatchLines)
          .where(and(eq(paymentBatchLines.batchId, batch.id), sql`${paymentBatchLines.recordedAt} IS NOT NULL`));
        if (recorded!.n > 0) {
          throw new PostingError(`${batch.number} has transfers recorded as paid — cancel the others one by one`);
        }
        const now = new Date();
        const lines = await tx
          .update(paymentBatchLines)
          .set({ cancelledAt: now, cancelledBy: userId, cancelReason: reason })
          .where(
            and(eq(paymentBatchLines.batchId, batch.id), sql`${paymentBatchLines.cancelledAt} IS NULL`),
          )
          .returning({ id: paymentBatchLines.id });
        await tx
          .update(paymentBatches)
          .set({ cancelledAt: now, cancelledBy: userId, cancelReason: reason })
          .where(eq(paymentBatches.id, batch.id));
        return { number: batch.number, transfersCancelled: lines.length };
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/**
 * Cancel single transfers — the bank bounced a line, or one was taken out of
 * the file before upload. Their documents go back to To pay or Advances; the
 * rest of each batch stands. A transfer already recorded as paid is refused.
 * A batch left with nothing live in it is cancelled too, under the same
 * reason, so the Sent list never shows a file that sends nothing.
 */
purchasesRouter.post(
  // Not under /payment-batches/, where ":id/cancel" would claim "lines".
  "/payment-batch-lines/cancel",
  requirePermission("purchases", "delete"),
  validateBody(cancelTransferSchema.extend({ lineIds: z.array(z.string().uuid()).min(1).max(500) })),
  async (req, res) => {
    const { reason, lineIds } = req.body as z.infer<typeof cancelTransferSchema> & { lineIds: string[] };
    const userId = req.session.user!.id;
    try {
      const result = await db.transaction(async (tx) => {
        const lines = await tx
          .select({
            id: paymentBatchLines.id,
            batchId: paymentBatchLines.batchId,
            cancelledAt: paymentBatchLines.cancelledAt,
            recordedAt: paymentBatchLines.recordedAt,
            remarks: paymentBatchLines.remarks,
          })
          .from(paymentBatchLines)
          .where(inArray(paymentBatchLines.id, lineIds))
          .for("update");
        if (lines.length !== new Set(lineIds).size) {
          throw new PostingError("Some of these transfers no longer exist — reload the page");
        }
        const already = lines.filter((l) => l.cancelledAt);
        if (already.length) {
          throw new PostingError(
            `Already cancelled: ${already.map((l) => l.remarks ?? l.id).join(", ")}`,
          );
        }
        const recorded = lines.filter((l) => l.recordedAt);
        if (recorded.length) {
          throw new PostingError(
            `Recorded as paid: ${recorded.map((l) => l.remarks ?? l.id).join(", ")} — delete the payment to undo it`,
          );
        }
        const now = new Date();
        await tx
          .update(paymentBatchLines)
          .set({ cancelledAt: now, cancelledBy: userId, cancelReason: reason })
          .where(inArray(paymentBatchLines.id, lineIds));

        const batchIds = [...new Set(lines.map((l) => l.batchId))];
        const emptied = await tx
          .update(paymentBatches)
          .set({ cancelledAt: now, cancelledBy: userId, cancelReason: reason })
          .where(
            and(
              inArray(paymentBatches.id, batchIds),
              sql`${paymentBatches.cancelledAt} IS NULL`,
              sql`NOT EXISTS (SELECT 1 FROM ${paymentBatchLines} l
                              WHERE l.batch_id = ${paymentBatches.id} AND l.cancelled_at IS NULL)`,
            ),
          )
          .returning({ number: paymentBatches.number });
        // A batch whose only unrecorded transfers were these is now paid in
        // full: what is left in it is all in the books.
        await tx
          .update(paymentBatches)
          .set({ paidAt: now, paidBy: userId, paidOn: sql`(SELECT MAX(vp.payment_date) FROM payment_batch_lines l
                       JOIN vendor_payments vp ON vp.id = l.vendor_payment_id WHERE l.batch_id = ${paymentBatches.id})` })
          .where(
            and(
              inArray(paymentBatches.id, batchIds),
              sql`${paymentBatches.cancelledAt} IS NULL`,
              sql`${paymentBatches.paidAt} IS NULL`,
              sql`EXISTS (SELECT 1 FROM ${paymentBatchLines} l
                          WHERE l.batch_id = ${paymentBatches.id} AND l.recorded_at IS NOT NULL)`,
              sql`NOT EXISTS (SELECT 1 FROM ${paymentBatchLines} l
                              WHERE l.batch_id = ${paymentBatches.id} AND l.cancelled_at IS NULL
                                AND l.recorded_at IS NULL)`,
            ),
          );
        return { transfersCancelled: lines.length, batchesCancelled: emptied.map((b) => b.number) };
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/**
 * Who the bank is debiting, as their file wants it named: our customer code and
 * account from the bank account, the account name from the org profile.
 */
async function paymentFilePayer(
  bank: typeof bankAccounts.$inferSelect | undefined,
  conn: Tx | typeof db = db,
): Promise<PaymentFilePayer> {
  const [org] = await conn
    .select({ name: orgProfile.name, legalName: orgProfile.legalName })
    .from(orgProfile)
    .limit(1);
  return {
    customerCode: bank?.bankCustomerCode ?? null,
    customerName: org?.legalName || org?.name || "",
    accountNumber: bank?.accountNumber ?? null,
  };
}

function sendPaymentFile(
  res: import("express").Response,
  args: {
    number: string;
    batchDate: string;
    payer: PaymentFilePayer;
    lines: Parameters<typeof buildPaymentFile>[0]["lines"];
    batchId?: string;
  },
) {
  const file = buildPaymentFile({
    payer: args.payer,
    batchDate: args.batchDate,
    lines: args.lines,
  });
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${args.number}.xlsx"`);
  // The batch number rides in a header so the page that just POSTed a download
  // can tell the user what it raised without a second round trip.
  res.setHeader("X-Payment-Batch-Number", args.number);
  if (args.batchId) res.setHeader("X-Payment-Batch-Id", args.batchId);
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Payment-Batch-Number, X-Payment-Batch-Id",
  );
  res.send(file);
}
