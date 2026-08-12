import { Router } from "express";
import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import {
  accounts,
  bills,
  contacts,
  expenses,
  invoices,
  journalEntries,
  journalEntryLineTags,
  journalEntryLines,
  reportingTagOptions,
  reportingTags,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";

export const reportsRouter = Router();

/**
 * Per-account net movement (debit - credit) over a posted-JE date window.
 *
 * `tagOptionId` narrows it to lines charged to one reporting tag option, which
 * is how a per-vehicle or per-shed P&L is produced without a GL account each.
 */
async function accountMovements(from?: string, to?: string, tagOptionId?: string) {
  const conditions = [eq(journalEntries.status, "posted")];
  if (from) conditions.push(gte(journalEntries.entryDate, from));
  if (to) conditions.push(lte(journalEntries.entryDate, to));

  const base = db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      parentId: accounts.parentId,
      net: sql<string>`COALESCE(SUM(${journalEntryLines.debit} - ${journalEntryLines.credit}), 0)::numeric(14,2)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, and(eq(journalEntries.id, journalEntryLines.entryId), ...conditions))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId));

  const scoped = tagOptionId
    ? base.innerJoin(
        journalEntryLineTags,
        and(
          eq(journalEntryLineTags.lineId, journalEntryLines.id),
          eq(journalEntryLineTags.optionId, tagOptionId),
        ),
      )
    : base;

  return scoped
    .groupBy(accounts.id, accounts.code, accounts.name, accounts.type, accounts.parentId)
    .orderBy(asc(accounts.code));
}

// ---------- Profit & Loss ----------

reportsRouter.get("/pnl", requirePermission("reports", "view"), async (req, res) => {
  const { from, to, tagOptionId } = req.query as Record<string, string | undefined>;
  const rows = await accountMovements(from, to, tagOptionId);

  // Income accounts carry credit balances: display as -net.
  const income = rows
    .filter((r) => r.type === "income")
    .map((r) => ({ code: r.code, name: r.name, amount: (-Number(r.net)).toFixed(2) }));
  const expenseRows = rows
    .filter((r) => r.type === "expense")
    .map((r) => ({ code: r.code, name: r.name, amount: Number(r.net).toFixed(2) }));

  const totalIncome = income.reduce((s, r) => s + Number(r.amount), 0);
  const totalExpenses = expenseRows.reduce((s, r) => s + Number(r.amount), 0);

  res.json({
    from: from ?? null,
    to: to ?? null,
    tagOptionId: tagOptionId ?? null,
    income,
    expenses: expenseRows,
    totalIncome: totalIncome.toFixed(2),
    totalExpenses: totalExpenses.toFixed(2),
    netProfit: (totalIncome - totalExpenses).toFixed(2),
  });
});

// ---------- Reporting tag summary ----------

/**
 * Income and expense per tag option — the readable form of tagging. Amounts
 * follow the P&L sign convention: income positive, expense positive, so the
 * two can be subtracted for a per-option margin.
 */
reportsRouter.get("/tag-summary", requirePermission("reports", "view"), async (req, res) => {
  const { from, to, tagId } = req.query as Record<string, string | undefined>;
  const conditions = [eq(journalEntries.status, "posted")];
  if (from) conditions.push(gte(journalEntries.entryDate, from));
  if (to) conditions.push(lte(journalEntries.entryDate, to));
  if (tagId) conditions.push(eq(journalEntryLineTags.tagId, tagId));

  const rows = await db
    .select({
      tagId: reportingTags.id,
      tagName: reportingTags.name,
      optionId: reportingTagOptions.id,
      optionName: reportingTagOptions.name,
      income: sql<string>`COALESCE(SUM(CASE WHEN ${accounts.type} = 'income' THEN ${journalEntryLines.credit} - ${journalEntryLines.debit} ELSE 0 END), 0)::numeric(14,2)`,
      expense: sql<string>`COALESCE(SUM(CASE WHEN ${accounts.type} = 'expense' THEN ${journalEntryLines.debit} - ${journalEntryLines.credit} ELSE 0 END), 0)::numeric(14,2)`,
      lineCount: sql<number>`count(*)::int`,
    })
    .from(journalEntryLineTags)
    .innerJoin(journalEntryLines, eq(journalEntryLines.id, journalEntryLineTags.lineId))
    .innerJoin(journalEntries, and(eq(journalEntries.id, journalEntryLines.entryId), ...conditions))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .innerJoin(reportingTagOptions, eq(reportingTagOptions.id, journalEntryLineTags.optionId))
    .innerJoin(reportingTags, eq(reportingTags.id, journalEntryLineTags.tagId))
    .groupBy(reportingTags.id, reportingTags.name, reportingTagOptions.id, reportingTagOptions.name)
    .orderBy(asc(reportingTags.name), asc(reportingTagOptions.name));

  res.json({
    from: from ?? null,
    to: to ?? null,
    rows: rows.map((r) => ({
      ...r,
      net: (Number(r.income) - Number(r.expense)).toFixed(2),
    })),
  });
});

// ---------- Balance Sheet ----------

reportsRouter.get("/balance-sheet", requirePermission("reports", "view"), async (req, res) => {
  const { asOf } = req.query as Record<string, string | undefined>;
  const rows = await accountMovements(undefined, asOf);

  const section = (type: string, sign: 1 | -1) =>
    rows
      .filter((r) => r.type === type && Number(r.net) !== 0)
      .map((r) => ({ code: r.code, name: r.name, amount: (sign * Number(r.net)).toFixed(2) }));

  const assets = section("asset", 1);
  const liabilities = section("liability", -1);
  const equity = section("equity", -1);

  // Current-period earnings fold into equity so the sheet balances.
  const income = rows.filter((r) => r.type === "income").reduce((s, r) => s - Number(r.net), 0);
  const expense = rows.filter((r) => r.type === "expense").reduce((s, r) => s + Number(r.net), 0);
  const netEarnings = income - expense;

  const totalAssets = assets.reduce((s, r) => s + Number(r.amount), 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + Number(r.amount), 0);
  const totalEquity = equity.reduce((s, r) => s + Number(r.amount), 0) + netEarnings;

  res.json({
    asOf: asOf ?? null,
    assets,
    liabilities,
    equity: [
      ...equity,
      { code: "—", name: "Current Period Earnings", amount: netEarnings.toFixed(2) },
    ],
    totalAssets: totalAssets.toFixed(2),
    totalLiabilities: totalLiabilities.toFixed(2),
    totalEquity: totalEquity.toFixed(2),
    balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.01,
  });
});

// ---------- Cash Flow (direct method summary) ----------

reportsRouter.get("/cash-flow", requirePermission("reports", "view"), async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;

  // Cash accounts = GL accounts referenced by bank_accounts + petty cash keys.
  const cashAccounts = await db.execute(sql`
    SELECT DISTINCT a.id FROM accounts a
    LEFT JOIN bank_accounts b ON b.gl_account_id = a.id
    WHERE b.id IS NOT NULL OR a.system_key IN ('cash_bank', 'petty_cash')
  `);
  const cashIds = cashAccounts.rows.map((r) => (r as { id: string }).id);
  if (cashIds.length === 0) {
    return res.json({ opening: "0.00", inflows: [], outflows: [], closing: "0.00" });
  }

  const openingConditions = [
    eq(journalEntries.status, "posted"),
    inArray(journalEntryLines.accountId, cashIds),
  ];
  if (from) openingConditions.push(lt(journalEntries.entryDate, from));

  const [openingRow] = await db
    .select({
      net: sql<string>`COALESCE(SUM(${journalEntryLines.debit} - ${journalEntryLines.credit}), 0)::numeric(14,2)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
    .where(and(...openingConditions));
  const opening = from ? Number(openingRow?.net ?? 0) : 0;

  // Movements in-window grouped by counter-account (the non-cash lines of
  // entries that touch cash), signed from the cash perspective.
  const windowConditions = [eq(journalEntries.status, "posted")];
  if (from) windowConditions.push(gte(journalEntries.entryDate, from));
  if (to) windowConditions.push(lte(journalEntries.entryDate, to));

  const movements = await db.execute(sql`
    WITH cash_entries AS (
      SELECT DISTINCT jel.entry_id,
        SUM(jel.debit - jel.credit) AS cash_delta
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      WHERE jel.account_id IN (${sql.join(cashIds.map((id) => sql`${id}`), sql`, `)})
        AND je.status = 'posted'
        ${from ? sql`AND je.entry_date >= ${from}` : sql``}
        ${to ? sql`AND je.entry_date <= ${to}` : sql``}
      GROUP BY jel.entry_id
    )
    SELECT a.code, a.name, a.type,
      SUM(CASE WHEN ce.cash_delta >= 0 THEN LEAST(jel.credit - jel.debit, ce.cash_delta) ELSE 0 END) AS inflow,
      SUM(CASE WHEN ce.cash_delta < 0 THEN LEAST(jel.debit - jel.credit, -ce.cash_delta) ELSE 0 END) AS outflow
    FROM cash_entries ce
    JOIN journal_entry_lines jel ON jel.entry_id = ce.entry_id
    JOIN accounts a ON a.id = jel.account_id
    WHERE jel.account_id NOT IN (${sql.join(cashIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY a.code, a.name, a.type
    ORDER BY a.code
  `);

  const rows = movements.rows as Array<{ code: string; name: string; type: string; inflow: string; outflow: string }>;
  const inflows = rows
    .filter((r) => Number(r.inflow) > 0)
    .map((r) => ({ code: r.code, name: r.name, amount: Number(r.inflow).toFixed(2) }));
  const outflows = rows
    .filter((r) => Number(r.outflow) > 0)
    .map((r) => ({ code: r.code, name: r.name, amount: Number(r.outflow).toFixed(2) }));
  const totalIn = inflows.reduce((s, r) => s + Number(r.amount), 0);
  const totalOut = outflows.reduce((s, r) => s + Number(r.amount), 0);

  res.json({
    from: from ?? null,
    to: to ?? null,
    opening: opening.toFixed(2),
    inflows,
    outflows,
    totalInflows: totalIn.toFixed(2),
    totalOutflows: totalOut.toFixed(2),
    netChange: (totalIn - totalOut).toFixed(2),
    closing: (opening + totalIn - totalOut).toFixed(2),
  });
});

