import { Router } from "express";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  accounts,
  bills,
  breeds,
  contacts,
  flockPlacements,
  flocks,
  houses,
  locations,
  expenses,
  invoices,
  journalEntries,
  journalEntryLineTags,
  journalEntryLines,
  billLines,
  creditNoteLines,
  creditNotes,
  invoiceLines,
  items,
  vendorCreditLines,
  vendorCredits,
  reportingTagOptions,
  reportingTags,
} from "@shared/schema";
import { db } from "../db";
import { buildTree, pruneEmpty } from "../services/report-tree";
import { requirePermission } from "../lib/rbac";
import { weeklySummary } from "../services/rollup";

export const reportsRouter = Router();

/**
 * Per-account net movement (debit - credit) over a posted-JE date window.
 *
 * `tagOptionId` narrows it to lines charged to one reporting tag option, which
 * is how a per-vehicle or per-shed P&L is produced without a GL account each.
 */
async function accountMovements(from?: string, to?: string, tagOptionId?: string) {
  const windowConditions = [eq(journalEntries.status, "posted")];
  if (from) windowConditions.push(gte(journalEntries.entryDate, from));
  if (to) windowConditions.push(lte(journalEntries.entryDate, to));

  // A line counts only when its entry fell in the window, and — when the report
  // is scoped to a tag — only when it actually carries that tag. Both are guards
  // inside the sum rather than WHERE clauses, because the query starts from
  // accounts and a WHERE would throw away the ones with no matching lines.
  const counts = tagOptionId
    ? sql`${journalEntries.id} IS NOT NULL AND ${journalEntryLineTags.id} IS NOT NULL`
    : sql`${journalEntries.id} IS NOT NULL`;

  // Starts from accounts, not from lines: a parent account is a heading and
  // never carries a posting, so joining the other way round dropped every
  // group and left its children looking like unrelated top-level rows.
  const base = db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      systemKey: accounts.systemKey,
      parentId: accounts.parentId,
      isGroup: accounts.isGroup,
      net: sql<string>`COALESCE(SUM(
        CASE WHEN ${counts} THEN ${journalEntryLines.debit} - ${journalEntryLines.credit}
        ELSE 0 END
      ), 0)::numeric(14,2)`,
    })
    .from(accounts)
    .leftJoin(journalEntryLines, eq(journalEntryLines.accountId, accounts.id))
    .leftJoin(
      journalEntries,
      and(eq(journalEntries.id, journalEntryLines.entryId), ...windowConditions),
    );

  const scoped = tagOptionId
    ? base.leftJoin(
        journalEntryLineTags,
        and(
          eq(journalEntryLineTags.lineId, journalEntryLines.id),
          eq(journalEntryLineTags.optionId, tagOptionId),
        ),
      )
    : base;

  const [rows, itemised] = await Promise.all([
    scoped
      .groupBy(
        accounts.id,
        accounts.code,
        accounts.name,
        accounts.type,
        accounts.subtype,
        accounts.parentId,
        accounts.isGroup,
      )
      .orderBy(asc(accounts.code)),
    accountsWithItemLines(from, to),
  ]);

  return rows.map((r) => ({ ...r, hasItemLines: itemised.has(r.accountId) }));
}

/**
 * Accounts that have at least one document line naming an item, in the window.
 *
 * This is what decides where a statement line drills to. Most operating costs
 * never reach an item — electricity is an expense claim, depreciation is a
 * journal — so sending every expense account to an item report gave an empty
 * page for nine accounts out of thirteen. An account is only worth opening as
 * items when items are actually behind it; otherwise the ledger is the answer.
 *
 * The account is resolved exactly as posting resolves it, so membership here
 * matches what the item report will actually find.
 */
