import { Router } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  bills,
  contacts,
  creditNotes,
  customerPayments,
  invoices,
  vendorCredits,
  vendorPayments,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";

export const contactInsightsRouter = Router();

async function loadContact(id: string) {
  return db.query.contacts.findFirst({ where: eq(contacts.id, id) });
}

/** Outstanding + unused credits, Zoho's Receivables/Payables card. */
contactInsightsRouter.get(
  "/:id/summary",
  requirePermission("sales", "view"),
  async (req, res) => {
    const contact = await loadContact(req.params.id!);
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    if (contact.type === "customer") {
      const [inv] = await db
        .select({
          outstanding: sql<string>`COALESCE(SUM(${invoices.balanceDue}), 0)::numeric(14,2)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.customerId, contact.id),
            inArray(invoices.status, ["sent", "partially_paid"]),
          ),
        );
      const [credits] = await db
        .select({
          unused: sql<string>`COALESCE(SUM(${creditNotes.balance}), 0)::numeric(14,2)`,
        })
        .from(creditNotes)
        .where(and(eq(creditNotes.customerId, contact.id), eq(creditNotes.status, "open")));
      const [advances] = await db
        .select({
          unapplied: sql<string>`COALESCE(SUM(${customerPayments.unappliedAmount}), 0)::numeric(14,2)`,
        })
        .from(customerPayments)
        .where(eq(customerPayments.customerId, contact.id));
      return res.json({
        outstanding: inv?.outstanding ?? "0.00",
        unusedCredits: (
          Number(credits?.unused ?? 0) + Number(advances?.unapplied ?? 0)
        ).toFixed(2),
      });
    }

    const [billAgg] = await db
      .select({
        outstanding: sql<string>`COALESCE(SUM(${bills.balanceDue}), 0)::numeric(14,2)`,
      })
      .from(bills)
      .where(and(eq(bills.vendorId, contact.id), inArray(bills.status, ["open", "partially_paid"])));
    const [vc] = await db
      .select({
        unused: sql<string>`COALESCE(SUM(${vendorCredits.balance}), 0)::numeric(14,2)`,
      })
      .from(vendorCredits)
      .where(and(eq(vendorCredits.vendorId, contact.id), eq(vendorCredits.status, "open")));
    res.json({
      outstanding: billAgg?.outstanding ?? "0.00",
      unusedCredits: vc?.unused ?? "0.00",
    });
  },
);

/** All transactions for the Transactions tab, grouped by type. */
contactInsightsRouter.get(
  "/:id/transactions",
  requirePermission("sales", "view"),
  async (req, res) => {
    const contact = await loadContact(req.params.id!);
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    if (contact.type === "customer") {
      const [inv, pay, cn] = await Promise.all([
        db.select().from(invoices).where(eq(invoices.customerId, contact.id)).orderBy(desc(invoices.invoiceDate)).limit(100),
        db.select().from(customerPayments).where(eq(customerPayments.customerId, contact.id)).orderBy(desc(customerPayments.paymentDate)).limit(100),
        db.select().from(creditNotes).where(eq(creditNotes.customerId, contact.id)).orderBy(desc(creditNotes.creditNoteDate)).limit(100),
      ]);
      return res.json({ invoices: inv, payments: pay, creditNotes: cn });
    }

    const [billRows, pay, vc] = await Promise.all([
      db.select().from(bills).where(eq(bills.vendorId, contact.id)).orderBy(desc(bills.billDate)).limit(100),
      db.select().from(vendorPayments).where(eq(vendorPayments.vendorId, contact.id)).orderBy(desc(vendorPayments.paymentDate)).limit(100),
      db.select().from(vendorCredits).where(eq(vendorCredits.vendorId, contact.id)).orderBy(desc(vendorCredits.creditDate)).limit(100),
    ]);
    res.json({ bills: billRows, payments: pay, vendorCredits: vc });
  },
);

/** Monthly Income (customers) / Expense (vendors) bar-chart data, accrual or cash basis. */
contactInsightsRouter.get(
  "/:id/income-chart",
  requirePermission("sales", "view"),
  async (req, res) => {
    const contact = await loadContact(req.params.id!);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
    const basis = req.query.basis === "cash" ? "cash" : "accrual";

    const start = new Date();
    start.setDate(1);
    start.setMonth(start.getMonth() - (months - 1));
    const startStr = start.toISOString().slice(0, 10);

    let rows: Array<{ month: string; total: string }>;
    if (contact.type === "customer") {
      rows =
        basis === "accrual"
          ? await db.execute(sql`
              SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM-01') AS month,
                     SUM(sub_total - discount_total)::numeric(14,2) AS total
              FROM invoices
              WHERE customer_id = ${contact.id} AND status NOT IN ('draft', 'void') AND invoice_date >= ${startStr}
              GROUP BY 1
            `).then((r) => r.rows as Array<{ month: string; total: string }>)
          : await db.execute(sql`
              SELECT to_char(date_trunc('month', payment_date), 'YYYY-MM-01') AS month,
                     SUM(amount)::numeric(14,2) AS total
              FROM customer_payments
              WHERE customer_id = ${contact.id} AND payment_date >= ${startStr}
              GROUP BY 1
            `).then((r) => r.rows as Array<{ month: string; total: string }>);
    } else {
      rows =
        basis === "accrual"
          ? await db.execute(sql`
              SELECT to_char(date_trunc('month', bill_date), 'YYYY-MM-01') AS month,
                     SUM(sub_total - discount_total)::numeric(14,2) AS total
              FROM bills
              WHERE vendor_id = ${contact.id} AND status NOT IN ('draft', 'void') AND bill_date >= ${startStr}
              GROUP BY 1
            `).then((r) => r.rows as Array<{ month: string; total: string }>)
          : await db.execute(sql`
              SELECT to_char(date_trunc('month', payment_date), 'YYYY-MM-01') AS month,
                     SUM(amount)::numeric(14,2) AS total
              FROM vendor_payments
              WHERE vendor_id = ${contact.id} AND payment_date >= ${startStr}
              GROUP BY 1
            `).then((r) => r.rows as Array<{ month: string; total: string }>);
    }
    const byMonth = new Map(rows.map((r) => [r.month, Number(r.total)]));

    const periods: Array<{ month: string; total: number }> = [];
    const cursor = new Date(start);
    for (let i = 0; i < months; i++) {
      const key = cursor.toISOString().slice(0, 10).replace(/-\d\d$/, "-01");
      periods.push({ month: key, total: byMonth.get(key) ?? 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    res.json({
      basis,
      months,
      label: contact.type === "customer" ? "Income" : "Expense",
      periods,
      total: periods.reduce((s, p) => s + p.total, 0),
    });
  },
);

interface StatementRow {
  id: string;
  date: string;
  type: string;
  number: string;
  debit: number;
  credit: number;
}

/** Statement of account: chronological documents with a running balance. */
contactInsightsRouter.get(
  "/:id/statement",
  requirePermission("sales", "view"),
  async (req, res) => {
    const contact = await loadContact(req.params.id!);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const { from, to } = req.query as Record<string, string | undefined>;

    const rows: StatementRow[] = [];
    if (contact.type === "customer") {
      const inv = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.customerId, contact.id), inArray(invoices.status, ["sent", "partially_paid", "paid"])))
        .orderBy(asc(invoices.invoiceDate));
      for (const r of inv) rows.push({ id: r.id, date: r.invoiceDate, type: "Invoice", number: r.number, debit: Number(r.total), credit: 0 });
      const pay = await db.select().from(customerPayments).where(eq(customerPayments.customerId, contact.id));
      for (const r of pay) rows.push({ id: r.id, date: r.paymentDate, type: "Payment Received", number: r.number, debit: 0, credit: Number(r.amount) });
      const cn = await db
        .select()
        .from(creditNotes)
        .where(and(eq(creditNotes.customerId, contact.id), inArray(creditNotes.status, ["open", "closed"])))
        .orderBy(asc(creditNotes.creditNoteDate));
      for (const r of cn) rows.push({ id: r.id, date: r.creditNoteDate, type: "Credit Note", number: r.number, debit: 0, credit: Number(r.total) });
    } else {
      const billRows = await db
        .select()
        .from(bills)
        .where(and(eq(bills.vendorId, contact.id), inArray(bills.status, ["open", "partially_paid", "paid"])))
        .orderBy(asc(bills.billDate));
      for (const r of billRows) rows.push({ id: r.id, date: r.billDate, type: "Bill", number: r.number, credit: Number(r.total), debit: 0 });
      const pay = await db.select().from(vendorPayments).where(eq(vendorPayments.vendorId, contact.id));
      for (const r of pay) rows.push({ id: r.id, date: r.paymentDate, type: "Payment Made", number: r.number, credit: 0, debit: Number(r.amount) });
      const vc = await db
        .select()
        .from(vendorCredits)
        .where(and(eq(vendorCredits.vendorId, contact.id), inArray(vendorCredits.status, ["open", "closed"])))
        .orderBy(asc(vendorCredits.creditDate));
      for (const r of vc) rows.push({ id: r.id, date: r.creditDate, type: "Vendor Credit", number: r.number, credit: 0, debit: Number(r.total) });
    }

    rows.sort((a, b) => a.date.localeCompare(b.date));

    // Opening balance = net of rows before `from`; window rows keep running total.
    let opening = Number(contact.openingBalance ?? 0);
    const windowed: Array<StatementRow & { balance: string }> = [];
    let running = opening;
    for (const r of rows) {
      const inWindow = (!from || r.date >= from) && (!to || r.date <= to);
      if (!inWindow && (!from || r.date < from)) {
        opening += r.debit - r.credit;
        running = opening;
        continue;
      }
      if (!inWindow) continue;
      running += r.debit - r.credit;
      windowed.push({ ...r, balance: running.toFixed(2) });
    }

    res.json({
      contact: { id: contact.id, displayName: contact.displayName, type: contact.type },
      from: from ?? null,
      to: to ?? null,
      openingBalance: opening.toFixed(2),
      rows: windowed,
      closingBalance: running.toFixed(2),
    });
  },
);