// ---------- AR / AP Aging (Zoho buckets) ----------

function bucketFor(daysOverdue: number): string {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 15) return "1-15";
  if (daysOverdue <= 30) return "16-30";
  if (daysOverdue <= 45) return "31-45";
  return "45+";
}

reportsRouter.get("/ar-aging", requirePermission("reports", "view"), async (req, res) => {
  const asOf = (req.query.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const open = await db
    .select({
      invoiceId: invoices.id,
      number: invoices.number,
      customerId: invoices.customerId,
      customerName: contacts.displayName,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      balanceDue: invoices.balanceDue,
    })
    .from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.customerId))
    .where(
      and(
        inArray(invoices.status, ["sent", "partially_paid"]),
        lte(invoices.invoiceDate, asOf),
      ),
    )
    .orderBy(asc(contacts.displayName), asc(invoices.dueDate));

  const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
  const detailed = open.map((r) => {
    const daysOverdue = Math.floor((asOfMs - new Date(`${r.dueDate}T00:00:00Z`).getTime()) / 86_400_000);
    return { ...r, daysOverdue, bucket: bucketFor(daysOverdue) };
  });
  const buckets: Record<string, number> = { current: 0, "1-15": 0, "16-30": 0, "31-45": 0, "45+": 0 };
  for (const r of detailed) buckets[r.bucket] = (buckets[r.bucket] ?? 0) + Number(r.balanceDue);

  res.json({
    asOf,
    invoices: detailed,
    totals: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toFixed(2)])),
    grandTotal: detailed.reduce((s, r) => s + Number(r.balanceDue), 0).toFixed(2),
  });
});