async function accountsWithItemLines(from?: string, to?: string): Promise<Set<string>> {
  const window = (dateCol: string) => sql`
    ${from ? sql`AND ${sql.raw(dateCol)} >= ${from}` : sql``}
    ${to ? sql`AND ${sql.raw(dateCol)} <= ${to}` : sql``}`;

  const rows = await db.execute(sql`
    SELECT DISTINCT account_id FROM (
      SELECT COALESCE(l.account_id, it.sales_account_id,
                      (SELECT id FROM accounts WHERE system_key = 'sales')) AS account_id
        FROM invoice_lines l
        JOIN invoices d ON d.id = l.invoice_id AND d.status NOT IN ('draft','void')
             ${window("d.invoice_date")}
        JOIN items it ON it.id = l.item_id
      UNION ALL
      SELECT COALESCE(l.account_id, it.sales_account_id,
                      (SELECT id FROM accounts WHERE system_key = 'sales'))
        FROM credit_note_lines l
        JOIN credit_notes d ON d.id = l.credit_note_id AND d.status NOT IN ('draft','void')
             ${window("d.credit_note_date")}
        JOIN items it ON it.id = l.item_id
      UNION ALL
      SELECT COALESCE(l.account_id, it.purchase_account_id)
        FROM bill_lines l
        JOIN bills d ON d.id = l.bill_id AND d.status NOT IN ('draft','void')
             ${window("d.bill_date")}
        JOIN items it ON it.id = l.item_id
      UNION ALL
      SELECT COALESCE(l.account_id, it.purchase_account_id)
        FROM vendor_credit_lines l
        JOIN vendor_credits d ON d.id = l.vendor_credit_id AND d.status NOT IN ('draft','void')
             ${window("d.credit_date")}
        JOIN items it ON it.id = l.item_id
    ) x WHERE account_id IS NOT NULL
  `);
  return new Set(rows.rows.map((r) => (r as { account_id: string }).account_id));
}

// ---------- Profit & Loss ----------

type Movement = Awaited<ReturnType<typeof accountMovements>>[number];

/**
 * Rows for one P&L section, as a tree.
 *
 * Income sits credit-side, so its sign is flipped to read positive; expenses
 * are already debit-positive. Subtypes decide the section: EGGSY has stored
 * cost_of_goods_sold, other_income and other_expense since the chart was
 * seeded, and the old flat report simply ignored them.
 */
function section(rows: Movement[], match: (r: Movement) => boolean, sign: 1 | -1) {
  const picked = rows.filter(match).map((r) => ({
    accountId: r.accountId,
    code: r.code,
    name: r.name,
    type: r.type,
    subtype: r.subtype,
    parentId: r.parentId,
    isGroup: r.isGroup,
    hasItemLines: r.hasItemLines,
    net: sign * Number(r.net),
  }));
  const { nodes, total } = buildTree(picked);
  return { nodes: pruneEmpty(nodes), total };
}

reportsRouter.get("/pnl", requirePermission("reports", "view"), async (req, res) => {
  const { from, to, tagOptionId } = req.query as Record<string, string | undefined>;
  const rows = await accountMovements(from, to, tagOptionId);

  const operatingIncome = section(rows, (r) => r.type === "income" && r.subtype !== "other_income", -1);
  const cogs = section(rows, (r) => r.subtype === "cost_of_goods_sold", 1);
  const operatingExpense = section(
    rows,
    (r) => r.type === "expense" && r.subtype !== "cost_of_goods_sold" && r.subtype !== "other_expense",
    1,
  );
  const otherIncome = section(rows, (r) => r.subtype === "other_income", -1);
  const otherExpense = section(rows, (r) => r.subtype === "other_expense", 1);

  const grossProfit = Number(operatingIncome.total) - Number(cogs.total);
  const operatingProfit = grossProfit - Number(operatingExpense.total);
  const netProfit = operatingProfit + Number(otherIncome.total) - Number(otherExpense.total);

  res.json({
    from: from ?? null,
    to: to ?? null,
    tagOptionId: tagOptionId ?? null,
    basis: "Accrual",
    operatingIncome,
    costOfGoodsSold: cogs,
    grossProfit: grossProfit.toFixed(2),
    operatingExpense,
    operatingProfit: operatingProfit.toFixed(2),
    otherIncome,
    otherExpense,
    netProfit: netProfit.toFixed(2),
  });
});

/**
 * The T-format P&L: expenses down the left, income down the right, the way an
 * Indian statement is traditionally read. Same figures as the vertical report,
 * arranged in two columns with the balancing profit shown on the short side.
 */
