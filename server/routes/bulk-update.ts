import { Router } from "express";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  billLines,
  bills,
  contacts,
  creditNoteLines,
  creditNotes,
  expenses,
  invoiceLines,
  invoices,
  purchaseOrderLines,
  purchaseOrders,
  vendorCreditLines,
  vendorCredits,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { PostingError, assertPeriodOpen } from "../services/posting";
import { repostBill, repostPurchaseOrder, repostVendorCredit, repostExpense } from "./purchases";
import { repostInvoice } from "./sales";
import { repostCreditNote } from "./sales-documents";

export const bulkUpdateRouter = Router();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^\d+(\.\d{1,2})?$/);

/** Zoho caps a single bulk update at 50 transactions. */
const MAX_SELECTION = 50;

export type BulkDocType =
  | "invoice"
  | "credit_note"
  | "purchase_order"
  | "expense"
  | "bill"
  | "vendor_credit";

/**
 * Everything the search and apply paths need to know about each document type,
 * kept in one table so adding a type is a single entry rather than six branches.
 * `expense` is the odd one out: its account lives on the header, not on lines.
 */
const DOC_TYPES = {
  invoice: {
    label: "Invoices",
    header: invoices, lines: invoiceLines, lineFk: invoiceLines.invoiceId,
    date: invoices.invoiceDate, contact: invoices.customerId, total: invoices.total,
    module: "sales" as const,
  },
  credit_note: {
    label: "Credit Notes",
    header: creditNotes, lines: creditNoteLines, lineFk: creditNoteLines.creditNoteId,
    date: creditNotes.creditNoteDate, contact: creditNotes.customerId, total: creditNotes.total,
    module: "sales" as const,
  },
  purchase_order: {
    label: "Purchase Orders",
    header: purchaseOrders, lines: purchaseOrderLines, lineFk: purchaseOrderLines.purchaseOrderId,
    date: purchaseOrders.orderDate, contact: purchaseOrders.vendorId, total: purchaseOrders.total,
    module: "purchases" as const,
  },
  bill: {
    label: "Bills",
    header: bills, lines: billLines, lineFk: billLines.billId,
    date: bills.billDate, contact: bills.vendorId, total: bills.total,
    module: "purchases" as const,
  },
  vendor_credit: {
    label: "Vendor Credits",
    header: vendorCredits, lines: vendorCreditLines, lineFk: vendorCreditLines.vendorCreditId,
    date: vendorCredits.creditDate, contact: vendorCredits.vendorId, total: vendorCredits.total,
    module: "purchases" as const,
  },
} as const;

const searchSchema = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  fromDate: dateStr.optional(),
  toDate: dateStr.optional(),
  minAmount: money.optional(),
  maxAmount: money.optional(),
});

type SearchFilters = z.infer<typeof searchSchema>;

/** Documents of one type whose lines hit the account, with the usual filters applied. */
async function searchLineDocs(type: keyof typeof DOC_TYPES, f: SearchFilters) {
  const d = DOC_TYPES[type];
  const conditions = [
    eq(d.lines.accountId, f.accountId),
    // A cancelled document has no live posting, so reassigning it would be meaningless.
    // Compared as text because each table's status enum has its own member list —
    // 'void' isn't even a valid value for purchase orders, which use 'cancelled'.
    sql`${d.header.status}::text NOT IN ('void', 'cancelled')`,
  ];
  if (f.contactId) conditions.push(eq(d.contact, f.contactId));
  if (f.fromDate) conditions.push(gte(d.date, f.fromDate));
  if (f.toDate) conditions.push(lte(d.date, f.toDate));
  if (f.minAmount) conditions.push(gte(d.total, f.minAmount));
  if (f.maxAmount) conditions.push(lte(d.total, f.maxAmount));

  const rows = await db
    .selectDistinct({
      id: d.header.id,
      number: d.header.number,
      date: d.date,
      total: d.total,
      status: d.header.status,
      contactName: contacts.displayName,
    })
    .from(d.header)
    .innerJoin(d.lines, eq(d.lineFk, d.header.id))
    .leftJoin(contacts, eq(contacts.id, d.contact))
    .where(and(...conditions))
    .orderBy(d.date)
    .limit(500);
  return rows.map((r) => ({ ...r, type }));
}

/** Expenses carry their account on the header rather than on lines. */
async function searchExpenses(f: SearchFilters) {
  // Expenses have no void state and carry their amount as `amount`, not `total`.
  const conditions = [eq(expenses.expenseAccountId, f.accountId)];
  if (f.contactId) conditions.push(eq(expenses.vendorId, f.contactId));
  if (f.fromDate) conditions.push(gte(expenses.expenseDate, f.fromDate));
  if (f.toDate) conditions.push(lte(expenses.expenseDate, f.toDate));
  if (f.minAmount) conditions.push(gte(expenses.amount, f.minAmount));
  if (f.maxAmount) conditions.push(lte(expenses.amount, f.maxAmount));

  const rows = await db
    .select({
      id: expenses.id,
      number: expenses.number,
      date: expenses.expenseDate,
      total: expenses.amount,
      status: sql<string>`'recorded'`,
      contactName: contacts.displayName,
    })
    .from(expenses)
    .leftJoin(contacts, eq(contacts.id, expenses.vendorId))
    .where(and(...conditions))
    .orderBy(expenses.expenseDate)
    .limit(500);
  return rows.map((r) => ({ ...r, type: "expense" as const }));
}