reportsRouter.get("/ap-aging", requirePermission("reports", "view"), async (req, res) => {
  const asOf = (req.query.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const open = await db
    .select({
      billId: bills.id,
      number: bills.number,
      vendorId: bills.vendorId,
      vendorName: contacts.displayName,
      billDate: bills.billDate,
      dueDate: bills.dueDate,
      balanceDue: bills.balanceDue,
    })
    .from(bills)
    .innerJoin(contacts, eq(contacts.id, bills.vendorId))
    .where(and(inArray(bills.status, ["open", "partially_paid"]), lte(bills.billDate, asOf)))
    .orderBy(asc(contacts.displayName), asc(bills.dueDate));

  const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
  const detailed = open.map((r) => {
    const daysOverdue = Math.floor((asOfMs - new Date(`${r.dueDate}T00:00:00Z`).getTime()) / 86_400_000);
    return { ...r, daysOverdue, bucket: bucketFor(daysOverdue) };
  });
  const buckets: Record<string, number> = { current: 0, "1-15": 0, "16-30": 0, "31-45": 0, "45+": 0 };
  for (const r of detailed) buckets[r.bucket] = (buckets[r.bucket] ?? 0) + Number(r.balanceDue);

  res.json({
    asOf,
    bills: detailed,
    totals: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toFixed(2)])),
    grandTotal: detailed.reduce((s, r) => s + Number(r.balanceDue), 0).toFixed(2),
  });
});