reportsRouter.get("/pnl-horizontal", requirePermission("reports", "view"), async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const rows = await accountMovements(from, to);

  const cogs = section(rows, (r) => r.subtype === "cost_of_goods_sold", 1);
  const operatingExpense = section(
    rows,
    (r) => r.type === "expense" && r.subtype !== "cost_of_goods_sold" && r.subtype !== "other_expense",
    1,
  );
  const otherExpense = section(rows, (r) => r.subtype === "other_expense", 1);
  const operatingIncome = section(rows, (r) => r.type === "income" && r.subtype !== "other_income", -1);
  const otherIncome = section(rows, (r) => r.subtype === "other_income", -1);

  const expenseTotal =
    Number(cogs.total) + Number(operatingExpense.total) + Number(otherExpense.total);
  const incomeTotal = Number(operatingIncome.total) + Number(otherIncome.total);
  const netProfit = incomeTotal - expenseTotal;

  res.json({
    from: from ?? null,
    to: to ?? null,
    basis: "Accrual",
    expense: {
      // Empty sections are kept: a reader has to be able to tell "nil" from
      // "not reported", which is why Zoho prints them too.
      sections: [
        { label: "Cost of Goods Sold", ...cogs },
        { label: "Operating Expense", ...operatingExpense },
        { label: "Non Operating Expense", ...otherExpense },
      ],
      // The balancing figure goes on whichever side is short, so both columns
      // add to the same number — the point of a T-format.
      balancing: netProfit >= 0 ? { label: "Net Profit", amount: netProfit.toFixed(2) } : null,
      total: (expenseTotal + Math.max(netProfit, 0)).toFixed(2),
    },
    income: {
      sections: [
        { label: "Operating Income", ...operatingIncome },
        { label: "Non Operating Income", ...otherIncome },
      ],
      balancing: netProfit < 0 ? { label: "Net Loss", amount: (-netProfit).toFixed(2) } : null,
      total: (incomeTotal + Math.max(-netProfit, 0)).toFixed(2),
    },
    netProfit: netProfit.toFixed(2),
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

/** Assets, liabilities and equity as trees, with earnings folded into equity. */
/**
 * The 31 March before the date given — the last day of the previous financial
 * year, India running 1 April to 31 March. Everything up to it is a closed
 * year and belongs in retained earnings; everything after is this year's.
 */
function priorYearsEnd(asOf: string): string {
  const [y, m] = asOf.split("-").map(Number);
  return `${m! >= 4 ? y! : y! - 1}-03-31`;
}

async function balanceSheetSections(asOf?: string) {
  const rows = await accountMovements(undefined, asOf);

  const pnlNet = (rs: Movement[]) =>
    rs
      .filter((r) => r.type === "income" || r.type === "expense")
      .reduce((s, r) => s + Number(r.net), 0);

  // Retained earnings is derived, not posted — Zoho does the same and has never
  // written a closing entry to the account. It is the accumulated result of
  // every financial year before this one, and it lands on the retained earnings
  // account itself so the sheet reads as Zoho's does.
  //
  // Derived and posted amounts add rather than compete, so a real closing entry
  // posted later is not double-counted: it moves the same figure out of the
  // prior-year profit and loss and onto the account, leaving the line unchanged.
  const today = new Date().toISOString().slice(0, 10);
  const priorRows = await accountMovements(undefined, priorYearsEnd(asOf ?? today));
  const priorYearsResult = pnlNet(priorRows);

  const retainedId = rows.find((r) => r.systemKey === "retained_earnings")?.accountId;
  const withRetained = retainedId
    ? rows.map((r) =>
        r.accountId === retainedId
          ? { ...r, net: (Number(r.net) + priorYearsResult).toFixed(2) }
          : r,
      )
    : rows;

  const assets = section(withRetained, (r) => r.type === "asset", 1);
  const liabilities = section(withRetained, (r) => r.type === "liability", -1);
  const equity = section(withRetained, (r) => r.type === "equity", -1);

  // What is left is this financial year's result, which no account holds yet.
  // Without a retained earnings account to fold the rest into, this stays the
  // whole accumulated figure and the sheet still balances.
  const netEarnings = -(pnlNet(rows) - (retainedId ? priorYearsResult : 0));

  const totalAssets = Number(assets.total);
  const totalLiabilities = Number(liabilities.total);
  const totalEquity = Number(equity.total) + netEarnings;

  return {
    assets,
    liabilities,
    equity,
    netEarnings: netEarnings.toFixed(2),
    totalAssets: totalAssets.toFixed(2),
    totalLiabilities: totalLiabilities.toFixed(2),
    totalEquity: totalEquity.toFixed(2),
    balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.01,
  };
}

reportsRouter.get("/balance-sheet", requirePermission("reports", "view"), async (req, res) => {
  const { asOf } = req.query as Record<string, string | undefined>;
  const s = await balanceSheetSections(asOf);
  res.json({ asOf: asOf ?? null, basis: "Accrual", ...s });
});

/** T-format: what the business owes on the left, what it owns on the right. */
reportsRouter.get(
  "/balance-sheet-horizontal",
  requirePermission("reports", "view"),
  async (req, res) => {
    const { asOf } = req.query as Record<string, string | undefined>;
    const s = await balanceSheetSections(asOf);
    res.json({
      asOf: asOf ?? null,
      basis: "Accrual",
      left: {
        heading: "Liabilities & Equity",
        sections: [
          { label: "Liabilities", ...s.liabilities },
          { label: "Equity", ...s.equity },
        ],
        earnings: { label: "Current Year Earnings", amount: s.netEarnings },
        total: (Number(s.totalLiabilities) + Number(s.totalEquity)).toFixed(2),
      },
      right: {
        heading: "Assets",
        sections: [{ label: "Assets", ...s.assets }],
        earnings: null,
        total: s.totalAssets,
      },
      balanced: s.balanced,
    });
  },
);

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
        // The group's own companies are not receivables from the market.
        eq(contacts.isGroupCompany, false),
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
    .where(
      and(
        inArray(bills.status, ["open", "partially_paid"]),
        lte(bills.billDate, asOf),
        // Nor payables to it.
        eq(contacts.isGroupCompany, false),
      ),
    )
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

// ---------- Sales by Item / Purchase by Item ----------

/**
 * Quantity and value per item over a period.
 *
 * Credit notes and vendor credits are netted off rather than ignored: an item
 * sold and then returned has not been sold, and a report that says otherwise
 * overstates both quantity and revenue. Average price is derived from the net
 * figures for the same reason.
 */
async function itemMovement(
  from: string | undefined,
  to: string | undefined,
  side: "sales" | "purchases",
  accountId?: string,
) {
  const dateCol = side === "sales" ? invoices.invoiceDate : bills.billDate;
  const doc = side === "sales" ? invoices : bills;
  const lines = side === "sales" ? invoiceLines : billLines;
  const lineDocId = side === "sales" ? invoiceLines.invoiceId : billLines.billId;

  const conditions = [sql`${doc.status} NOT IN ('draft', 'void')`];
  if (from) conditions.push(gte(dateCol, from));
  if (to) conditions.push(lte(dateCol, to));

  // Which account a line lands on, spelled exactly as posting resolves it: an
  // explicit override, else the item's default, else — on the sales side only —
  // the `sales` catch-all. Drilling from a P&L line has to reproduce this or the
  // drill-through would show a different population than the figure clicked.
  const lineAccount =
    side === "sales"
      ? sql`COALESCE(${invoiceLines.accountId}, ${items.salesAccountId},
            (SELECT id FROM accounts WHERE system_key = 'sales'))`
      : sql`COALESCE(${billLines.accountId}, ${items.purchaseAccountId})`;
  const creditLineAccount =
    side === "sales"
      ? sql`COALESCE(${creditNoteLines.accountId}, ${items.salesAccountId},
            (SELECT id FROM accounts WHERE system_key = 'sales'))`
      : sql`COALESCE(${vendorCreditLines.accountId}, ${items.purchaseAccountId})`;

  // The filter goes in WHERE, not in the document join: it reads a column from
  // `items`, which is only in scope once that join has happened.
  const accountFilter = accountId ? sql`${lineAccount} = ${accountId}` : undefined;

  const positive = await db
    .select({
      itemId: items.id,
      name: items.name,
      unit: items.unit,
      quantity: sql<string>`COALESCE(SUM(${lines.quantity}), 0)::numeric(14,3)`,
      amount: sql<string>`COALESCE(SUM(${lines.amount}), 0)::numeric(14,2)`,
    })
    .from(lines)
    .innerJoin(doc, and(eq(doc.id, lineDocId), ...conditions))
    .innerJoin(items, eq(items.id, lines.itemId))
    .where(accountFilter)
    .groupBy(items.id, items.name, items.unit);

  // Returns net off the sale or purchase they reverse.
  const creditDoc = side === "sales" ? creditNotes : vendorCredits;
  const creditLines = side === "sales" ? creditNoteLines : vendorCreditLines;
  const creditDocId = side === "sales" ? creditNoteLines.creditNoteId : vendorCreditLines.vendorCreditId;
  const creditDate = side === "sales" ? creditNotes.creditNoteDate : vendorCredits.creditDate;

  const creditConditions = [sql`${creditDoc.status} NOT IN ('draft', 'void')`];
  if (from) creditConditions.push(gte(creditDate, from));
  if (to) creditConditions.push(lte(creditDate, to));

  const negative = await db
    .select({
      itemId: items.id,
      quantity: sql<string>`COALESCE(SUM(${creditLines.quantity}), 0)::numeric(14,3)`,
      amount: sql<string>`COALESCE(SUM(${creditLines.amount}), 0)::numeric(14,2)`,
    })
    .from(creditLines)
    .innerJoin(creditDoc, and(eq(creditDoc.id, creditDocId), ...creditConditions))
    .innerJoin(items, eq(items.id, creditLines.itemId))
    .where(accountId ? sql`${creditLineAccount} = ${accountId}` : undefined)
    .groupBy(items.id);
  const returnsByItem = new Map(negative.map((r) => [r.itemId, r]));

  const rows = positive
    .map((r) => {
      const ret = returnsByItem.get(r.itemId);
      const quantity = Number(r.quantity) - Number(ret?.quantity ?? 0);
      const amount = Number(r.amount) - Number(ret?.amount ?? 0);
      return {
        itemId: r.itemId,
        name: r.name,
        unit: r.unit,
        quantity: quantity.toFixed(2),
        amount: amount.toFixed(2),
        averagePrice: quantity !== 0 ? (amount / quantity).toFixed(2) : "0.00",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Named so the report can say what it has been narrowed to, rather than
  // silently showing a subset that looks like the whole.
  const [account] = accountId
    ? await db
        .select({ id: accounts.id, code: accounts.code, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1)
    : [];

  return {
    from: from ?? null,
    to: to ?? null,
    account: account ?? null,
    rows,
    totalQuantity: rows.reduce((s, r) => s + Number(r.quantity), 0).toFixed(2),
    totalAmount: rows.reduce((s, r) => s + Number(r.amount), 0).toFixed(2),
  };
}

reportsRouter.get("/sales-by-item", requirePermission("reports", "view"), async (req, res) => {
  const { from, to, accountId } = req.query as Record<string, string | undefined>;
  res.json(await itemMovement(from, to, "sales", accountId));
});

reportsRouter.get("/purchase-by-item", requirePermission("reports", "view"), async (req, res) => {
  const { from, to, accountId } = req.query as Record<string, string | undefined>;
  res.json(await itemMovement(from, to, "purchases", accountId));
});

// ---------- Sales by Customer / Purchases by Vendor ----------

/**
 * Sales per customer.
 *
 * Two money columns, as Zoho has them: "Sales" is the taxable value the P&L
 * sees, "Sales with Tax" is what the customer was actually billed — tax and
 * round-off included. They differ, and a reader chasing either figure needs
 * the one that matches where they came from.
 *
 * The count is of invoices only. Credit notes reduce the money but a return is
 * not a sale, so counting it as one would overstate how often this customer
 * bought.
 */
reportsRouter.get("/sales-by-customer", requirePermission("reports", "view"), async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;

  const window = (col: AnyPgColumn) => [
    ...(from ? [gte(col, from)] : []),
    ...(to ? [lte(col, to)] : []),
  ];

  const invoiceRows = await db
    .select({
      contactId: invoices.customerId,
      name: contacts.displayName,
      count: sql<number>`count(*)::int`,
      net: sql<string>`COALESCE(SUM(${invoices.subTotal} - ${invoices.discountTotal}), 0)::numeric(14,2)`,
      gross: sql<string>`COALESCE(SUM(${invoices.total}), 0)::numeric(14,2)`,
    })
    .from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.customerId))
    .where(and(eq(contacts.isGroupCompany, false), sql`${invoices.status} NOT IN ('draft', 'void')`, ...window(invoices.invoiceDate)))
    .groupBy(invoices.customerId, contacts.displayName);

  const creditRows = await db
    .select({
      contactId: creditNotes.customerId,
      name: contacts.displayName,
      net: sql<string>`COALESCE(SUM(${creditNotes.subTotal} - ${creditNotes.discountTotal}), 0)::numeric(14,2)`,
      gross: sql<string>`COALESCE(SUM(${creditNotes.total}), 0)::numeric(14,2)`,
    })
    .from(creditNotes)
    .innerJoin(contacts, eq(contacts.id, creditNotes.customerId))
    .where(
      and(eq(contacts.isGroupCompany, false), sql`${creditNotes.status} NOT IN ('draft', 'void')`, ...window(creditNotes.creditNoteDate)),
    )
    .groupBy(creditNotes.customerId, contacts.displayName);

  const byContact = new Map<
    string,
    { contactId: string; name: string; invoiceCount: number; sales: number; salesWithTax: number }
  >();
  for (const r of invoiceRows) {
    byContact.set(r.contactId, {
      contactId: r.contactId,
      name: r.name,
      invoiceCount: r.count,
      sales: Number(r.net),
      salesWithTax: Number(r.gross),
    });
  }
  for (const r of creditRows) {
    const row = byContact.get(r.contactId) ?? {
      contactId: r.contactId,
      name: r.name,
      invoiceCount: 0,
      sales: 0,
      salesWithTax: 0,
    };
    row.sales -= Number(r.net);
    row.salesWithTax -= Number(r.gross);
    byContact.set(r.contactId, row);
  }

  const rows = [...byContact.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      ...r,
      sales: r.sales.toFixed(2),
      salesWithTax: r.salesWithTax.toFixed(2),
    }));

  res.json({
    from: from ?? null,
    to: to ?? null,
    rows,
    totalCount: rows.reduce((s, r) => s + r.invoiceCount, 0),
    totalSales: rows.reduce((s, r) => s + Number(r.sales), 0).toFixed(2),
    totalSalesWithTax: rows.reduce((s, r) => s + Number(r.salesWithTax), 0).toFixed(2),
  });
});

/**
 * Purchases per vendor, across bills, vendor credits and expense claims.
 *
 * Expenses belong here or the report would miss most of what EGGSY spends —
 * electricity, freight and fuel are claims, not bills. An expense with no
 * vendor named still has to be counted, so those collect under "Others" rather
 * than being dropped.
 *
 * Journals are excluded: EGGSY does not record a contact on a journal entry, so
 * there is no vendor to attribute one to. Zoho shows a Journal Count column;
 * printing one full of zeros would claim an attribution that does not exist.
 */
reportsRouter.get("/purchases-by-vendor", requirePermission("reports", "view"), async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;

  const billRows = await db
    .select({
      contactId: bills.vendorId,
      name: contacts.displayName,
      count: sql<number>`count(*)::int`,
      net: sql<string>`COALESCE(SUM(${bills.subTotal} - ${bills.discountTotal}), 0)::numeric(14,2)`,
      gross: sql<string>`COALESCE(SUM(${bills.total}), 0)::numeric(14,2)`,
    })
    .from(bills)
    .innerJoin(contacts, eq(contacts.id, bills.vendorId))
    .where(
      and(eq(contacts.isGroupCompany, false), 
        sql`${bills.status} NOT IN ('draft', 'void')`,
        ...(from ? [gte(bills.billDate, from)] : []),
        ...(to ? [lte(bills.billDate, to)] : []),
      ),
    )
    .groupBy(bills.vendorId, contacts.displayName);

  const creditRows = await db
    .select({
      contactId: vendorCredits.vendorId,
      name: contacts.displayName,
      count: sql<number>`count(*)::int`,
      net: sql<string>`COALESCE(SUM(${vendorCredits.subTotal} - ${vendorCredits.discountTotal}), 0)::numeric(14,2)`,
      gross: sql<string>`COALESCE(SUM(${vendorCredits.total}), 0)::numeric(14,2)`,
    })
    .from(vendorCredits)
    .innerJoin(contacts, eq(contacts.id, vendorCredits.vendorId))
    .where(
      and(eq(contacts.isGroupCompany, false), 
        sql`${vendorCredits.status} NOT IN ('draft', 'void')`,
        ...(from ? [gte(vendorCredits.creditDate, from)] : []),
        ...(to ? [lte(vendorCredits.creditDate, to)] : []),
      ),
    )
    .groupBy(vendorCredits.vendorId, contacts.displayName);

  const expenseRows = await db
    .select({
      contactId: expenses.vendorId,
      count: sql<number>`count(*)::int`,
      net: sql<string>`COALESCE(SUM(${expenses.amount}), 0)::numeric(14,2)`,
      gross: sql<string>`COALESCE(SUM(${expenses.amount} + ${expenses.taxAmount}), 0)::numeric(14,2)`,
    })
    .from(expenses)
    .where(
      and(
        ...(from ? [gte(expenses.expenseDate, from)] : []),
        ...(to ? [lte(expenses.expenseDate, to)] : []),
      ),
    )
    .groupBy(expenses.vendorId);

  // Expenses name their vendor optionally, so look the names up in one go
  // rather than joining and silently losing the unnamed ones.
  const expenseVendorIds = expenseRows.map((r) => r.contactId).filter((id): id is string => !!id);
  const expenseNames = new Map(
    expenseVendorIds.length
      ? (
          await db
            .select({ id: contacts.id, name: contacts.displayName })
            .from(contacts)
            .where(inArray(contacts.id, expenseVendorIds))
        ).map((c) => [c.id, c.name])
      : [],
  );

  interface Row {
    contactId: string | null;
    name: string;
    expenseCount: number;
    billCount: number;
    vendorCreditCount: number;
    amount: number;
    amountWithTax: number;
  }
  const byContact = new Map<string | null, Row>();
  const row = (contactId: string | null, name: string): Row => {
    const existing = byContact.get(contactId);
    if (existing) return existing;
    const fresh: Row = {
      contactId,
      name,
      expenseCount: 0,
      billCount: 0,
      vendorCreditCount: 0,
      amount: 0,
      amountWithTax: 0,
    };
    byContact.set(contactId, fresh);
    return fresh;
  };

  for (const r of billRows) {
    const t = row(r.contactId, r.name);
    t.billCount += r.count;
    t.amount += Number(r.net);
    t.amountWithTax += Number(r.gross);
  }
  for (const r of creditRows) {
    const t = row(r.contactId, r.name);
    t.vendorCreditCount += r.count;
    t.amount -= Number(r.net);
    t.amountWithTax -= Number(r.gross);
  }
  for (const r of expenseRows) {
    const t = row(r.contactId, r.contactId ? (expenseNames.get(r.contactId) ?? "—") : "Others");
    t.expenseCount += r.count;
    t.amount += Number(r.net);
    t.amountWithTax += Number(r.gross);
  }

  const rows = [...byContact.values()]
    // "Others" leads, then vendors by name — Zoho's order.
    .sort((a, b) =>
      a.contactId === null ? -1 : b.contactId === null ? 1 : a.name.localeCompare(b.name),
    )
    .map((r) => ({
      ...r,
      amount: r.amount.toFixed(2),
      amountWithTax: r.amountWithTax.toFixed(2),
    }));

  res.json({
    from: from ?? null,
    to: to ?? null,
    rows,
    totalExpenseCount: rows.reduce((s, r) => s + r.expenseCount, 0),
    totalBillCount: rows.reduce((s, r) => s + r.billCount, 0),
    totalVendorCreditCount: rows.reduce((s, r) => s + r.vendorCreditCount, 0),
    totalAmount: rows.reduce((s, r) => s + Number(r.amount), 0).toFixed(2),
    totalAmountWithTax: rows.reduce((s, r) => s + Number(r.amountWithTax), 0).toFixed(2),
  });
});

// ---------- Expense by Category ----------

/**
 * Expense grouped by its top-level account, with the sub-accounts beneath.
 *
 * "Category" here is the parent expense account — EGGSY has no separate
 * category concept, and inventing one would leave two ways to classify a cost.
 * The client shows categories collapsed and expands on click, which is the bit
 * Zoho's own version lacks.
 */
reportsRouter.get("/expense-by-category", requirePermission("reports", "view"), async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const rows = await accountMovements(from, to);
  const expense = section(rows, (r) => r.type === "expense", 1);

  const categories = expense.nodes.map((n) => ({
    accountId: n.accountId,
    code: n.code,
    name: n.name,
    total: n.total,
    /** Flattened descendants, so a three-deep chart still lists every leaf. */
    children: flattenLeaves(n.children),
  }));
  const total = Number(expense.total);

  res.json({
    from: from ?? null,
    to: to ?? null,
    // A share of a negative or zero total is meaningless — a category can read
    // -511% of the whole — so the percentage is withheld rather than printed.
    categories: categories.map((c) => ({
      ...c,
      percentOfTotal: total > 0 ? ((Number(c.total) / total) * 100).toFixed(1) : null,
    })),
    total: expense.total,
  });
});

