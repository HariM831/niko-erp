import { Router } from "express";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  bankAccounts,
  bankTransactions,
  bankTxnDirection,
  bills,
  contacts,
  creditNotes,
  customerPayments,
  expenses,
  invoices,
  journalEntries,
  journalEntryLines,
  vendorCredits,
  vendorPayments,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { nonBlank, validateBody } from "../lib/validate";
import { PostingError, postJournal } from "../services/posting";
import { toPaise } from "../services/documents";

/** journal source_type -> the document list/detail this account register links to. */
const SOURCE_DOC_BASE: Record<string, string> = {
  invoice: "/sales/invoices",
  customer_payment: "/sales/payments",
  credit_note: "/sales/credit-notes",
  bill: "/purchases/bills",
  vendor_payment: "/purchases/payments",
  vendor_credit: "/purchases/vendor-credits",
  expense: "/purchases/expenses",
};
const SOURCE_LABEL: Record<string, string> = {
  manual: "Journal Entry",
  invoice: "Invoice",
  customer_payment: "Customer Payment",
  credit_note: "Credit Note",
  bill: "Bill",
  vendor_payment: "Vendor Payment",
  vendor_credit: "Vendor Credit",
  expense: "Expense",
  inventory_adjustment: "Inventory Adjustment",
  opening_balance: "Opening Balance",
  depreciation: "Depreciation",
  banking: "Bank Entry",
};

export const bankingRouter = Router();

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------- Bank accounts ----------

const bankAccountSchema = z.object({
  name: nonBlank(),
  kind: z.enum(["bank", "cash", "card"]).optional(),
  bankName: z.string().optional(),
  accountNumber: z.string().max(30).optional(),
  ifsc: z.string().max(11).optional(),
  branch: z.string().optional(),
  /** Our customer code with the bank, printed on their bulk-payment file. */
  bankCustomerCode: z.string().max(20).optional(),
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
      bankCustomerCode: bankAccounts.bankCustomerCode,
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

const bankAccountEditSchema = z.object({
  name: z.string().min(1).optional(),
  kind: z.enum(["bank", "cash", "card"]).optional(),
  bankName: z.string().optional(),
  accountNumber: z.string().max(30).optional(),
  ifsc: z.string().max(11).optional(),
  branch: z.string().optional(),
  bankCustomerCode: z.string().max(20).optional(),
  isActive: z.boolean().optional(),
});

bankingRouter.get("/accounts/:id", requirePermission("banking", "view"), async (req, res) => {
  const row = await db.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, req.params.id!) });
  if (!row) return res.status(404).json({ error: "Bank account not found" });
  res.json(row);
});

bankingRouter.patch(
  "/accounts/:id",
  requirePermission("banking", "edit"),
  validateBody(bankAccountEditSchema),
  async (req, res) => {
    const [row] = await db
      .update(bankAccounts)
      .set(req.body)
      .where(eq(bankAccounts.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Bank account not found" });
    res.json(row);
  },
);

/** Dashboard tiles + per-account uncategorized count, for the Banking Overview page. */
bankingRouter.get("/summary", requirePermission("banking", "view"), async (_req, res) => {
  const rows = await db
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      kind: bankAccounts.kind,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      isActive: bankAccounts.isActive,
      amountInBooks: sql<string>`COALESCE((
        SELECT SUM(jel.debit - jel.credit)
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.entry_id
        WHERE jel.account_id = ${bankAccounts.glAccountId} AND je.status = 'posted'
      ), 0)::numeric(14,2)`,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.isActive, true))
    .orderBy(asc(bankAccounts.name));

  // Fetched separately and joined in JS: a correlated ${bankAccounts.id} reference inside a
  // bank_transactions subquery renders unqualified, which resolves to bank_transactions' own
  // "id" column instead of the outer account row (same pitfall as the contacts receivables query).
  const uncategorizedCounts = await db
    .select({ bankAccountId: bankTransactions.bankAccountId, count: sql<number>`COUNT(*)::int` })
    .from(bankTransactions)
    .where(eq(bankTransactions.matchStatus, "unmatched"))
    .groupBy(bankTransactions.bankAccountId);
  const uncategorizedByAccount = new Map(uncategorizedCounts.map((r) => [r.bankAccountId, r.count]));

  const withUncategorized = rows.map((r) => ({ ...r, uncategorized: uncategorizedByAccount.get(r.id) ?? 0 }));
  const cashInHand = rows.filter((r) => r.kind === "cash").reduce((s, r) => s + Number(r.amountInBooks), 0);
  const bankBalance = rows.filter((r) => r.kind !== "cash").reduce((s, r) => s + Number(r.amountInBooks), 0);

  res.json({
    cashInHand: cashInHand.toFixed(2),
    bankBalance: bankBalance.toFixed(2),
    accounts: withUncategorized,
  });
});

