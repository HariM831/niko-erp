import { Router } from "express";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import {
  bankAccounts,
  contacts,
  customerPayments,
  invoiceLines,
  invoices,
  paymentApplications,
  paymentMode,
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

export const salesRouter = Router();

// ---------- Schemas ----------

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);

const lineSchema = z.object({
  itemId: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  hsnOrSac: z.string().max(10).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/),
  unit: z.string().max(20).optional(),
  rate: money,
  discountPercent: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  taxId: z.string().uuid().optional(),
});

const invoiceSchema = z.object({
  customerId: z.string().uuid(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reference: z.string().optional(),
  salesOrderId: z.string().uuid().optional(),
  placeOfSupplyState: z.string().max(4).optional(),
  customerNotes: z.string().optional(),
  termsAndConditions: z.string().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

const paymentSchema = z.object({
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

async function loadCustomer(tx: Tx, id: string) {
  const [customer] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.type, "customer")))
    .limit(1);
  if (!customer) throw new PostingError("Customer not found");
  if (!customer.isActive) throw new PostingError("Customer is inactive");
  return customer;
}

/** DR AR / CR Sales + GST payable. Round-off folds into the sales credit. */
async function postInvoiceJournal(
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
    roundOff: string;
    total: string;
  },
  customerName: string,
  postedBy: string,
): Promise<string> {
  const salesCredit = fromPaise(
    toPaise(inv.subTotal) - toPaise(inv.discountTotal) + toPaise(inv.roundOff),
  );
  const lines = [
    { systemKey: "ar", debit: inv.total, description: `Invoice ${inv.number}` },
    { systemKey: "sales", credit: salesCredit },
  ];
  if (toPaise(inv.cgst) > 0) lines.push({ systemKey: "cgst_payable", credit: inv.cgst });
  if (toPaise(inv.sgst) > 0) lines.push({ systemKey: "sgst_payable", credit: inv.sgst });
  if (toPaise(inv.igst) > 0) lines.push({ systemKey: "igst_payable", credit: inv.igst });

  return postJournal(tx, {
    entryDate: inv.invoiceDate,
    narration: `Invoice ${inv.number} — ${customerName}`,
    sourceType: "invoice",
    sourceId: inv.id,
    postedBy,
    lines,
  });
}

function computeDueDate(invoiceDate: string, termsDays: number): string {
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + termsDays);
  return d.toISOString().slice(0, 10);
}

// ---------- Invoice routes ----------

salesRouter.get("/invoices", requirePermission("sales", "view"), async (req, res) => {
  const { customerId, status, from, to } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (customerId) conditions.push(eq(invoices.customerId, customerId));
  if (status) conditions.push(eq(invoices.status, status as typeof invoices.$inferSelect.status));
  if (from) conditions.push(gte(invoices.invoiceDate, from));
  if (to) conditions.push(lte(invoices.invoiceDate, to));
  const rows = await db
    .select()
    .from(invoices)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoices.invoiceDate))
    .limit(200);
  res.json(rows);
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
        );
        const number = await nextDocumentNumber(tx, "invoice");
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
            salesOrderId: body.salesOrderId,
            placeOfSupplyState: body.placeOfSupplyState ?? customer.placeOfSupplyState,
            subTotal: totals.subTotal,
            discountTotal: totals.discountTotal,
            cgst: totals.cgst,
            sgst: totals.sgst,
            igst: totals.igst,
            roundOff: totals.roundOff,
            total: totals.total,
            balanceDue: totals.total,
            customerNotes: body.customerNotes,
            termsAndConditions: body.termsAndConditions,
            createdBy: req.session.user!.id,
          })
          .returning();

        await tx
          .insert(invoiceLines)
          .values(totals.lines.map((l) => ({ ...l, invoiceId: inv!.id })));

        if (body.saveAs === "sent") {
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
        if (inv.status !== "draft") {
          throw new PostingError("Only draft invoices can be edited");
        }
        const customer = await loadCustomer(tx, body.customerId ?? inv.customerId);

        let totalsPatch = {};
        if (body.lines) {
          const totals = await computeDocumentTotals(
            tx,
            body.lines as DocLineInput[],
            body.placeOfSupplyState ?? inv.placeOfSupplyState,
          );
          await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
          await tx
            .insert(invoiceLines)
            .values(totals.lines.map((l) => ({ ...l, invoiceId: inv.id })));
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
        if (toPaise(inv.balanceDue) !== toPaise(inv.total)) {
          throw new PostingError(
            "Invoice has payments or credits applied — unapply them first",
          );
        }
        if (inv.journalEntryId) {
          await reverseJournal(tx, inv.journalEntryId, req.body.voidDate, req.session.user!.id);
        }
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

salesRouter.get("/payments", requirePermission("sales", "view"), async (req, res) => {
  const { customerId, from, to } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (customerId) conditions.push(eq(customerPayments.customerId, customerId));
  if (from) conditions.push(gte(customerPayments.paymentDate, from));
  if (to) conditions.push(lte(customerPayments.paymentDate, to));
  const rows = await db
    .select()
    .from(customerPayments)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(customerPayments.paymentDate))
    .limit(200);
  res.json(rows);
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

        const number = await nextDocumentNumber(tx, "customer_payment");
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