/** Depth beyond the second level reads as noise on a summary, so it is flattened. */
type Leaf = { accountId: string; code: string; name: string; total: string; hasItemLines: boolean };

function flattenLeaves(nodes: Array<Leaf & { children: unknown[] }>): Leaf[] {
  const out: Leaf[] = [];
  for (const n of nodes) {
    out.push({
      accountId: n.accountId,
      code: n.code,
      name: n.name,
      total: n.total,
      hasItemLines: n.hasItemLines,
    });
    out.push(...flattenLeaves(n.children as Array<Leaf & { children: unknown[] }>));
  }
  return out;
}

/* ── Farms ────────────────────────────────────────────────────────────────── */

/**
 * The batch picker.
 *
 * This report is keyed on a flock rather than a date range, because a batch's
 * age is what every benchmark is published against — comparing two batches over
 * the same calendar month compares an 18-week bird with a 60-week one and calls
 * the difference performance.
 */
reportsRouter.get("/farm-batches", requirePermission("reports", "view"), async (_req, res) => {
  const rows = await db
    .select({
      id: flocks.id,
      code: flocks.code,
      status: flocks.status,
      hatchDate: flocks.hatchDate,
      placedCount: flocks.placedCount,
      breed: breeds.name,
      location: locations.name,
      houses: sql<string>`string_agg(distinct ${houses.code}, ', ' order by ${houses.code})`,
    })
    .from(flocks)
    .innerJoin(breeds, eq(breeds.id, flocks.breedId))
    .innerJoin(locations, eq(locations.id, flocks.locationId))
    .leftJoin(flockPlacements, eq(flockPlacements.flockId, flocks.id))
    .leftJoin(houses, eq(houses.id, flockPlacements.houseId))
    .groupBy(flocks.id, breeds.name, locations.name)
    .orderBy(desc(flocks.hatchDate));
  res.json({ batches: rows });
});

