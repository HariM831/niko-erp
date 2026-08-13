import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import {
  contacts,
  creditNoteApplications,
  creditNoteLines,
  creditNotes,
  invoices,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError, postJournal, reverseJournal } from "../services/posting";
import {
  applyDefaultSalesAccounts,
  computeDocumentTotals,
  fromPaise,
  groupRevenueByAccount,
  toPaise,
  type DocLineInput,
} from "../services/documents";

export const salesDocumentsRouter = Router();

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

async function loadCustomer(tx: Tx, id: string) {
  const [customer] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), inArray(contacts.type, ["customer", "both"])))
    .limit(1);
  if (!customer) throw new PostingError("Customer not found");
  if (!customer.isActive) throw new PostingError("Customer is inactive");
  return customer;
}

function handlePostingError(err: unknown, res: Parameters<Parameters<Router["post"]>[1]>[1]) {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

// ============================ Credit Notes ============================

const creditNoteSchema = z.object({
  /** Draw the document number from this series; omitted means the default. */
  seriesId: z.string().uuid().optional(),
  customerId: z.string().uuid(),
  creditNoteDate: dateStr,
  reference: z.string().optional(),
  invoiceId: z.string().uuid().optional(),
  customerNotes: z.string().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

salesDocumentsRouter.get(
  "/credit-notes",
  requirePermission("sales", "view"),
  async (req, res) => {
    const { customerId, status } = req.query as Record<string, string | undefined>;
    const conditions = [];
    if (customerId) conditions.push(eq(creditNotes.customerId, customerId));
    if (status) conditions.push(eq(creditNotes.status, status as typeof creditNotes.$inferSelect.status));
    const rows = await db
      .select({ ...getTableColumns(creditNotes), contactName: contacts.displayName })
      .from(creditNotes)
      .leftJoin(contacts, eq(contacts.id, creditNotes.customerId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(creditNotes.creditNoteDate))
      .limit(200);
    res.json(rows);
  },
);

salesDocumentsRouter.get(
  "/credit-notes/:id",
  requirePermission("sales", "view"),
  async (req, res) => {
    const cn = await db.query.creditNotes.findFirst({
      where: eq(creditNotes.id, req.params.id!),
    });
    if (!cn) return res.status(404).json({ error: "Credit note not found" });
    const [lines, applications] = await Promise.all([
      db
        .select()
        .from(creditNoteLines)
        .where(eq(creditNoteLines.creditNoteId, cn.id))
        .orderBy(asc(creditNoteLines.lineOrder)),
      db
        .select({
          invoiceId: creditNoteApplications.invoiceId,
          amountApplied: creditNoteApplications.amountApplied,
          invoiceNumber: invoices.number,
        })
        .from(creditNoteApplications)
        .innerJoin(invoices, eq(invoices.id, creditNoteApplications.invoiceId))
        .where(eq(creditNoteApplications.creditNoteId, cn.id)),
    ]);
    res.json({ ...cn, lines, applications });
  },
);

/**
 * Create and open a credit note. Posts the reverse of an invoice:
 * DR Sales (+ GST payable), CR Accounts Receivable... via the credit's
 * open balance which is then applied to invoices or refunded.
 */
salesDocumentsRouter.post(
  "/credit-notes",
  requirePermission("sales", "create"),
  validateBody(creditNoteSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof creditNoteSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        const customer = await loadCustomer(tx, body.customerId);
        if (body.invoiceId) {
          const inv = await tx.query.invoices.findFirst({
            where: eq(invoices.id, body.invoiceId),
          });
          if (!inv) throw new PostingError("Referenced invoice not found");
          if (inv.customerId !== customer.id) {
            throw new PostingError("Referenced invoice belongs to a different customer");
          }
        }
        const totals = await computeDocumentTotals(
          tx,
          body.lines as DocLineInput[],
          customer.placeOfSupplyState,
        );
        const number = await nextDocumentNumber(tx, "credit_note", body.seriesId);
        const { lines: rawLines, ...headerTotals } = totals;
        const computedLines = await applyDefaultSalesAccounts(tx, rawLines);

        const [cn] = await tx
          .insert(creditNotes)
          .values({
            number,
            customerId: customer.id,
            status: "open",
            creditNoteDate: body.creditNoteDate,
            reference: body.reference,
            invoiceId: body.invoiceId,
            ...headerTotals,
            balance: headerTotals.total,
            customerNotes: body.customerNotes,
            createdBy: req.session.user!.id,
          })
          .returning();
        await tx
          .insert(creditNoteLines)
          .values(computedLines.map((l) => ({ ...l, creditNoteId: cn!.id })));

        const jeLines = buildCreditNoteJeLines(totals, computedLines, number);

        const jeId = await postJournal(tx, {
          entryDate: body.creditNoteDate,
          narration: `Credit note ${number} — ${customer.displayName}`,
          sourceType: "credit_note",
          sourceId: cn!.id,
          postedBy: req.session.user!.id,
          lines: jeLines,
        });
        const [updated] = await tx
          .update(creditNotes)
          .set({ journalEntryId: jeId })
          .where(eq(creditNotes.id, cn!.id))
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
 * Reverse of an invoice's posting: DR income + output GST, CR AR. Income is
 * debited per line account so a credit note unwinds the same revenue accounts
 * the invoice credited.
 */
function buildCreditNoteJeLines(
  totals: Awaited<ReturnType<typeof computeDocumentTotals>>,
  lines: Array<{ accountId?: string | null; amount: string }>,
  number: string,
) {
  const jeLines: Array<{
    accountId?: string;
    systemKey?: string;
    debit?: string;
    credit?: string;
    description?: string;
  }> = [];
  let first = true;
  for (const g of groupRevenueByAccount(lines, toPaise(totals.roundOff))) {
    const description = first ? `Credit note ${number}` : undefined;
    first = false;
    jeLines.push(
      g.accountId
        ? { accountId: g.accountId, debit: fromPaise(g.paise), description }
        : { systemKey: "sales", debit: fromPaise(g.paise), description },
    );
  }
  jeLines.push({ systemKey: "ar", credit: totals.total });
  if (toPaise(totals.cgst) > 0) jeLines.push({ systemKey: "cgst_payable", debit: totals.cgst } as never);
  if (toPaise(totals.sgst) > 0) jeLines.push({ systemKey: "sgst_payable", debit: totals.sgst } as never);
  if (toPaise(totals.igst) > 0) jeLines.push({ systemKey: "igst_payable", debit: totals.igst } as never);
  return jeLines;
}

/**
 * Editing re-states the credit note: the original journal is reversed and a fresh
 * one posted. Blocked once any of it has been applied against an invoice.
 */
salesDocumentsRouter.patch(
  "/credit-notes/:id",
  requirePermission("sales", "edit"),
  validateBody(creditNoteSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof creditNoteSchema>>;
    try {
      const result = await db.transaction(async (tx) => {
        const cn = await tx.query.creditNotes.findFirst({
          where: eq(creditNotes.id, req.params.id!),
        });
        if (!cn) throw new PostingError("Credit note not found");
        if (cn.status === "void") throw new PostingError("A void credit note cannot be edited");
        if (toPaise(cn.balance) !== toPaise(cn.total)) {
          throw new PostingError("This credit note is partly applied to an invoice — unapply it first");
        }

        const customer = await loadCustomer(tx, body.customerId ?? cn.customerId);
        const creditNoteDate = body.creditNoteDate ?? cn.creditNoteDate;

        let inputLines: DocLineInput[];
        if (body.lines) {
          inputLines = body.lines as DocLineInput[];
        } else {
          const existing = await tx
            .select()
            .from(creditNoteLines)
            .where(eq(creditNoteLines.creditNoteId, cn.id))
            .orderBy(asc(creditNoteLines.lineOrder));
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
          })) as DocLineInput[];
        }

        if (cn.journalEntryId) {
          await reverseJournal(tx, cn.journalEntryId, creditNoteDate, req.session.user!.id);
        }

        const totals = await computeDocumentTotals(tx, inputLines, customer.placeOfSupplyState);
        const { lines: rawLines, ...headerTotals } = totals;
        const computedLines = await applyDefaultSalesAccounts(tx, rawLines);

        await tx.delete(creditNoteLines).where(eq(creditNoteLines.creditNoteId, cn.id));
        await tx
          .insert(creditNoteLines)
          .values(computedLines.map((l) => ({ ...l, creditNoteId: cn.id })));

        const jeId = await postJournal(tx, {
          entryDate: creditNoteDate,
          narration: `Credit note ${cn.number} — ${customer.displayName}`,
          sourceType: "credit_note",
          sourceId: cn.id,
          postedBy: req.session.user!.id,
          lines: buildCreditNoteJeLines(totals, computedLines, cn.number),
        });

        const [updated] = await tx
          .update(creditNotes)
          .set({
            customerId: customer.id,
            creditNoteDate,
            reference: body.reference ?? cn.reference,
            customerNotes: body.customerNotes ?? cn.customerNotes,
            ...headerTotals,
            balance: headerTotals.total,
            journalEntryId: jeId,
          })
          .where(eq(creditNotes.id, cn.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/** Apply an open credit note's balance against the customer's open invoices. */
salesDocumentsRouter.post(
  "/credit-notes/:id/apply",
  requirePermission("sales", "edit"),
  validateBody(
    z.object({
      applications: z
        .array(z.object({ invoiceId: z.string().uuid(), amount: money }))
        .min(1)
        .max(100),
    }),
  ),
  async (req, res) => {
    const body = req.body as { applications: Array<{ invoiceId: string; amount: string }> };
    try {
      const result = await db.transaction(async (tx) => {
        const cn = await tx.query.creditNotes.findFirst({
          where: eq(creditNotes.id, req.params.id!),
        });
        if (!cn) throw new PostingError("Credit note not found");
        if (cn.status !== "open") throw new PostingError("Credit note is not open");

        let appliedP = 0;
        for (const app of body.applications) {
          const inv = await tx.query.invoices.findFirst({
            where: eq(invoices.id, app.invoiceId),
          });
          if (!inv) throw new PostingError(`Invoice not found: ${app.invoiceId}`);
          if (inv.customerId !== cn.customerId) {
            throw new PostingError(`Invoice ${inv.number} belongs to a different customer`);
          }
          if (inv.status !== "sent" && inv.status !== "partially_paid") {
            throw new PostingError(`Invoice ${inv.number} is not open`);
          }
          const appP = toPaise(app.amount);
          if (appP <= 0) throw new PostingError("Application amounts must be positive");
          if (appP > toPaise(inv.balanceDue)) {
            throw new PostingError(`Amount exceeds balance due on ${inv.number}`);
          }
          appliedP += appP;

          await tx.insert(creditNoteApplications).values({
            creditNoteId: cn.id,
            invoiceId: inv.id,
            amountApplied: app.amount,
          });
          const newBalanceP = toPaise(inv.balanceDue) - appP;
          await tx
            .update(invoices)
            .set({
              balanceDue: fromPaise(newBalanceP),
              status: newBalanceP === 0 ? "paid" : "partially_paid",
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, inv.id));
        }

        if (appliedP > toPaise(cn.balance)) {
          throw new PostingError("Applied total exceeds the credit note balance");
        }
        const newCnBalanceP = toPaise(cn.balance) - appliedP;
        const [updated] = await tx
          .update(creditNotes)
          .set({
            balance: fromPaise(newCnBalanceP),
            status: newCnBalanceP === 0 ? "closed" : "open",
          })
          .where(eq(creditNotes.id, cn.id))
          .returning();
        // No JE needed: both the credit's balance and the invoice live in AR;
        // application is an AR-internal reallocation already captured at issue.
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

salesDocumentsRouter.post(
  "/credit-notes/:id/void",
  requirePermission("sales", "delete"),
  validateBody(z.object({ voidDate: dateStr })),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const cn = await tx.query.creditNotes.findFirst({
          where: eq(creditNotes.id, req.params.id!),
        });
        if (!cn) throw new PostingError("Credit note not found");
        if (cn.status === "void") throw new PostingError("Credit note is already void");
        if (toPaise(cn.balance) !== toPaise(cn.total)) {
          throw new PostingError("Credit note has applications — cannot void");
        }
        if (cn.journalEntryId) {
          await reverseJournal(tx, cn.journalEntryId, req.body.voidDate, req.session.user!.id);
        }
        const [updated] = await tx
          .update(creditNotes)
          .set({ status: "void", balance: "0.00" })
          .where(eq(creditNotes.id, cn.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

// ---------- Re-post helpers (used by Bulk Update) ----------
//
// Reverse a document's posting and re-post it from whatever is currently stored,
// leaving every user-visible field alone. Bulk Update calls these after swapping
// the account on the lines so the ledger follows the new account.

export async function repostCreditNote(tx: Tx, id: string, userId: string): Promise<void> {
  const cn = await tx.query.creditNotes.findFirst({ where: eq(creditNotes.id, id) });
  if (!cn) throw new PostingError("Credit note not found");
  if (cn.status === "void") throw new PostingError(`Credit note ${cn.number} is void`);

  const [customer] = await tx
    .select({ displayName: contacts.displayName, placeOfSupplyState: contacts.placeOfSupplyState })
    .from(contacts)
    .where(eq(contacts.id, cn.customerId))
    .limit(1);

  const stored = await tx
    .select()
    .from(creditNoteLines)
    .where(eq(creditNoteLines.creditNoteId, id))
    .orderBy(asc(creditNoteLines.lineOrder));
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
  })) as DocLineInput[];

  if (cn.journalEntryId) await reverseJournal(tx, cn.journalEntryId, cn.creditNoteDate, userId);

  const totals = await computeDocumentTotals(tx, inputLines, customer?.placeOfSupplyState);
  const computedLines = await applyDefaultSalesAccounts(tx, totals.lines);
  const jeId = await postJournal(tx, {
    entryDate: cn.creditNoteDate,
    narration: `Credit note ${cn.number} — ${customer?.displayName ?? ""}`,
    sourceType: "credit_note",
    sourceId: id,
    postedBy: userId,
    lines: buildCreditNoteJeLines(totals, computedLines, cn.number),
  });
  await tx.update(creditNotes).set({ journalEntryId: jeId }).where(eq(creditNotes.id, id));
}