/** sourceType -> how to look up the counterparty's display name for the register's Type-cell subtitle. */
const PARTY_LOOKUPS: Record<
  string,
  { prefix: string; table: typeof invoices | typeof customerPayments | typeof creditNotes | typeof bills | typeof vendorPayments | typeof vendorCredits | typeof expenses; contactCol: "customerId" | "vendorId" }
> = {
  invoice: { prefix: "Customer", table: invoices, contactCol: "customerId" },
  customer_payment: { prefix: "Customer", table: customerPayments, contactCol: "customerId" },
  credit_note: { prefix: "Customer", table: creditNotes, contactCol: "customerId" },
  bill: { prefix: "Vendor", table: bills, contactCol: "vendorId" },
  vendor_payment: { prefix: "Vendor", table: vendorPayments, contactCol: "vendorId" },
  vendor_credit: { prefix: "Vendor", table: vendorCredits, contactCol: "vendorId" },
  expense: { prefix: "Vendor", table: expenses, contactCol: "vendorId" },
};

/** Batch-resolve "Customer: X" / "Vendor: X" subtitles for a set of (sourceType, sourceId) rows in a handful of queries. */
async function loadPartyLabels(rows: Array<{ sourceType: string; sourceId: string | null }>) {
  const byType = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.sourceId || !PARTY_LOOKUPS[r.sourceType]) continue;
    const ids = byType.get(r.sourceType) ?? [];
    ids.push(r.sourceId);
    byType.set(r.sourceType, ids);
  }

  const labels = new Map<string, string>();
  for (const [sourceType, ids] of byType) {
    const { prefix, table, contactCol } = PARTY_LOOKUPS[sourceType]!;
    const contactIdCol = contactCol === "customerId" ? (table as typeof invoices).customerId : (table as typeof bills).vendorId;
    const idCol = (table as typeof invoices).id;
    const found = await db
      .select({ docId: idCol, partyName: contacts.displayName })
      .from(table as typeof invoices)
      .innerJoin(contacts, eq(contacts.id, contactIdCol))
      .where(inArray(idCol, ids));
    for (const f of found) labels.set(`${sourceType}:${f.docId}`, `${prefix}: ${f.partyName}`);
  }
  return labels;
}

/**
 * Unified account register — every posted GL movement on this bank's
 * account, i.e. everything already "in the books" regardless of whether
 * it arrived via categorize/match or was posted directly by another
 * module (payments, expenses, journals...). This is what Zoho calls
 * "All Transactions"; imported-but-not-yet-posted statement lines are
 * the separate "Uncategorized Transactions" list.
 */
