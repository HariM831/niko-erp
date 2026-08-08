import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, gte, lte } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  bankAccounts,
  billLines,
  bills,
  contacts,
  expenses,
  items,
  paymentMode,
  purchaseOrderLines,
  purchaseOrders,
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

async function loadVendor(tx: Tx, id: string) {
  const [vendor] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.type, "vendor")))
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
  grouped: Map<string, number>,
  taxTotalP: number,
  roundOffP: number,
  totalP: number,
  billNumber: string,
) {
  const jeLines: Array<{ accountId?: string; systemKey?: string; debit?: string; credit?: string; description?: string }> = [];
  let first = true;
  for (const [accountId, netP] of grouped) {
    const withRound = first ? netP + roundOffP : netP;
    first = false;
    if (withRound !== 0) {
      jeLines.push({ accountId, debit: fromPaise(withRound), description: `Bill ${billNumber}` });
    }
  }
  if (taxTotalP > 0) jeLines.push({ systemKey: "input_gst", debit: fromPaise(taxTotalP) });
  jeLines.push({ systemKey: "ap", credit: fromPaise(totalP) });
  return jeLines;
}

// ============================ Purchase Orders ============================

const poSchema = z.object({
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
        const number = await nextDocumentNumber(tx, "purchase_order");
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
  vendorId: z.string().uuid(),
  billDate: dateStr,
  dueDate: dateStr.optional(),
  vendorBillNumber: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

interface CreateBillArgs {
  vendor: typeof contacts.$inferSelect;
  billDate: string;
  dueDate?: string;
  vendorBillNumber?: string;
  reference?: string;
  notes?: string;
  purchaseOrderId?: string;
  lines: Array<z.infer<typeof lineSchema>>;
  postedBy: string;
}

/** Shared by direct bill creation and PO conversion. Posts the JE immediately (status "open"). */
async function createBill(tx: Tx, args: CreateBillArgs) {
  const resolvedLines = await resolveLineAccounts(tx, args.lines);
  const totals = await computeDocumentTotals(
    tx,
    resolvedLines as DocLineInput[],
    args.vendor.placeOfSupplyState,
  );
  const number = await nextDocumentNumber(tx, "bill");
  const { lines: computedLines, ...headerTotals } = totals;
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
      balanceDue: headerTotals.total,
      notes: args.notes,
      createdBy: args.postedBy,
    })
    .returning();

  await tx.insert(billLines).values(
    computedLines.map((l, i) => ({
      ...l,
      accountId: resolvedLines[i]!.accountId,
      billId: bill!.id,
    })),
  );

  // Group net line amounts by debit account.
  const grouped = new Map<string, number>();
  computedLines.forEach((l, i) => {
    const acct = resolvedLines[i]!.accountId;
    grouped.set(acct, (grouped.get(acct) ?? 0) + toPaise(l.amount));
  });
  const taxTotalP = toPaise(totals.cgst) + toPaise(totals.sgst) + toPaise(totals.igst);

  const jeId = await postJournal(tx, {
    entryDate: args.billDate,
    narration: `Bill ${number} — ${args.vendor.displayName}`,
    sourceType: "bill",
    sourceId: bill!.id,
    postedBy: args.postedBy,
    lines: buildBillJeLines(grouped, taxTotalP, toPaise(totals.roundOff), toPaise(totals.total), number),
  });
  const [updated] = await tx
    .update(bills)
    .set({ journalEntryId: jeId })
    .where(eq(bills.id, bill!.id))
    .returning();
  return updated!;
}

purchasesRouter.get("/bills", requirePermission("purchases", "view"), async (req, res) => {
  const { vendorId, status, from, to } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (vendorId) conditions.push(eq(bills.vendorId, vendorId));
  if (status) conditions.push(eq(bills.status, status as typeof bills.$inferSelect.status));
  if (from) conditions.push(gte(bills.billDate, from));
  if (to) conditions.push(lte(bills.billDate, to));
  const rows = await db
    .select({ ...getTableColumns(bills), contactName: contacts.displayName })
    .from(bills)
    .leftJoin(contacts, eq(contacts.id, bills.vendorId))
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
  res.json({ ...bill, lines, payments: applications });
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
        return createBill(tx, {
          vendor,
          billDate: body.billDate,
          dueDate: body.dueDate,
          vendorBillNumber: body.vendorBillNumber,
          reference: body.reference,
          notes: body.notes,
          lines: body.lines,
          postedBy: req.session.user!.id,
        });
      });
      res.status(201).json(result);
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
        if (bill.journalEntryId) {
          await reverseJournal(tx, bill.journalEntryId, req.body.voidDate, req.session.user!.id);
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
  res.json(rows);
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

        const number = await nextDocumentNumber(tx, "vendor_payment");
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

// ============================ Vendor Credits ============================

const vendorCreditSchema = z.object({
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

/** Reverse of a bill: DR AP, CR the line accounts + input GST. */
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
        const number = await nextDocumentNumber(tx, "vendor_credit");
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
  expenseDate: dateStr,
  expenseAccountId: z.string().uuid(),
  paidThroughId: z.string().uuid(),
  vendorId: z.string().uuid().optional(),
  amount: money,
  taxId: z.string().uuid().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

purchasesRouter.get("/expenses", requirePermission("purchases", "view"), async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (from) conditions.push(gte(expenses.expenseDate, from));
  if (to) conditions.push(lte(expenses.expenseDate, to));
  const rows = await db
    .select({ ...getTableColumns(expenses), contactName: contacts.displayName })
    .from(expenses)
    .leftJoin(contacts, eq(contacts.id, expenses.vendorId))
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
  res.json({
    ...expense,
    expenseAccountName: acct ? `${acct.code} · ${acct.name}` : null,
    paidThroughName: paidThrough?.name ?? null,
    contactName: vendor?.displayName ?? null,
  });
});

/** DR expense (+ input GST if taxed), CR the paid-through bank/cash account. */
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

        let taxP = 0;
        if (body.taxId) {
          const totals = await computeDocumentTotals(
            tx,
            [{ name: "expense", quantity: "1", rate: body.amount, taxId: body.taxId }],
            null,
          );
          taxP = toPaise(totals.cgst) + toPaise(totals.sgst) + toPaise(totals.igst);
        }

        const number = await nextDocumentNumber(tx, "expense");
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

        const jeLines: Array<{ accountId?: string; systemKey?: string; debit?: string; credit?: string; description?: string }> = [
          { accountId: body.expenseAccountId, debit: body.amount, description: `Expense ${number}` },
          { accountId: bank.glAccountId, credit: fromPaise(amountP + taxP) },
        ];
        if (taxP > 0) jeLines.push({ systemKey: "input_gst", debit: fromPaise(taxP) });

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
