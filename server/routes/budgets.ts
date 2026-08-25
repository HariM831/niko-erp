import { Router } from "express";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, budgetLines, budgets, journalEntries, journalEntryLines } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const budgetsRouter = Router();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/);

/** Months covered by one slice of a budget period. */
function stepMonths(period: string) {
  if (period === "yearly") return 12;
  if (period === "half_yearly") return 6;
  if (period === "quarterly") return 3;
  return 1;
}

/** First day of each slice between start and end, inclusive. */
export function periodStarts(start: string, end: string, period: string): string[] {
  const step = stepMonths(period);
  const out: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  cursor.setUTCDate(1);
  while (cursor <= last) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + step);
  }
  return out;
}

/** Exclusive end of the slice beginning at `start`. */
function periodEnd(start: string, period: string): string {
  const step = stepMonths(period);
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + step);
  return d.toISOString().slice(0, 10);
}

budgetsRouter.get("/", requirePermission("accounting", "view"), async (_req, res) => {
  const rows = await db.select().from(budgets).orderBy(asc(budgets.startDate));
  res.json(rows);
});

const budgetSchema = z.object({
  name: z.string().min(1),
  startDate: dateStr,
  endDate: dateStr,
  period: z.enum(["monthly", "quarterly", "half_yearly", "yearly"]).default("monthly"),
  includeBalanceSheet: z.boolean().optional(),
  accountIds: z.array(z.string().uuid()).min(1).max(300),
});

budgetsRouter.post(
  "/",
  requirePermission("accounting", "create"),
  validateBody(budgetSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof budgetSchema>;
    if (body.endDate < body.startDate) {
      return res.status(422).json({ error: "End date must be on or after the start date" });
    }
    const result = await db.transaction(async (tx) => {
      const [budget] = await tx
        .insert(budgets)
        .values({
          name: body.name,
          startDate: body.startDate,
          endDate: body.endDate,
          period: body.period,
          includeBalanceSheet: body.includeBalanceSheet ?? false,
        })
        .returning();
      // Seed a zero row per account per period so the entry grid is fully formed.
      const starts = periodStarts(body.startDate, body.endDate, body.period);
      const rows = body.accountIds.flatMap((accountId) =>
        starts.map((periodStart) => ({ budgetId: budget!.id, accountId, periodStart, amount: "0" })),
      );
      if (rows.length) await tx.insert(budgetLines).values(rows);
      return budget!;
    });
    res.status(201).json(result);
  },
);

budgetsRouter.get("/:id", requirePermission("accounting", "view"), async (req, res) => {
  const budget = await db.query.budgets.findFirst({ where: eq(budgets.id, req.params.id!) });
  if (!budget) return res.status(404).json({ error: "Budget not found" });
  const lines = await db
    .select({
      id: budgetLines.id,
      accountId: budgetLines.accountId,
      periodStart: budgetLines.periodStart,
      amount: budgetLines.amount,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
    })
    .from(budgetLines)
    .innerJoin(accounts, eq(accounts.id, budgetLines.accountId))
    .where(eq(budgetLines.budgetId, budget.id))
    .orderBy(asc(accounts.code), asc(budgetLines.periodStart));
  res.json({ ...budget, periods: periodStarts(budget.startDate, budget.endDate, budget.period), lines });
});

const linesPatchSchema = z.object({
  lines: z
    .array(z.object({ accountId: z.string().uuid(), periodStart: dateStr, amount: money }))
    .max(5000),
});

/** Upsert budget figures. Sent as a whole grid, so unchanged cells are harmless. */
budgetsRouter.patch(
  "/:id/lines",
  requirePermission("accounting", "edit"),
  validateBody(linesPatchSchema),
  async (req, res) => {
    const budget = await db.query.budgets.findFirst({ where: eq(budgets.id, req.params.id!) });
    if (!budget) return res.status(404).json({ error: "Budget not found" });
    const body = req.body as z.infer<typeof linesPatchSchema>;

    const wantedIds = [...new Set(body.lines.map((l) => l.accountId))];
    const found = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.id, wantedIds));
    const foundIds = new Set(found.map((a) => a.id));
    const missing = wantedIds.filter((id) => !foundIds.has(id));
    if (missing.length) {
      return res.status(422).json({ error: `No such account: ${missing.join(", ")}` });
    }

    await db.transaction(async (tx) => {
      for (const l of body.lines) {
        await tx
          .insert(budgetLines)
          .values({ budgetId: budget.id, accountId: l.accountId, periodStart: l.periodStart, amount: l.amount })
          .onConflictDoUpdate({
            target: [budgetLines.budgetId, budgetLines.accountId, budgetLines.periodStart],
            set: { amount: l.amount },
          });
      }
      await tx.update(budgets).set({ updatedAt: new Date() }).where(eq(budgets.id, budget.id));
    });
    res.json({ ok: true, updated: body.lines.length });
  },
);