bulkUpdateRouter.post(
  "/search",
  requirePermission("accounting", "view"),
  validateBody(searchSchema),
  async (req, res) => {
    const f = req.body as SearchFilters;
    const [account] = await db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
      .from(accounts)
      .where(eq(accounts.id, f.accountId))
      .limit(1);
    if (!account) return res.status(404).json({ error: "Account not found" });

    const results = await Promise.all([
      ...(Object.keys(DOC_TYPES) as Array<keyof typeof DOC_TYPES>).map((t) => searchLineDocs(t, f)),
      searchExpenses(f),
    ]);

    const groups = [
      ...(Object.keys(DOC_TYPES) as Array<keyof typeof DOC_TYPES>).map((t, i) => ({
        type: t as BulkDocType,
        label: DOC_TYPES[t].label,
        rows: results[i]!,
      })),
      { type: "expense" as BulkDocType, label: "Expenses", rows: results[results.length - 1]! },
    ].filter((g) => g.rows.length > 0);

    res.json({
      account,
      maxSelection: MAX_SELECTION,
      total: groups.reduce((s, g) => s + g.rows.length, 0),
      groups,
    });
  },
);

const applySchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  documents: z
    .array(
      z.object({
        type: z.enum(["invoice", "credit_note", "purchase_order", "bill", "vendor_credit", "expense"]),
        id: z.string().uuid(),
      }),
    )
    .min(1)
    .max(MAX_SELECTION),
});

/** Re-post one document after its account has been swapped. */
async function repost(tx: Tx, type: BulkDocType, id: string, userId: string) {
  switch (type) {
    case "invoice": return repostInvoice(tx, id, userId);
    case "credit_note": return repostCreditNote(tx, id, userId);
    case "purchase_order": return repostPurchaseOrder(tx, id, userId);
    case "bill": return repostBill(tx, id, userId);
    case "vendor_credit": return repostVendorCredit(tx, id, userId);
    case "expense": return repostExpense(tx, id, userId);
  }
}

/**
 * Move every selected document's postings from one account to another.
 *
 * Runs as a single transaction: if any one document is in a locked period, or
 * fails to re-post, nothing at all changes. Locked documents are named in the
 * error rather than skipped silently — a partial bulk update the user thought
 * was complete is far worse than an outright refusal.
 */
bulkUpdateRouter.post(
  "/apply",
  requirePermission("accounting", "edit"),
  validateBody(applySchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof applySchema>;
    if (body.fromAccountId === body.toAccountId) {
      return res.status(422).json({ error: "Pick a different account to move these transactions to" });
    }
    try {
      const updated = await db.transaction(async (tx) => {
        const [target] = await tx
          .select({ id: accounts.id, name: accounts.name, isGroup: accounts.isGroup, isActive: accounts.isActive })
          .from(accounts)
          .where(eq(accounts.id, body.toAccountId))
          .limit(1);
        if (!target) throw new PostingError("Target account not found");
        if (!target.isActive) throw new PostingError(`"${target.name}" is inactive`);
        if (target.isGroup) {
          throw new PostingError(`"${target.name}" is a heading — pick one of its sub-accounts instead`);
        }

        // Check every document's period before touching anything.
        const blocked: string[] = [];
        for (const doc of body.documents) {
          const type = doc.type as BulkDocType;
          const d = type === "expense" ? null : DOC_TYPES[type as keyof typeof DOC_TYPES];
          const [row] = d
            ? await tx.select({ number: d.header.number, date: d.date }).from(d.header).where(eq(d.header.id, doc.id)).limit(1)
            : await tx.select({ number: expenses.number, date: expenses.expenseDate }).from(expenses).where(eq(expenses.id, doc.id)).limit(1);
          if (!row) throw new PostingError(`Document ${doc.id} not found`);
          // A purchase order never reaches the ledger, so a locked period doesn't apply to it.
          if (type === "purchase_order") continue;
          try {
            await assertPeriodOpen(tx, row.date, type);
          } catch {
            blocked.push(row.number);
          }
        }
        if (blocked.length > 0) {
          throw new PostingError(
            `${blocked.length} transaction(s) fall in a locked period and cannot be changed: ${blocked.join(", ")}. ` +
              `Unlock the period or deselect them, then try again.`,
          );
        }

        for (const doc of body.documents) {
          const type = doc.type as BulkDocType;
          if (type === "expense") {
            await tx
              .update(expenses)
              .set({ expenseAccountId: body.toAccountId })
              .where(and(eq(expenses.id, doc.id), eq(expenses.expenseAccountId, body.fromAccountId)));
          } else {
            const d = DOC_TYPES[type as keyof typeof DOC_TYPES];
            await tx
              .update(d.lines)
              .set({ accountId: body.toAccountId })
              .where(and(eq(d.lineFk, doc.id), eq(d.lines.accountId, body.fromAccountId)));
          }
          await repost(tx, type, doc.id, req.session.user!.id);
        }
        return body.documents.length;
      });
      res.json({ ok: true, updated });
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);
