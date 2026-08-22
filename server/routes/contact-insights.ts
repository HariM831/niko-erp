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

    /**
     * Both sides, always.
     *
     * A contact of type "both" is a customer AND a vendor — a shed owner buys
     * feed from Amino and sells eggs back — so answering with one figure would
     * describe half of them, and the half it picked would be an accident of
     * which branch ran first.
     */
    const [inv] = await db
      .select({ outstanding: sql<string>`COALESCE(SUM(${invoices.balanceDue}), 0)::numeric(14,2)` })
      .from(invoices)
      .where(
        and(eq(invoices.customerId, contact.id), inArray(invoices.status, ["sent", "partially_paid"])),
      );
    const [credits] = await db
      .select({ unused: sql<string>`COALESCE(SUM(${creditNotes.balance}), 0)::numeric(14,2)` })
      .from(creditNotes)
      .where(and(eq(creditNotes.customerId, contact.id), eq(creditNotes.status, "open")));
    const [advances] = await db
      .select({
        unapplied: sql<string>`COALESCE(SUM(${customerPayments.unappliedAmount}), 0)::numeric(14,2)`,
      })
      .from(customerPayments)
      .where(eq(customerPayments.customerId, contact.id));

    const [billAgg] = await db
      .select({ outstanding: sql<string>`COALESCE(SUM(${bills.balanceDue}), 0)::numeric(14,2)` })
      .from(bills)
      .where(and(eq(bills.vendorId, contact.id), inArray(bills.status, ["open", "partially_paid"])));
    const [vc] = await db
      .select({ unused: sql<string>`COALESCE(SUM(${vendorCredits.balance}), 0)::numeric(14,2)` })
      .from(vendorCredits)
      .where(and(eq(vendorCredits.vendorId, contact.id), eq(vendorCredits.status, "open")));

    const receivable = inv?.outstanding ?? "0.00";
    const receivableCredits = (
      Number(credits?.unused ?? 0) + Number(advances?.unapplied ?? 0)
    ).toFixed(2);
    const payable = billAgg?.outstanding ?? "0.00";
    const payableCredits = vc?.unused ?? "0.00";

    res.json({
      // `outstanding` keeps its old meaning, so the existing page is undisturbed.
      outstanding: contact.type === "customer" ? receivable : payable,
      unusedCredits: contact.type === "customer" ? receivableCredits : payableCredits,
      receivable,
      receivableCredits,
      payable,
      payableCredits,
      showBoth: contact.type === "both",
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

    // A contact that trades both ways gets both sets; the screen decides which
    // sections to show.
    const wantsSales = contact.type === "customer" || contact.type === "both";
    const wantsPurchases = contact.type === "vendor" || contact.type === "both";
    if (wantsSales && !wantsPurchases) {
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
    if (!wantsSales) {
      return res.json({ bills: billRows, payments: pay, vendorCredits: vc });
    }

    // Trades both ways: the sales side as well, under its own keys so the two
    // sets of payments do not collide.
    const [inv, custPay, cn] = await Promise.all([
      db.select().from(invoices).where(eq(invoices.customerId, contact.id)).orderBy(desc(invoices.invoiceDate)).limit(100),
      db.select().from(customerPayments).where(eq(customerPayments.customerId, contact.id)).orderBy(desc(customerPayments.paymentDate)).limit(100),
      db.select().from(creditNotes).where(eq(creditNotes.customerId, contact.id)).orderBy(desc(creditNotes.creditNoteDate)).limit(100),
    ]);
    res.json({
      invoices: inv,
      creditNotes: cn,
      customerPayments: custPay,
      bills: billRows,
      vendorPayments: pay,
      vendorCredits: vc,
      // Kept so a caller reading `payments` on a vendor still finds them.
      payments: pay,
    });
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

    /**
     * Both sides, always.
     *
     * An owner of a shed is a customer AND a vendor — Amino sells them feed and
     * buys their eggs — so one series cannot describe them. Both are computed
     * and the caller decides what to draw; a contact that only ever trades one
     * way simply has a flat zero for the other.
     */
    const monthly = async (q: ReturnType<typeof sql>) =>
      new Map(
        (await db.execute(q).then((r) => r.rows as Array<{ month: string; total: string }>)).map(
          (r) => [r.month, Number(r.total)],
        ),
      );

    // Debit: what they were invoiced, or what they actually paid.
    const debit = await monthly(
      basis === "accrual"
        ? sql`
            SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM-01') AS month,
                   SUM(sub_total - discount_total)::numeric(14,2) AS total
            FROM invoices
            WHERE customer_id = ${contact.id} AND status NOT IN ('draft', 'void') AND invoice_date >= ${startStr}
            GROUP BY 1`
        : sql`
            SELECT to_char(date_trunc('month', payment_date), 'YYYY-MM-01') AS month,
                   SUM(amount)::numeric(14,2) AS total
            FROM customer_payments
            WHERE customer_id = ${contact.id} AND payment_date >= ${startStr}
            GROUP BY 1`,
    );

    // Credit: what they billed Amino, or what Amino actually paid them.
    const credit = await monthly(
      basis === "accrual"
        ? sql`
            SELECT to_char(date_trunc('month', bill_date), 'YYYY-MM-01') AS month,
                   SUM(sub_total - discount_total)::numeric(14,2) AS total
            FROM bills
            WHERE vendor_id = ${contact.id} AND status NOT IN ('draft', 'void') AND bill_date >= ${startStr}
            GROUP BY 1`
        : sql`
            SELECT to_char(date_trunc('month', payment_date), 'YYYY-MM-01') AS month,
                   SUM(amount)::numeric(14,2) AS total
            FROM vendor_payments
            WHERE vendor_id = ${contact.id} AND payment_date >= ${startStr}
            GROUP BY 1`,
    );

    const periods: Array<{ month: string; total: number; debit: number; credit: number }> = [];
    const cursor = new Date(start);
    for (let i = 0; i < months; i++) {
      const key = cursor.toISOString().slice(0, 10).replace(/-\d\d$/, "-01");
      const d = debit.get(key) ?? 0;
      const c = credit.get(key) ?? 0;
      // `total` keeps its old meaning so the single-series chart is undisturbed.
      periods.push({ month: key, total: contact.type === "customer" ? d : c, debit: d, credit: c });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const sum = (pick: (p: (typeof periods)[number]) => number) =>
      periods.reduce((s, p) => s + pick(p), 0);

    res.json({
      basis,
      months,
      label:
        contact.type === "both" ? "Trade" : contact.type === "customer" ? "Income" : "Expense",
      /** Draw two bars rather than one when they trade in both directions. */
      showBoth: contact.type === "both",
      periods,
      total: sum((p) => p.total),
      debitTotal: sum((p) => p.debit),
      creditTotal: sum((p) => p.credit),
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

    /**
     * Everything, both directions, in one ledger.
     *
     * A statement of account is the whole relationship — what they were
     * invoiced, what they billed, and every payment either way. Branching on
     * customer-or-vendor showed a contact that trades both ways only half of
     * its own account, which is exactly the half that makes the balance
     * inexplicable.
     *
     * Signed from AMINO's side: a debit increases what the contact owes Amino,
     * a credit increases what Amino owes them. So an invoice and a payment made
     * both debit; a bill and a payment received both credit.
     */
    const rows: StatementRow[] = [];
    const sales = contact.type === "customer" || contact.type === "both";
    const purchases = contact.type === "vendor" || contact.type === "both";

    if (sales) {
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
    }

    if (purchases) {
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