budgetsRouter.delete("/:id", requirePermission("accounting", "delete"), async (req, res) => {
  const [row] = await db.delete(budgets).where(eq(budgets.id, req.params.id!)).returning();
  if (!row) return res.status(404).json({ error: "Budget not found" });
  res.json({ ok: true });
});

/**
 * Budget vs actuals. Actuals come straight from posted journal lines, signed the
 * way each account naturally reads: income as credit-positive, everything else
 * debit-positive, so a revenue budget of 100 against 120 earned shows +20.
 */
budgetsRouter.get("/:id/actuals", requirePermission("accounting", "view"), async (req, res) => {
  const budget = await db.query.budgets.findFirst({ where: eq(budgets.id, req.params.id!) });
  if (!budget) return res.status(404).json({ error: "Budget not found" });

  const periods = periodStarts(budget.startDate, budget.endDate, budget.period);
  const lines = await db
    .select({
      accountId: budgetLines.accountId,
      periodStart: budgetLines.periodStart,
      amount: budgetLines.amount,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
    })
    .from(budgetLines)
    .innerJoin(accounts, eq(accounts.id, budgetLines.accountId))
    .where(eq(budgetLines.budgetId, budget.id))
    .orderBy(asc(accounts.code), asc(budgetLines.periodStart));

  // One aggregate query for the whole window, then bucketed in JS.
  const postings = await db
    .select({
      accountId: journalEntryLines.accountId,
      entryDate: journalEntries.entryDate,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
    .where(
      and(
        eq(journalEntries.status, "posted"),
        gte(journalEntries.entryDate, budget.startDate),
        lte(journalEntries.entryDate, budget.endDate),
      ),
    );

  const bucketFor = (date: string) => {
    let chosen = periods[0]!;
    for (const p of periods) if (date >= p) chosen = p;
    return chosen;
  };
  const typeByAccount = new Map(lines.map((l) => [l.accountId, l.accountType]));
  const actualByKey = new Map<string, number>();
  for (const p of postings) {
    const type = typeByAccount.get(p.accountId);
    if (!type) continue; // account isn't in this budget
    const signed =
      type === "income" || type === "liability" || type === "equity"
        ? Number(p.credit) - Number(p.debit)
        : Number(p.debit) - Number(p.credit);
    const key = `${p.accountId}:${bucketFor(p.entryDate)}`;
    actualByKey.set(key, (actualByKey.get(key) ?? 0) + signed);
  }

  // Collapse the flat line list into one row per account with a cell per period.
  const byAccount = new Map<string, {
    accountId: string; accountCode: string; accountName: string; accountType: string;
    cells: Array<{ periodStart: string; budget: string; actual: string; variance: string; variancePercent: number | null }>;
    totalBudget: number; totalActual: number;
  }>();
  for (const l of lines) {
    let row = byAccount.get(l.accountId);
    if (!row) {
      row = {
        accountId: l.accountId, accountCode: l.accountCode, accountName: l.accountName,
        accountType: l.accountType, cells: [], totalBudget: 0, totalActual: 0,
      };
      byAccount.set(l.accountId, row);
    }
    const budgeted = Number(l.amount);
    const actual = actualByKey.get(`${l.accountId}:${l.periodStart}`) ?? 0;
    const variance = actual - budgeted;
    row.cells.push({
      periodStart: l.periodStart,
      budget: budgeted.toFixed(2),
      actual: actual.toFixed(2),
      variance: variance.toFixed(2),
      variancePercent: budgeted === 0 ? null : Math.round((variance / Math.abs(budgeted)) * 1000) / 10,
    });
    row.totalBudget += budgeted;
    row.totalActual += actual;
  }

  const rows = [...byAccount.values()].map((r) => ({
    ...r,
    totalBudget: r.totalBudget.toFixed(2),
    totalActual: r.totalActual.toFixed(2),
    totalVariance: (r.totalActual - r.totalBudget).toFixed(2),
  }));
  res.json({ budget, periods, rows });
});
