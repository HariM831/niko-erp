import { Router } from "express";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  bankAccounts,
  bankTransactions,
  bankTxnDirection,
  journalEntries,
  journalEntryLines,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { PostingError, postJournal } from "../services/posting";
import { toPaise } from "../services/documents";

export const bankingRouter = Router();

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------- Bank accounts ----------

const bankAccountSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["bank", "cash", "card"]).optional(),
  bankName: z.string().optional(),
  accountNumber: z.string().max(30).optional(),
  ifsc: z.string().max(11).optional(),
  branch: z.string().optional(),
  glAccountId: z.string().uuid().optional(),
});

bankingRouter.get("/accounts", requirePermission("banking", "view"), async (_req, res) => {
  // Balance = SQL aggregation over posted journal lines on each GL account.
  const rows = await db
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      kind: bankAccounts.kind,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      ifsc: bankAccounts.ifsc,
      branch: bankAccounts.branch,
      glAccountId: bankAccounts.glAccountId,
      isActive: bankAccounts.isActive,
      balance: sql<string>`COALESCE((
        SELECT SUM(jel.debit - jel.credit)
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.entry_id
        WHERE jel.account_id = ${bankAccounts.glAccountId} AND je.status = 'posted'
      ), 0)::numeric(14,2)`,
    })
    .from(bankAccounts)
    .orderBy(asc(bankAccounts.name));
  res.json(rows);
});

/** Creating a bank account auto-creates its GL account under Cash & Bank if none given. */
bankingRouter.post(
  "/accounts",
  requirePermission("banking", "create"),
  validateBody(bankAccountSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof bankAccountSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        let glAccountId = body.glAccountId;
        if (!glAccountId) {
          const [countRow] = await tx
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(accounts)
            .where(sql`${accounts.code} LIKE 'BNK-%'`);
          const count = countRow?.count ?? 0;
          const [gl] = await tx
            .insert(accounts)
            .values({
              code: `BNK-${String((count ?? 0) + 1).padStart(3, "0")}`,
              name: body.name,
              type: "asset",
              description: `Bank account: ${body.name}`,
            })
            .returning({ id: accounts.id });
          glAccountId = gl!.id;
        }
        const [row] = await tx
          .insert(bankAccounts)
          .values({ ...body, glAccountId })
          .returning();
        return row!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

// ---------- Statement import ----------

const importSchema = z.object({
  bankAccountId: z.string().uuid(),
  transactions: z
    .array(
      z.object({
        txnDate: dateStr,
        valueDate: dateStr.optional(),
        direction: z.enum(bankTxnDirection.enumValues),
        amount: money,
        utr: z.string().max(40).optional(),
        description: z.string().optional(),
        counterparty: z.string().optional(),
      }),
    )
    .min(1)
    .max(2000),
});

function txnHash(accountId: string, t: { txnDate: string; direction: string; amount: string; utr?: string; description?: string }) {
  return createHash("sha256")
    .update([accountId, t.txnDate, t.direction, t.amount, t.utr ?? "", t.description ?? ""].join("|"))
    .digest("hex");
}

/** Idempotent import: identical rows (by content hash) are skipped, not duplicated. */
bankingRouter.post(
  "/transactions/import",
  requirePermission("banking", "create"),
  validateBody(importSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof importSchema>;
    const result = await db.transaction(async (tx) => {
      const [bank] = await tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, body.bankAccountId))
        .limit(1);
      if (!bank) throw new PostingError("Bank account not found");

      let inserted = 0;
      let skipped = 0;
      for (const t of body.transactions) {
        const hash = txnHash(bank.id, t);
        const [existing] = await tx
          .select({ id: bankTransactions.id })
          .from(bankTransactions)
          .where(eq(bankTransactions.importHash, hash))
          .limit(1);
        if (existing) {
          skipped++;
          continue;
        }
        await tx.insert(bankTransactions).values({
          bankAccountId: bank.id,
          txnDate: t.txnDate,
          valueDate: t.valueDate,
          direction: t.direction,
          amount: t.amount,
          utr: t.utr,
          description: t.description,
          counterparty: t.counterparty,
          importHash: hash,
        });
        inserted++;
      }
      return { inserted, skipped };
    }).catch((err) => {
      if (err instanceof PostingError) return { error: err.message };
      throw err;
    });
    if ("error" in result) return res.status(422).json(result);
    res.status(201).json(result);
  },
);

bankingRouter.get(
  "/transactions",
  requirePermission("banking", "view"),
  async (req, res) => {
    const { bankAccountId, matchStatus, from, to } = req.query as Record<string, string | undefined>;
    const conditions = [];
    if (bankAccountId) conditions.push(eq(bankTransactions.bankAccountId, bankAccountId));
    if (matchStatus) {
      conditions.push(
        eq(bankTransactions.matchStatus, matchStatus as typeof bankTransactions.$inferSelect.matchStatus),
      );
    }
    if (from) conditions.push(gte(bankTransactions.txnDate, from));
    if (to) conditions.push(lte(bankTransactions.txnDate, to));
    const rows = await db
      .select()
      .from(bankTransactions)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(bankTransactions.txnDate))
      .limit(500);
    res.json(rows);
  },
);