bankingRouter.get("/accounts/:id/register", requirePermission("banking", "view"), async (req, res) => {
  const bank = await db.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, req.params.id!) });
  if (!bank) return res.status(404).json({ error: "Bank account not found" });
  const { from, to } = req.query as Record<string, string | undefined>;

  const conditions = [eq(journalEntryLines.accountId, bank.glAccountId), eq(journalEntries.status, "posted")];
  if (from) conditions.push(gte(journalEntries.entryDate, from));
  if (to) conditions.push(lte(journalEntries.entryDate, to));

  const rows = await db
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      narration: journalEntries.narration,
      reference: journalEntries.reference,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      running: sql<string>`SUM(${journalEntryLines.debit} - ${journalEntryLines.credit}) OVER (ORDER BY ${journalEntries.entryDate}, ${journalEntries.postedAt}, ${journalEntryLines.lineOrder})::numeric(14,2)`,
      linkedTxnId: bankTransactions.id,
      linkedUtr: bankTransactions.utr,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
    .leftJoin(bankTransactions, eq(bankTransactions.matchedJournalEntryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntryLines.lineOrder));

  const partyLabels = await loadPartyLabels(rows);

  const withLinks = rows.map((r) => {
    const base = SOURCE_DOC_BASE[r.sourceType];
    const docId = base && r.sourceId ? r.sourceId : r.entryId;
    const docPath = base && r.sourceId ? `${base}/${r.sourceId}` : `/accountant/journals/${r.entryId}`;

    let status: "Categorized" | "Matched" | "Manually Added" = "Manually Added";
    if (r.linkedTxnId) {
      status = r.sourceType === "banking" && r.sourceId === r.linkedTxnId ? "Categorized" : "Matched";
    }

    let party = partyLabels.get(`${r.sourceType}:${r.sourceId}`) ?? null;
    if (!party && r.sourceType === "banking" && r.narration.startsWith("Transfer: ")) {
      party = r.narration.slice("Transfer: ".length);
    }

    return {
      entryId: r.entryId,
      entryNumber: r.entryNumber,
      entryDate: r.entryDate,
      narration: r.narration,
      reference: r.linkedUtr ?? r.reference ?? null,
      debit: r.debit,
      credit: r.credit,
      running: r.running,
      typeLabel: SOURCE_LABEL[r.sourceType] ?? r.sourceType,
      party,
      status,
      docPath,
      docId,
    };
  });

  res.json({ account: bank, rows: withLinks });
});

// ---------- Transfers & quick entries ----------

const transferSchema = z.object({
  fromBankAccountId: z.string().uuid(),
  toBankAccountId: z.string().uuid(),
  amount: money,
  date: dateStr,
  reference: z.string().optional(),
});

bankingRouter.post(
  "/transfer",
  requirePermission("banking", "create"),
  validateBody(transferSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof transferSchema>;
    if (body.fromBankAccountId === body.toBankAccountId) {
      return res.status(422).json({ error: "Source and destination accounts must be different" });
    }
    try {
      const jeId = await db.transaction(async (tx) => {
        const [from, to] = await Promise.all([
          tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, body.fromBankAccountId) }),
          tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, body.toBankAccountId) }),
        ]);
        if (!from || !to) throw new PostingError("Bank account not found");
        return postJournal(tx, {
          entryDate: body.date,
          narration: `Transfer: ${from.name} → ${to.name}${body.reference ? ` (${body.reference})` : ""}`,
          sourceType: "banking",
          postedBy: req.session.user!.id,
          lines: [
            { accountId: to.glAccountId, debit: body.amount },
            { accountId: from.glAccountId, credit: body.amount },
          ],
        });
      });
      res.status(201).json({ journalEntryId: jeId });
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

const quickEntrySchema = z.object({
  bankAccountId: z.string().uuid(),
  direction: z.enum(["in", "out"]),
  amount: money,
  date: dateStr,
  contraAccountId: z.string().uuid(),
  description: z.string().optional(),
});

/** "Record Deposit" / generic quick money in-out without an imported statement line. */
bankingRouter.post(
  "/entries",
  requirePermission("banking", "create"),
  validateBody(quickEntrySchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof quickEntrySchema>;
    try {
      const jeId = await db.transaction(async (tx) => {
        const bank = await tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, body.bankAccountId) });
        if (!bank) throw new PostingError("Bank account not found");
        const isIn = body.direction === "in";
        return postJournal(tx, {
          entryDate: body.date,
          narration: body.description || `${isIn ? "Deposit" : "Withdrawal"} - ${bank.name}`,
          sourceType: "banking",
          postedBy: req.session.user!.id,
          lines: [
            { accountId: bank.glAccountId, [isIn ? "debit" : "credit"]: body.amount } as never,
            { accountId: body.contraAccountId, [isIn ? "credit" : "debit"]: body.amount } as never,
          ],
        });
      });
      res.status(201).json({ journalEntryId: jeId });
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
