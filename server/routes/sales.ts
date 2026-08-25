import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bankAccounts,
  eggDispatches,
  contacts,
  customerPayments,
  inventoryTransactions,
  invoiceLines,
  invoices,
  paymentApplications,
  paymentMode,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { gstStateCode, validateBody } from "../lib/validate";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError, postJournal, reverseJournal } from "../services/posting";
import { moveStock } from "../services/inventory";
import { unapplyInvoicePayments, voidDispatchForInvoice } from "../services/egg-sales";
import { advancedSearch, listLimit, quickSearch } from "../services/document-search";
import { customerPaymentSearch, invoiceSearch } from "../services/search-specs";
import { getPreferences } from "../services/preferences";
import {
  applyDefaultSalesAccounts,
  computeDocumentTotals,
  fromPaise,
  groupRevenueByAccount,
  toPaise,
  type DocLineInput,
} from "../services/documents";

/** A journal line as accepted by postJournal: account by id or by system key. */
type PostingLineInput = {
  accountId?: string;
  systemKey?: string;
  debit?: string;
  credit?: string;
  description?: string;
};

export const salesRouter = Router();

// ---------- Schemas ----------

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);

/**
 * A rate is not an amount. Money lands in the ledger at two decimals, but a
 * per-unit rate is stored at six and needs them — a price per egg or per
 * kilogram routinely runs past two. Validating a rate with the money rule
 * refuses the real figure outright.
 */
const rate = z.string().regex(/^\d+(\.\d{1,6})?$/);

const lineSchema = z.object({
  itemId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
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

const invoiceSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  customerId: z.string().uuid(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reference: z.string().optional(),
  placeOfSupplyState: gstStateCode.optional(),
  customerNotes: z.string().optional(),
  termsAndConditions: z.string().optional(),
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
  lines: z.array(lineSchema).min(1).max(200),
});

const paymentSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  customerId: z.string().uuid(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: money,
  mode: z.enum(paymentMode.enumValues).optional(),
  reference: z.string().optional(),
  bankAccountId: z.string().uuid(),
  notes: z.string().optional(),
  applications: z
    .array(z.object({ invoiceId: z.string().uuid(), amount: money }))
    .max(100)
    .default([]),
});

// ---------- Invoice helpers ----------

export async function loadCustomer(tx: Tx, id: string) {
  const [customer] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), inArray(contacts.type, ["customer", "both"])))
    .limit(1);
  if (!customer) throw new PostingError("Customer not found");
  if (!customer.isActive) throw new PostingError("Customer is inactive");
  return customer;
}

/**
 * DR AR / CR income + GST payable. Revenue is credited per line account, so an
 * invoice mixing eggs and feed lands on both revenue accounts rather than one
 * lump. Round-off folds into the largest revenue credit.
 */
export async function postInvoiceJournal(
  tx: Tx,
  inv: {
    id: string;
    number: string;
    invoiceDate: string;
    subTotal: string;
    discountTotal: string;
    cgst: string;
    sgst: string;
    igst: string;
    adjustment: string;
    adjustmentAccountId: string | null;
    roundOff: string;
    total: string;
  },
  customerName: string,
  postedBy: string,
): Promise<string> {
  const revenue = await tx
    .select({ accountId: invoiceLines.accountId, amount: invoiceLines.amount })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, inv.id));

  const lines: PostingLineInput[] = [
    { systemKey: "ar", debit: inv.total, description: `Invoice ${inv.number}` },
  ];
  // Tax folds into revenue rather than a payable — eggs are exempt, so there
  // is no output tax to remit. See docs/procurement-plan.md §3.
  const taxP = toPaise(inv.cgst) + toPaise(inv.sgst) + toPaise(inv.igst);
  for (const g of groupRevenueByAccount(revenue, toPaise(inv.roundOff), taxP)) {
    lines.push(
      g.accountId
        ? { accountId: g.accountId, credit: fromPaise(g.paise) }
        : { systemKey: "sales", credit: fromPaise(g.paise) },
    );
  }

  // The adjustment rides in the receivable, so its own account takes the other
  // side. Credited when it increases the total, debited when it reduces it —
  // the sign does that, so a negative adjustment needs no special case.
  const adjP = toPaise(inv.adjustment);
  if (adjP !== 0) {
    if (!inv.adjustmentAccountId) {
      throw new PostingError(`Invoice ${inv.number} has an adjustment but no account to post it to`);
    }
    lines.push(
      adjP > 0
        ? { accountId: inv.adjustmentAccountId, credit: fromPaise(adjP) }
        : { accountId: inv.adjustmentAccountId, debit: fromPaise(-adjP) },
    );
  }

  return postJournal(tx, {
    entryDate: inv.invoiceDate,
    narration: `Invoice ${inv.number} — ${customerName}`,
    sourceType: "invoice",
    sourceId: inv.id,
    postedBy,
    lines,
  });
}

