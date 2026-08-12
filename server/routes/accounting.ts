import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accountSubtype,
  accountType,
  accounts,
  journalEntries,
  journalEntryLines,
  transactionLocks,
  users,
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
  subtype: z.enum(accountSubtype.enumValues).optional(),
  isGroup: z.boolean().optional(),
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
    const { from, to, all } = req.query as Record<string, string | undefined>;
    const conditions = [];
    // Zoho's "Manual Journals" lists only hand-written entries; the postings that
    // documents generate belong to those documents. `?all=1` opts into everything.
    if (all !== "1") conditions.push(eq(journalEntries.sourceType, "manual"));
    if (from) conditions.push(gte(journalEntries.entryDate, from));
    if (to) conditions.push(lte(journalEntries.entryDate, to));

    const rows = await db
      .select({ ...getTableColumns(journalEntries), createdByName: users.name })
      .from(journalEntries)
      .leftJoin(users, eq(users.id, journalEntries.postedBy))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(journalEntries.entryDate))
      .limit(200);

    // Entry value = its debit total (a balanced entry's two sides are equal).
    // Fetched separately: a correlated subquery inside .select() renders the outer
    // column unqualified and silently resolves against the subquery's own table.
    const totals = await db
      .select({
        entryId: journalEntryLines.entryId,
        amount: sql<string>`SUM(${journalEntryLines.debit})::numeric(14,2)`,
      })
      .from(journalEntryLines)
      .groupBy(journalEntryLines.entryId);
    const amountByEntry = new Map(totals.map((t) => [t.entryId, t.amount]));

    res.json(rows.map((r) => ({ ...r, amount: amountByEntry.get(r.id) ?? "0.00" })));
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

/**
 * The posted journal entry for a source document (invoice, payment, expense...),
 * with account codes/names joined in — this is the "Journal" tab Zoho shows on
 * every transaction detail page, proving the double-entry posting really happened.
 */
accountingRouter.get(
  "/journal-by-source",
  requirePermission("accounting", "view"),
  async (req, res) => {
    const { sourceType, sourceId } = req.query as Record<string, string | undefined>;
    if (!sourceType || !sourceId) return res.status(400).json({ error: "sourceType and sourceId are required" });
    const entry = await db.query.journalEntries.findFirst({
      where: and(
        eq(journalEntries.sourceType, sourceType as typeof journalEntries.$inferSelect.sourceType),
        eq(journalEntries.sourceId, sourceId),
      ),
    });
    if (!entry) return res.json(null);
    const lines = await db
      .select({
        accountCode: accounts.code,
        accountName: accounts.name,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
      })
      .from(journalEntryLines)
      .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
      .where(eq(journalEntryLines.entryId, entry.id))
      .orderBy(asc(journalEntryLines.lineOrder));
    res.json({ id: entry.id, entryNumber: entry.entryNumber, entryDate: entry.entryDate, lines });
  },
);

// ---------- Transaction locking ----------

const LOCK_MODULES = ["sales", "purchases", "banking", "accountant"] as const;

/** Current lock state for all four modules; unlocked modules come back as null. */
accountingRouter.get(
  "/transaction-locks",
  requirePermission("accounting", "view"),
  async (_req, res) => {
    const rows = await db.select().from(transactionLocks);
    const byModule = new Map(rows.map((r) => [r.module, r]));
    res.json(
      LOCK_MODULES.map((m) => ({
        module: m,
        lockedThrough: byModule.get(m)?.lockedThrough ?? null,
        reason: byModule.get(m)?.reason ?? null,
      })),
    );
  },
);

const lockSchema = z.object({
  /** null clears the lock for this module. */
  lockedThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  reason: z.string().max(500).optional(),
  /** Apply the same date to every module — Zoho's "lock all at once". */
  applyToAll: z.boolean().optional(),
});

accountingRouter.put(
  "/transaction-locks/:module",
  requirePermission("accounting", "edit"),
  validateBody(lockSchema),
  async (req, res) => {
    const mod = req.params.module!;
    if (!LOCK_MODULES.includes(mod as (typeof LOCK_MODULES)[number])) {
      return res.status(400).json({ error: `Unknown module: ${mod}` });
    }
    const body = req.body as z.infer<typeof lockSchema>;
    const targets = body.applyToAll ? LOCK_MODULES : [mod];

    await db.transaction(async (tx) => {
      for (const m of targets) {
        await tx
          .insert(transactionLocks)
          .values({ module: m, lockedThrough: body.lockedThrough, reason: body.reason })
          .onConflictDoUpdate({
            target: transactionLocks.module,
            set: { lockedThrough: body.lockedThrough, reason: body.reason, updatedAt: new Date() },
          });
      }
    });
    const rows = await db.select().from(transactionLocks);
    res.json(rows);
  },
);

/** One posted entry with account names, for the Journal panel on a document. */
accountingRouter.get(
  "/journal-entry/:id",
  requirePermission("accounting", "view"),
  async (req, res) => {
    const entry = await db.query.journalEntries.findFirst({
      where: eq(journalEntries.id, req.params.id!),
    });
    if (!entry) return res.json(null);
    const lines = await db
      .select({
        accountCode: accounts.code,
        accountName: accounts.name,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
      })
      .from(journalEntryLines)
      .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
      .where(eq(journalEntryLines.entryId, entry.id))
      .orderBy(asc(journalEntryLines.lineOrder));
    res.json({ id: entry.id, entryNumber: entry.entryNumber, entryDate: entry.entryDate, lines });
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