// ---------- Categorize (create JE from a statement line) ----------

/**
 * Zoho "categorize": a statement credit becomes DR bank / CR chosen account,
 * a debit the reverse. Posts the JE and marks the line matched, atomically.
 */
bankingRouter.post(
  "/transactions/:id/categorize",
  requirePermission("banking", "create"),
  validateBody(z.object({ accountId: z.string().uuid(), narration: z.string().min(1) })),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const txn = await loadUnmatchedTxn(tx, req.params.id!);
        const [bank] = await tx
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, txn.bankAccountId))
          .limit(1);
        if (!bank) throw new PostingError("Bank account not found");

        const isCredit = txn.direction === "credit";
        const jeId = await postJournal(tx, {
          entryDate: txn.txnDate,
          narration: req.body.narration,
          reference: txn.utr ?? undefined,
          sourceType: "banking",
          sourceId: txn.id,
          postedBy: req.session.user!.id,
          lines: [
            {
              accountId: bank.glAccountId,
              [isCredit ? "debit" : "credit"]: txn.amount,
            } as never,
            {
              accountId: req.body.accountId,
              [isCredit ? "credit" : "debit"]: txn.amount,
            } as never,
          ],
        });
        const [updated] = await tx
          .update(bankTransactions)
          .set({
            matchStatus: "matched",
            matchedJournalEntryId: jeId,
            reconciledAt: new Date(),
          })
          .where(eq(bankTransactions.id, txn.id))
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

// ---------- Match to an existing journal entry ----------

/**
 * Match a statement line to an already-posted JE. Validated, not a prompt():
 * the JE must exist, be posted, be unmatched, and carry a line on this bank's
 * GL account with the same amount on the correct side.
 */
bankingRouter.post(
  "/transactions/:id/match",
  requirePermission("banking", "edit"),
  validateBody(z.object({ journalEntryId: z.string().uuid() })),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const txn = await loadUnmatchedTxn(tx, req.params.id!);
        const [bank] = await tx
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.id, txn.bankAccountId))
          .limit(1);
        if (!bank) throw new PostingError("Bank account not found");

        const je = await tx.query.journalEntries.findFirst({
          where: eq(journalEntries.id, req.body.journalEntryId),
        });
        if (!je) throw new PostingError("Journal entry not found");
        if (je.status !== "posted") throw new PostingError("Journal entry is not posted");

        const [alreadyMatched] = await tx
          .select({ id: bankTransactions.id })
          .from(bankTransactions)
          .where(eq(bankTransactions.matchedJournalEntryId, je.id))
          .limit(1);
        if (alreadyMatched) {
          throw new PostingError("Journal entry is already matched to another statement line");
        }

        // Statement credit = money in = a debit on the bank GL account.
        const wantDebitSide = txn.direction === "credit";
        const lines = await tx
          .select()
          .from(journalEntryLines)
          .where(
            and(
              eq(journalEntryLines.entryId, je.id),
              eq(journalEntryLines.accountId, bank.glAccountId),
            ),
          );
        const matchingLine = lines.find((l) => {
          const side = wantDebitSide ? l.debit : l.credit;
          return toPaise(side) === toPaise(txn.amount);
        });
        if (!matchingLine) {
          throw new PostingError(
            "Journal entry has no line on this bank account with a matching amount and side",
          );
        }

        const [updated] = await tx
          .update(bankTransactions)
          .set({
            matchStatus: "matched",
            matchedJournalEntryId: je.id,
            reconciledAt: new Date(),
          })
          .where(eq(bankTransactions.id, txn.id))
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

bankingRouter.post(
  "/transactions/:id/unmatch",
  requirePermission("banking", "edit"),
  async (req, res) => {
    const [updated] = await db
      .update(bankTransactions)
      .set({ matchStatus: "unmatched", matchedJournalEntryId: null, reconciledAt: null })
      .where(eq(bankTransactions.id, req.params.id!))
      .returning();
    if (!updated) return res.status(404).json({ error: "Transaction not found" });
    res.json(updated);
  },
);

bankingRouter.post(
  "/transactions/:id/exclude",
  requirePermission("banking", "edit"),
  async (req, res) => {
    const [updated] = await db
      .update(bankTransactions)
      .set({ matchStatus: "excluded" })
      .where(
        and(
          eq(bankTransactions.id, req.params.id!),
          eq(bankTransactions.matchStatus, "unmatched"),
        ),
      )
      .returning();
    if (!updated) {
      return res.status(422).json({ error: "Transaction not found or not unmatched" });
    }
    res.json(updated);
  },
);

async function loadUnmatchedTxn(tx: Tx, id: string) {
  const txn = await tx.query.bankTransactions.findFirst({
    where: eq(bankTransactions.id, id),
  });
  if (!txn) throw new PostingError("Bank transaction not found");
  if (txn.matchStatus !== "unmatched") {
    throw new PostingError(`Transaction is ${txn.matchStatus}, not unmatched`);
  }
  return txn;
}