export function computeDueDate(invoiceDate: string, termsDays: number): string {
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + termsDays);
  return d.toISOString().slice(0, 10);
}

// ---------- Invoice routes ----------

salesRouter.get("/invoices", requirePermission("sales", "view"), async (req, res) => {
  const query = req.query as Record<string, string | undefined>;
  const { customerId, status, from, to, search } = query;
  const conditions = [];
  if (customerId) conditions.push(eq(invoices.customerId, customerId));
  if (status) conditions.push(eq(invoices.status, status as typeof invoices.$inferSelect.status));
  if (from) conditions.push(gte(invoices.invoiceDate, from));
  if (to) conditions.push(lte(invoices.invoiceDate, to));
  const quick = quickSearch(invoiceSearch, search);
  if (quick) conditions.push(quick);
  const advanced = advancedSearch(invoiceSearch, query);
  conditions.push(...advanced);

  const rows = db
    .select({ ...getTableColumns(invoices), contactName: contacts.displayName })
    .from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.customerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoices.invoiceDate));
  const limit = listLimit(query, !!quick || advanced.length > 0);
  res.json(limit === undefined ? await rows : await rows.limit(limit));
});

/** Zoho's "Payment Summary" insights banner on the Invoices list. */
salesRouter.get("/invoices/summary", requirePermission("sales", "view"), async (_req, res) => {
  const [agg] = await db.execute(sql`
    SELECT
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('sent', 'partially_paid')), 0)::numeric(14,2) AS total_outstanding,
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('sent', 'partially_paid') AND due_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date), 0)::numeric(14,2) AS due_today,
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('sent', 'partially_paid') AND due_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND due_date <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '30 days'), 0)::numeric(14,2) AS due_within_30,
      COALESCE(SUM(balance_due) FILTER (WHERE status IN ('sent', 'partially_paid') AND due_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date), 0)::numeric(14,2) AS overdue
    FROM invoices
  `).then((r) => r.rows as Array<Record<string, string>>);

  const [avg] = await db.execute(sql`
    SELECT AVG(paid_on - i.invoice_date::date)::numeric(6,1) AS avg_days
    FROM invoices i
    JOIN (
      SELECT pa.invoice_id, MAX(cp.payment_date)::date AS paid_on
      FROM payment_applications pa
      JOIN customer_payments cp ON cp.id = pa.payment_id
      GROUP BY pa.invoice_id
    ) last_payment ON last_payment.invoice_id = i.id
    WHERE i.status = 'paid'
  `).then((r) => r.rows as Array<{ avg_days: string | null }>);

  res.json({
    totalOutstanding: agg?.total_outstanding ?? "0.00",
    dueToday: agg?.due_today ?? "0.00",
    dueWithin30Days: agg?.due_within_30 ?? "0.00",
    overdue: agg?.overdue ?? "0.00",
    avgDaysToGetPaid: avg?.avg_days ? Math.round(Number(avg.avg_days)) : 0,
  });
});