// ---------- GST summary (GSTR-3B style) ----------

reportsRouter.get("/gst-summary", requirePermission("reports", "view"), async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });

  const [output] = await db
    .select({
      taxable: sql<string>`COALESCE(SUM(${invoices.subTotal} - ${invoices.discountTotal}), 0)::numeric(14,2)`,
      cgst: sql<string>`COALESCE(SUM(${invoices.cgst}), 0)::numeric(14,2)`,
      sgst: sql<string>`COALESCE(SUM(${invoices.sgst}), 0)::numeric(14,2)`,
      igst: sql<string>`COALESCE(SUM(${invoices.igst}), 0)::numeric(14,2)`,
    })
    .from(invoices)
    .where(
      and(
        inArray(invoices.status, ["sent", "partially_paid", "paid"]),
        gte(invoices.invoiceDate, from),
        lte(invoices.invoiceDate, to),
      ),
    );

  const [inputBills] = await db
    .select({
      taxable: sql<string>`COALESCE(SUM(${bills.subTotal} - ${bills.discountTotal}), 0)::numeric(14,2)`,
      cgst: sql<string>`COALESCE(SUM(${bills.cgst}), 0)::numeric(14,2)`,
      sgst: sql<string>`COALESCE(SUM(${bills.sgst}), 0)::numeric(14,2)`,
      igst: sql<string>`COALESCE(SUM(${bills.igst}), 0)::numeric(14,2)`,
    })
    .from(bills)
    .where(
      and(
        inArray(bills.status, ["open", "partially_paid", "paid"]),
        gte(bills.billDate, from),
        lte(bills.billDate, to),
      ),
    );

  const [inputExpenses] = await db
    .select({
      tax: sql<string>`COALESCE(SUM(${expenses.taxAmount}), 0)::numeric(14,2)`,
    })
    .from(expenses)
    .where(and(gte(expenses.expenseDate, from), lte(expenses.expenseDate, to)));

  const outCgst = Number(output?.cgst ?? 0);
  const outSgst = Number(output?.sgst ?? 0);
  const outIgst = Number(output?.igst ?? 0);
  const inCgst = Number(inputBills?.cgst ?? 0);
  const inSgst = Number(inputBills?.sgst ?? 0);
  const inIgst = Number(inputBills?.igst ?? 0);
  const inExpense = Number(inputExpenses?.tax ?? 0);

  res.json({
    from,
    to,
    outwardSupplies: {
      taxableValue: output?.taxable ?? "0.00",
      cgst: outCgst.toFixed(2),
      sgst: outSgst.toFixed(2),
      igst: outIgst.toFixed(2),
    },
    inputTaxCredit: {
      taxableValue: inputBills?.taxable ?? "0.00",
      cgst: inCgst.toFixed(2),
      sgst: inSgst.toFixed(2),
      igst: inIgst.toFixed(2),
      expensesTax: inExpense.toFixed(2),
    },
    netPayable: (outCgst + outSgst + outIgst - inCgst - inSgst - inIgst - inExpense).toFixed(2),
  });
});