/**
 * Weekly Management Summary — one row per age week for one batch.
 *
 * Rearing weeks are shown with the egg columns blank rather than filtered out:
 * the pullet weeks are where a bad lay curve is decided, and a report that
 * starts at week 18 hides the cause of what it is reporting.
 *
 * The cost column lives here and nowhere in the Farms module. `reports.view` is
 * the gate — the people entering daily records have farms permissions, not this
 * one, so nobody working a shed sees a rupee figure by accident.
 */
reportsRouter.get(
  "/weekly-management-summary",
  requirePermission("reports", "view"),
  async (req, res) => {
    const flockId = String(req.query.flockId ?? "");
    if (!flockId) return res.status(400).json({ message: "Choose a batch" });

    const [flock] = await db
      .select({
        id: flocks.id,
        code: flocks.code,
        status: flocks.status,
        hatchDate: flocks.hatchDate,
        placedCount: flocks.placedCount,
        housedOn: flocks.housedOn,
        layStartDate: flocks.layStartDate,
        depletedOn: flocks.depletedOn,
        breed: breeds.name,
        location: locations.name,
        houses: sql<string>`string_agg(distinct ${houses.code}, ', ' order by ${houses.code})`,
      })
      .from(flocks)
      .innerJoin(breeds, eq(breeds.id, flocks.breedId))
      .innerJoin(locations, eq(locations.id, flocks.locationId))
      .leftJoin(flockPlacements, eq(flockPlacements.flockId, flocks.id))
      .leftJoin(houses, eq(houses.id, flockPlacements.houseId))
      .where(eq(flocks.id, flockId))
      .groupBy(flocks.id, breeds.name, locations.name);
    if (!flock) return res.status(404).json({ message: "No such batch" });

    const weeks = await weeklySummary(db, flockId);
    res.json({ flock, weeks });
  },
);