salesRouter.get("/invoices/:id", requirePermission("sales", "view"), async (req, res) => {
  const inv = await db.query.invoices.findFirst({ where: eq(invoices.id, req.params.id!) });
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  const [lines, applications] = await Promise.all([
    db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, inv.id))
      .orderBy(asc(invoiceLines.lineOrder)),
    db
      .select({
        paymentId: paymentApplications.paymentId,
        amountApplied: paymentApplications.amountApplied,
        paymentNumber: customerPayments.number,
        paymentDate: customerPayments.paymentDate,
      })
      .from(paymentApplications)
      .innerJoin(customerPayments, eq(customerPayments.id, paymentApplications.paymentId))
      .where(eq(paymentApplications.invoiceId, inv.id)),
  ]);
  res.json({ ...inv, lines, payments: applications });
});

salesRouter.post(
  "/invoices",
  requirePermission("sales", "create"),
  validateBody(invoiceSchema.extend({ saveAs: z.enum(["draft", "sent"]).default("draft") })),
  async (req, res) => {
    const body = req.body as z.infer<typeof invoiceSchema> & { saveAs: "draft" | "sent" };
    try {
      const result = await db.transaction(async (tx) => {
        const customer = await loadCustomer(tx, body.customerId);
        const totals = await computeDocumentTotals(
          tx,
          body.lines as DocLineInput[],
          body.placeOfSupplyState ?? customer.placeOfSupplyState,
          body.adjustment,
        );
        const number = await nextDocumentNumber(tx, "invoice", body.seriesId);
        const dueDate =
          body.dueDate ?? computeDueDate(body.invoiceDate, customer.paymentTermsDays);

        const [inv] = await tx
          .insert(invoices)
          .values({
            number,
            customerId: customer.id,
            status: "draft",
            invoiceDate: body.invoiceDate,
            dueDate,
            reference: body.reference,
            placeOfSupplyState: body.placeOfSupplyState ?? customer.placeOfSupplyState,
            subTotal: totals.subTotal,
            discountTotal: totals.discountTotal,
            cgst: totals.cgst,
            sgst: totals.sgst,
            igst: totals.igst,
            adjustment: totals.adjustment,
            adjustmentAccountId: totals.adjustmentAccountId,
            adjustmentDescription: totals.adjustmentDescription,
            roundOff: totals.roundOff,
            total: totals.total,
            balanceDue: totals.total,
            customerNotes: body.customerNotes,
            termsAndConditions: body.termsAndConditions,
            createdBy: req.session.user!.id,
          })
          .returning();

        const withAccounts = await applyDefaultSalesAccounts(tx, totals.lines);
        await tx
          .insert(invoiceLines)
          .values(withAccounts.map((l) => ({ ...l, invoiceId: inv!.id })));

        if (body.saveAs === "sent") {
          await assertWithinCreditLimit(tx, customer, inv!.total, inv!.id);
          const jeId = await postInvoiceJournal(tx, inv!, customer.displayName, req.session.user!.id);
          const [updated] = await tx
            .update(invoices)
            .set({ status: "sent", journalEntryId: jeId })
            .where(eq(invoices.id, inv!.id))
            .returning();
          return updated!;
        }
        return inv!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

salesRouter.patch(
  "/invoices/:id",
  requirePermission("sales", "edit"),
  validateBody(invoiceSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof invoiceSchema>>;
    try {
      const result = await db.transaction(async (tx) => {
        const inv = await tx.query.invoices.findFirst({
          where: eq(invoices.id, req.params.id!),
        });
        if (!inv) throw new PostingError("Invoice not found");
        const prefs = await getPreferences(tx);
        if (inv.status !== "draft") {
          if (!prefs.allowEditingSentInvoice) {
            throw new PostingError("Only draft invoices can be edited");
          }
          if (inv.status === "void") throw new PostingError("A void invoice cannot be edited");
          // Money already received against it would no longer match the figures.
          if (toPaise(inv.balanceDue) !== toPaise(inv.total)) {
            throw new PostingError(
              "Invoice has payments or credits applied — unapply them first",
            );
          }
        }
        const customer = await loadCustomer(tx, body.customerId ?? inv.customerId);

        let totalsPatch = {};
        if (body.lines) {
          const totals = await computeDocumentTotals(
            tx,
            body.lines as DocLineInput[],
            body.placeOfSupplyState ?? inv.placeOfSupplyState,
            body.adjustment,
          );
          const withAccounts = await applyDefaultSalesAccounts(tx, totals.lines);
          await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
          await tx
            .insert(invoiceLines)
            .values(withAccounts.map((l) => ({ ...l, invoiceId: inv.id })));
          const { lines: _lines, ...headerTotals } = totals;
          totalsPatch = { ...headerTotals, balanceDue: headerTotals.total };
        }

        const [updated] = await tx
          .update(invoices)
          .set({
            customerId: customer.id,
            invoiceDate: body.invoiceDate ?? inv.invoiceDate,
            dueDate: body.dueDate ?? inv.dueDate,
            reference: body.reference ?? inv.reference,
            placeOfSupplyState: body.placeOfSupplyState ?? inv.placeOfSupplyState,
            customerNotes: body.customerNotes ?? inv.customerNotes,
            termsAndConditions: body.termsAndConditions ?? inv.termsAndConditions,
            ...totalsPatch,
            updatedAt: new Date(),
          })
          .where(eq(invoices.id, inv.id))
          .returning();

        // An issued invoice keeps its ledger in step: the old entry is
        // reversed and a fresh one posted, so the trail survives the edit.
        if (inv.status !== "draft" && inv.journalEntryId) {
          await reverseJournal(tx, inv.journalEntryId, updated!.invoiceDate, req.session.user!.id);
          const jeId = await postInvoiceJournal(
            tx,
            updated!,
            customer.displayName,
            req.session.user!.id,
          );
          await tx
            .update(invoices)
            .set({ journalEntryId: jeId })
            .where(eq(invoices.id, inv.id));
        }
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

/**
 * Refuse to put a customer past their credit limit.
 *
 * Checked when an invoice is issued, not when it is drafted: a draft posts
 * nothing to the ledger and owes nothing, so blocking one would stop people
 * preparing work they are entitled to prepare.
 *
 * Outstanding is summed from issued, unvoided invoices — the same basis the
 * customer's own statement uses, so the number in the error is one they can
 * go and check.
 */
async function assertWithinCreditLimit(
  tx: Tx,
  customer: typeof contacts.$inferSelect,
  addingTotal: string,
  excludeInvoiceId?: string,
): Promise<void> {
  const prefs = await getPreferences(tx);
  if (!prefs.enableCreditLimit) return;
  if (customer.creditLimit === null) return;
  const limitP = toPaise(customer.creditLimit);
  if (limitP <= 0) return;

  const conditions = [
    eq(invoices.customerId, customer.id),
    ne(invoices.status, "draft"),
    ne(invoices.status, "void"),
  ];
  if (excludeInvoiceId) conditions.push(ne(invoices.id, excludeInvoiceId));

  const [row] = await tx
    .select({
      outstanding: sql<string>`COALESCE(SUM(${invoices.balanceDue}), 0)::numeric(14,2)`,
    })
    .from(invoices)
    .where(and(...conditions));

  const outstandingP = toPaise(row?.outstanding ?? "0");
  const afterP = outstandingP + toPaise(addingTotal);
  if (afterP <= limitP) return;

  throw new PostingError(
    `${customer.displayName} would owe ${fromPaise(afterP)} against a credit limit of ` +
      `${fromPaise(limitP)}. Currently outstanding ${fromPaise(outstandingP)}, this invoice ` +
      `${addingTotal} — over by ${fromPaise(afterP - limitP)}. Take a payment first, or raise ` +
      `the limit on the customer.`,
  );
}

salesRouter.post(
  "/invoices/:id/send",
  requirePermission("sales", "edit"),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const inv = await tx.query.invoices.findFirst({
          where: eq(invoices.id, req.params.id!),
        });
        if (!inv) throw new PostingError("Invoice not found");
        if (inv.status !== "draft") throw new PostingError("Invoice is not a draft");
        const customer = await loadCustomer(tx, inv.customerId);
        await assertWithinCreditLimit(tx, customer, inv.total, inv.id);
        const jeId = await postInvoiceJournal(tx, inv, customer.displayName, req.session.user!.id);
        const [updated] = await tx
          .update(invoices)
          .set({ status: "sent", journalEntryId: jeId, updatedAt: new Date() })
          .where(eq(invoices.id, inv.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

salesRouter.post(
  "/invoices/:id/void",
  requirePermission("sales", "delete"),
  validateBody(z.object({ voidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const inv = await tx.query.invoices.findFirst({
          where: eq(invoices.id, req.params.id!),
        });
        if (!inv) throw new PostingError("Invoice not found");
        if (inv.status === "void") throw new PostingError("Invoice is already void");

        /**
         * A loading-bay invoice settles itself from advances the moment it is
         * born, so "unapply first" would make every one of them unvoidable by
         * hand. For those, the applications walk themselves back into the
         * customer's advances here; a hand-raised invoice keeps the guard —
         * its applications were somebody's deliberate act.
         */
        const [bayDispatch] = await tx
          .select({ id: eggDispatches.id })
          .from(eggDispatches)
          .where(and(eq(eggDispatches.invoiceId, inv.id), ne(eggDispatches.status, "void")));
        if (bayDispatch) {
          await unapplyInvoicePayments(tx, inv.id, req.body.voidDate, req.session.user!.id);
        }

        const fresh = bayDispatch
          ? (await tx.query.invoices.findFirst({ where: eq(invoices.id, inv.id) }))!
          : inv;
        if (toPaise(fresh.balanceDue) !== toPaise(fresh.total)) {
          throw new PostingError(
            "Invoice has payments or credits applied — unapply them first",
          );
        }
        if (inv.journalEntryId) {
          await reverseJournal(tx, inv.journalEntryId, req.body.voidDate, req.session.user!.id);
        }

        /**
         * Stock the invoice moved comes back. Only egg dispatches write stock
         * against an invoice today, but the reversal is by source rather than
         * by module so the next thing that does needs no second void path.
         */
        const moved = await tx
          .select({
            itemId: inventoryTransactions.itemId,
            stockLocationId: inventoryTransactions.stockLocationId,
            qty: sql<string>`sum(${inventoryTransactions.quantity})`,
            value: sql<string>`sum(${inventoryTransactions.value})`,
          })
          .from(inventoryTransactions)
          .where(
            and(
              eq(inventoryTransactions.sourceType, "invoice"),
              eq(inventoryTransactions.sourceId, inv.id),
            ),
          )
          .groupBy(inventoryTransactions.itemId, inventoryTransactions.stockLocationId);
        if (moved.length) {
          await moveStock(tx, {
            movements: moved.map((m) => ({
              itemId: m.itemId,
              stockLocationId: m.stockLocationId,
              quantity: (-Number(m.qty)).toFixed(3),
              value: (-Number(m.value)).toFixed(2),
              notes: `Void of invoice ${inv.number}`,
            })),
            transactionDate: req.body.voidDate,
            sourceType: "invoice_void",
            sourceId: inv.id,
          });
        }

        // A voided egg invoice takes its dispatch with it; the day's order
        // line derives back to "due" on the loading bay.
        await voidDispatchForInvoice(tx, inv.id);

        const [updated] = await tx
          .update(invoices)
          .set({ status: "void", balanceDue: "0.00", updatedAt: new Date() })
          .where(eq(invoices.id, inv.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

// ---------- Payments Received ----------

/** The gradient hero strip on the Payments Received list. */
salesRouter.get("/payments/summary", requirePermission("sales", "view"), async (_req, res) => {
  const [agg] = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE payment_date >= date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_month,
      COALESCE(SUM(amount) FILTER (WHERE payment_date >= date_trunc('week', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_week,
      COALESCE(SUM(unapplied_amount) FILTER (WHERE unapplied_amount > 0), 0)::numeric(14,2) AS unapplied,
      COALESCE(SUM(amount) FILTER (WHERE payment_date >= date_trunc('year', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)), 0)::numeric(14,2) AS this_year
    FROM customer_payments
  `).then((r) => r.rows as Array<Record<string, string>>);

  res.json({
    thisMonth: agg?.this_month ?? "0.00",
    thisWeek: agg?.this_week ?? "0.00",
    unapplied: agg?.unapplied ?? "0.00",
    thisYear: agg?.this_year ?? "0.00",
  });
});

salesRouter.get("/payments", requirePermission("sales", "view"), async (req, res) => {
  const query = req.query as Record<string, string | undefined>;
  const { customerId, from, to, search } = query;
  const conditions = [];
  if (customerId) conditions.push(eq(customerPayments.customerId, customerId));
  if (from) conditions.push(gte(customerPayments.paymentDate, from));
  if (to) conditions.push(lte(customerPayments.paymentDate, to));
  const quick = quickSearch(customerPaymentSearch, search);
  if (quick) conditions.push(quick);
  const advanced = advancedSearch(customerPaymentSearch, query);
  conditions.push(...advanced);

  const base = db
    .select({ ...getTableColumns(customerPayments), contactName: contacts.displayName })
    .from(customerPayments)
    .leftJoin(contacts, eq(contacts.id, customerPayments.customerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(customerPayments.paymentDate));
  const limit = listLimit(query, !!quick || advanced.length > 0);
  const rows = limit === undefined ? await base : await base.limit(limit);

  // Applied invoice numbers per payment, e.g. Zoho's "A-INV-...,A-INV-..." Invoice# column.
  const invoiceNumbers = await db
    .select({
      paymentId: paymentApplications.paymentId,
      numbers: sql<string>`STRING_AGG(${invoices.number}, ', ' ORDER BY ${invoices.number})`,
    })
    .from(paymentApplications)
    .innerJoin(invoices, eq(invoices.id, paymentApplications.invoiceId))
    .groupBy(paymentApplications.paymentId);
  const numbersByPayment = new Map(invoiceNumbers.map((r) => [r.paymentId, r.numbers]));

  res.json(rows.map((r) => ({ ...r, invoiceNumbers: numbersByPayment.get(r.id) ?? null })));
});

salesRouter.get("/payments/:id", requirePermission("sales", "view"), async (req, res) => {
  const payment = await db.query.customerPayments.findFirst({
    where: eq(customerPayments.id, req.params.id!),
  });
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  const [contact] = await db
    .select({ displayName: contacts.displayName })
    .from(contacts)
    .where(eq(contacts.id, payment.customerId))
    .limit(1);
  const applications = await db
    .select({
      invoiceId: paymentApplications.invoiceId,
      amountApplied: paymentApplications.amountApplied,
      invoiceNumber: invoices.number,
      invoiceDate: invoices.invoiceDate,
      invoiceTotal: invoices.total,
    })
    .from(paymentApplications)
    .innerJoin(invoices, eq(invoices.id, paymentApplications.invoiceId))
    .where(eq(paymentApplications.paymentId, payment.id));
  res.json({ ...payment, contactName: contact?.displayName ?? null, applications });
});

salesRouter.post(
  "/payments",
  requirePermission("sales", "create"),
  validateBody(paymentSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof paymentSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        const customer = await loadCustomer(tx, body.customerId);

        const [bank] = await tx
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, body.bankAccountId))
          .limit(1);
        if (!bank) throw new PostingError("Bank account not found");

        const amountP = toPaise(body.amount);
        if (amountP <= 0) throw new PostingError("Payment amount must be positive");

        // Validate applications against live invoice balances.
        let appliedP = 0;
        for (const app of body.applications) {
          const inv = await tx.query.invoices.findFirst({
            where: eq(invoices.id, app.invoiceId),
          });
          if (!inv) throw new PostingError(`Invoice not found: ${app.invoiceId}`);
          if (inv.customerId !== customer.id) {
            throw new PostingError(`Invoice ${inv.number} belongs to a different customer`);
          }
          if (inv.status !== "sent" && inv.status !== "partially_paid") {
            throw new PostingError(`Invoice ${inv.number} is not open for payment`);
          }
          const appP = toPaise(app.amount);
          if (appP <= 0) throw new PostingError("Application amounts must be positive");
          if (appP > toPaise(inv.balanceDue)) {
            throw new PostingError(
              `Applying ${app.amount} exceeds balance due ${inv.balanceDue} on ${inv.number}`,
            );
          }
          appliedP += appP;
        }
        if (appliedP > amountP) {
          throw new PostingError("Applied total exceeds the payment amount");
        }
        const unappliedP = amountP - appliedP;

        const number = await nextDocumentNumber(tx, "customer_payment", body.seriesId);
        const [payment] = await tx
          .insert(customerPayments)
          .values({
            number,
            customerId: customer.id,
            paymentDate: body.paymentDate,
            amount: body.amount,
            unappliedAmount: fromPaise(unappliedP),
            mode: body.mode ?? "bank_transfer",
            reference: body.reference,
            bankAccountId: bank.id,
            notes: body.notes,
            createdBy: req.session.user!.id,
          })
          .returning();

        // Apply to invoices and update their balances/status.
        for (const app of body.applications) {
          await tx.insert(paymentApplications).values({
            paymentId: payment!.id,
            invoiceId: app.invoiceId,
            amountApplied: app.amount,
          });
          const inv = (await tx.query.invoices.findFirst({
            where: eq(invoices.id, app.invoiceId),
          }))!;
          const newBalanceP = toPaise(inv.balanceDue) - toPaise(app.amount);
          await tx
            .update(invoices)
            .set({
              balanceDue: fromPaise(newBalanceP),
              status: newBalanceP === 0 ? "paid" : "partially_paid",
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, inv.id));
        }

        // DR bank; CR AR for applied; CR customer advances for unapplied.
        const jeLines = [
          {
            accountId: bank.glAccountId,
            debit: body.amount,
            description: `Payment ${number}`,
          },
        ];
        if (appliedP > 0) jeLines.push({ systemKey: "ar", credit: fromPaise(appliedP) } as never);
        if (unappliedP > 0) {
          jeLines.push({ systemKey: "customer_advances", credit: fromPaise(unappliedP) } as never);
        }
        const jeId = await postJournal(tx, {
          entryDate: body.paymentDate,
          narration: `Payment ${number} — ${customer.displayName}`,
          sourceType: "customer_payment",
          sourceId: payment!.id,
          postedBy: req.session.user!.id,
          lines: jeLines,
        });

        const [updated] = await tx
          .update(customerPayments)
          .set({ journalEntryId: jeId })
          .where(eq(customerPayments.id, payment!.id))
          .returning();
        return updated!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

/**
 * Editing a payment re-states it end to end: the existing applications are undone
 * (restoring each invoice's balance and status), the journal is reversed, then the
 * new allocation is applied and a fresh journal posted.
 */
salesRouter.patch(
  "/payments/:id",
  requirePermission("sales", "edit"),
  validateBody(paymentSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof paymentSchema>>;
    try {
      const result = await db.transaction(async (tx) => {
        const payment = await tx.query.customerPayments.findFirst({
          where: eq(customerPayments.id, req.params.id!),
        });
        if (!payment) throw new PostingError("Payment not found");

        // Undo the old allocation so invoices are back to pre-payment balances.
        const oldApps = await tx
          .select()
          .from(paymentApplications)
          .where(eq(paymentApplications.paymentId, payment.id));
        for (const app of oldApps) {
          const inv = await tx.query.invoices.findFirst({ where: eq(invoices.id, app.invoiceId) });
          if (!inv) continue;
          const restoredP = toPaise(inv.balanceDue) + toPaise(app.amountApplied);
          await tx
            .update(invoices)
            .set({
              balanceDue: fromPaise(restoredP),
              status: restoredP === toPaise(inv.total) ? "sent" : "partially_paid",
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, inv.id));
        }
        await tx.delete(paymentApplications).where(eq(paymentApplications.paymentId, payment.id));

        const customer = await loadCustomer(tx, body.customerId ?? payment.customerId);
        const paymentDate = body.paymentDate ?? payment.paymentDate;
        const amount = body.amount ?? payment.amount;
        const amountP = toPaise(amount);
        if (amountP <= 0) throw new PostingError("Payment amount must be positive");

        const [bank] = await tx
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, body.bankAccountId ?? payment.bankAccountId!))
          .limit(1);
        if (!bank) throw new PostingError("Bank account not found");

        const applications =
          body.applications ??
          oldApps.map((a) => ({ invoiceId: a.invoiceId, amount: a.amountApplied }));

        let appliedP = 0;
        for (const app of applications) {
          const inv = await tx.query.invoices.findFirst({ where: eq(invoices.id, app.invoiceId) });
          if (!inv) throw new PostingError(`Invoice not found: ${app.invoiceId}`);
          if (inv.customerId !== customer.id) {
            throw new PostingError(`Invoice ${inv.number} belongs to a different customer`);
          }
          const appP = toPaise(app.amount);
          if (appP <= 0) throw new PostingError("Application amounts must be positive");
          if (appP > toPaise(inv.balanceDue)) {
            throw new PostingError(
              `Applying ${app.amount} exceeds balance due ${inv.balanceDue} on ${inv.number}`,
            );
          }
          appliedP += appP;
        }
        if (appliedP > amountP) throw new PostingError("Applied total exceeds the payment amount");
        const unappliedP = amountP - appliedP;

        for (const app of applications) {
          await tx.insert(paymentApplications).values({
            paymentId: payment.id,
            invoiceId: app.invoiceId,
            amountApplied: app.amount,
          });
          const inv = (await tx.query.invoices.findFirst({ where: eq(invoices.id, app.invoiceId) }))!;
          const newBalanceP = toPaise(inv.balanceDue) - toPaise(app.amount);
          await tx
            .update(invoices)
            .set({
              balanceDue: fromPaise(newBalanceP),
              status: newBalanceP === 0 ? "paid" : "partially_paid",
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, inv.id));
        }

        if (payment.journalEntryId) {
          await reverseJournal(tx, payment.journalEntryId, paymentDate, req.session.user!.id);
        }
        const jeLines = [
          { accountId: bank.glAccountId, debit: amount, description: `Payment ${payment.number}` },
        ];
        if (appliedP > 0) jeLines.push({ systemKey: "ar", credit: fromPaise(appliedP) } as never);
        if (unappliedP > 0) {
          jeLines.push({ systemKey: "customer_advances", credit: fromPaise(unappliedP) } as never);
        }
        const jeId = await postJournal(tx, {
          entryDate: paymentDate,
          narration: `Payment ${payment.number} — ${customer.displayName}`,
          sourceType: "customer_payment",
          sourceId: payment.id,
          postedBy: req.session.user!.id,
          lines: jeLines,
        });

        const [updated] = await tx
          .update(customerPayments)
          .set({
            customerId: customer.id,
            paymentDate,
            amount,
            unappliedAmount: fromPaise(unappliedP),
            mode: body.mode ?? payment.mode,
            reference: body.reference ?? payment.reference,
            bankAccountId: bank.id,
            notes: body.notes ?? payment.notes,
            journalEntryId: jeId,
          })
          .where(eq(customerPayments.id, payment.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

// ---------- Re-post helper (used by Bulk Update) ----------
//
// Reverses an invoice's posting and re-posts it from stored state, leaving every
// user-visible field alone. postInvoiceJournal reads the stored lines, which
// already carry whatever account Bulk Update just wrote to them.

export async function repostInvoice(tx: Tx, id: string, userId: string): Promise<void> {
  const inv = await tx.query.invoices.findFirst({ where: eq(invoices.id, id) });
  if (!inv) throw new PostingError("Invoice not found");
  if (inv.status === "void") throw new PostingError(`Invoice ${inv.number} is void`);
  // A draft has never been posted, so the new account simply applies when it is.
  if (inv.status === "draft") return;

  const [customer] = await tx
    .select({ displayName: contacts.displayName })
    .from(contacts)
    .where(eq(contacts.id, inv.customerId))
    .limit(1);

  if (inv.journalEntryId) await reverseJournal(tx, inv.journalEntryId, inv.invoiceDate, userId);
  const jeId = await postInvoiceJournal(tx, inv, customer?.displayName ?? "", userId);
  await tx.update(invoices).set({ journalEntryId: jeId }).where(eq(invoices.id, id));
}

