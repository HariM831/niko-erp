import { Router } from "express";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accountType,
  accounts,
  journalEntries,
  journalEntryLines,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { PostingError, postJournal, reverseJournal } from "../services/posting";

export const accountingRouter = Router();

// ---------- Chart of Accounts ----------

accountingRouter.get(
  "/accounts",
  requirePermission("accounting", "view"),
  async (_req, res) => {
    const rows = await db.select().from(accounts).orderBy(asc(accounts.code));
    res.json(rows);
  },
);

const accountSchema = z.object({
  code: z.string().min(1).max(12),
  name: z.string().min(1),
  type: z.enum(accountType.enumValues),
  parentId: z.string().uuid().optional(),
  description: z.string().optional(),
});

accountingRouter.post(
  "/accounts",
  requirePermission("accounting", "create"),
  validateBody(accountSchema),
  async (req, res) => {
    const [row] = await db.insert(accounts).values(req.body).returning();
    res.status(201).json(row);
  },
);

accountingRouter.patch(
  "/accounts/:id",
  requirePermission("accounting", "edit"),
  validateBody(accountSchema.partial().extend({ isActive: z.boolean().optional() })),
  async (req, res) => {
    const [row] = await db
      .update(accounts)
      .set(req.body)
      .where(eq(accounts.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Account not found" });
    res.json(row);
  },
);

// ---------- Manual Journals ----------

const journalLineSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  credit: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  description: z.string().optional(),
  tag: z.string().max(60).optional(),
});

const journalSchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  narration: z.string().min(1),
  reference: z.string().optional(),
  lines: z.array(journalLineSchema).min(2).max(200),
});

accountingRouter.get(
  "/journals",
  requirePermission("accounting", "view"),
  async (req, res) => {
    const { from, to } = req.query as Record<string, string | undefined>;
    const conditions = [];
    if (from) conditions.push(gte(journalEntries.entryDate, from));
    if (to) conditions.push(lte(journalEntries.entryDate, to));
    const rows = await db
      .select()
      .from(journalEntries)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(sql`${journalEntries.entryDate} DESC`)
      .limit(200);
    res.json(rows);
  },
);

accountingRouter.get(
  "/journals/:id",
  requirePermission("accounting", "view"),
  async (req, res) => {
    const entry = await db.query.journalEntries.findFirst({
      where: eq(journalEntries.id, req.params.id!),
    });
    if (!entry) return res.status(404).json({ error: "Not found" });
    const lines = await db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.entryId, entry.id))
      .orderBy(asc(journalEntryLines.lineOrder));
    res.json({ ...entry, lines });
  },
);

accountingRouter.post(
  "/journals",
  requirePermission("accounting", "create"),
  validateBody(journalSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof journalSchema>;
    try {
      const entryId = await db.transaction((tx) =>
        postJournal(tx, {
          entryDate: body.entryDate,
          narration: body.narration,
          reference: body.reference,
          sourceType: "manual",
          postedBy: req.session.user!.id,
          lines: body.lines,
        }),
      );
      res.status(201).json({ id: entryId });
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

accountingRouter.post(
  "/journals/:id/reverse",
  requirePermission("accounting", "edit"),
  validateBody(z.object({ reversalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  async (req, res) => {
    try {
      const id = await db.transaction((tx) =>
        reverseJournal(tx, req.params.id!, req.body.reversalDate, req.session.user!.id),
      );
      res.status(201).json({ id });
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

// ---------- Reports ----------

/**
 * Trial balance as of a date range, aggregated in SQL from posted lines.
 * Returns per-account debit/credit totals and net — never a stored balance.
 */
accountingRouter.get(
  "/reports/trial-balance",
  requirePermission("reports", "view"),
  async (req, res) => {
    const { from, to } = req.query as Record<string, string | undefined>;
    const conditions = [eq(journalEntries.status, "posted")];
    if (from) conditions.push(gte(journalEntries.entryDate, from));
    if (to) conditions.push(lte(journalEntries.entryDate, to));

    const rows = await db
      .select({
        accountId: accounts.id,
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
        totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)::numeric(14,2)`,
        totalCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)::numeric(14,2)`,
      })
      .from(accounts)
      .leftJoin(journalEntryLines, eq(journalEntryLines.accountId, accounts.id))
      .leftJoin(
        journalEntries,
        and(eq(journalEntries.id, journalEntryLines.entryId), ...conditions),
      )
      .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
      .orderBy(asc(accounts.code));

    res.json(rows);
  },
);

/** Account ledger (statement) with SQL running totals. */
accountingRouter.get(
  "/ledger/:accountId",
  requirePermission("accounting", "view"),
  async (req, res) => {
    const { from, to } = req.query as Record<string, string | undefined>;
    const conditions = [
      eq(journalEntryLines.accountId, req.params.accountId!),
      eq(journalEntries.status, "posted"),
    ];
    if (from) conditions.push(gte(journalEntries.entryDate, from));
    if (to) conditions.push(lte(journalEntries.entryDate, to));

    const rows = await db
      .select({
        entryId: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.entryDate,
        narration: journalEntries.narration,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        running: sql<string>`SUM(${journalEntryLines.debit} - ${journalEntryLines.credit}) OVER (ORDER BY ${journalEntries.entryDate}, ${journalEntries.postedAt}, ${journalEntryLines.lineOrder})::numeric(14,2)`,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
      .where(and(...conditions))
      .orderBy(asc(journalEntries.entryDate));

    res.json(rows);
  },
);
