import { Router } from "express";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { type DocumentSearch, advancedSearch, matches } from "../services/document-search";
import { z } from "zod";
import {
  accounts,
  bankAccounts,
  bankTransactionLinks,
  bankTransactions,
  bankTxnDirection,
  bills,
  attachments,
  contacts,
  creditNotes,
  customFieldValues,
  employees,
  payrollRuns,
  salarySlips,
  customerPayments,
  expenses,
  invoices,
  journalEntries,
  journalEntryLines,
  journalSourceType,
  vendorCredits,
  vendorPayments,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { nonBlank, validateBody } from "../lib/validate";
import { addDays, istDate } from "../services/day-resolution";
import { PostingError, assertPeriodOpen, postJournal } from "../services/posting";
import { toPaise } from "../services/documents";
import { assertLineFits, linkStatementLine, pickConfident, sharesBankRef, suggestLearned, suggestParties } from "../services/bank-links";
import { deleteCustomerPayment } from "./sales";
import { deleteVendorPayment } from "./purchases";

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

bankingRouter.get("/accounts", requirePermission("banking", "view"), async (req, res) => {
  // The top-bar search, by the rule every list follows.
  const search = (req.query.search as string | undefined)?.trim();
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
    .where(
      search
        ? or(
            matches(bankAccounts.name, search),
            matches(bankAccounts.bankName, search),
            matches(bankAccounts.accountNumber, search),
          )
        : undefined,
    )
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

/**
 * Cash in hand and bank balance at the close of each of the last 30 days —
 * the Banking Overview's chart, which Zoho shows behind a Show Chart link.
 * The same split as /summary: active accounts, posted lines, cash kind
 * against everything else. Daily movements are summed in SQL; the running
 * balance is walked here from each kind's balance before the window.
 */
bankingRouter.get("/summary/chart", requirePermission("banking", "view"), async (_req, res) => {
  const today = istDate();
  const start = addDays(today, -29);
  const rows = (await db.execute(sql`
    SELECT ${bankAccounts.kind} AS kind, ${journalEntries.entryDate}::text AS day, SUM(${journalEntryLines.debit} - ${journalEntryLines.credit})::numeric(16,2) AS amount
    FROM ${bankAccounts}
    JOIN ${journalEntryLines} ON ${journalEntryLines.accountId} = ${bankAccounts.glAccountId}
    JOIN ${journalEntries} ON ${journalEntries.id} = ${journalEntryLines.entryId}
    WHERE ${bankAccounts.isActive} AND ${journalEntries.status} = 'posted' AND ${journalEntries.entryDate} <= ${today}
    GROUP BY 1, 2
  `)).rows as Array<{ kind: string; day: string; amount: string }>;
  let cash = 0;
  let bank = 0;
  const byDay = new Map<string, { cash: number; bank: number }>();
  for (const r of rows) {
    const amt = Number(r.amount);
    const isCash = r.kind === "cash";
    if (r.day < start) {
      if (isCash) cash += amt;
      else bank += amt;
      continue;
    }
    const d = byDay.get(r.day) ?? { cash: 0, bank: 0 };
    if (isCash) d.cash += amt;
    else d.bank += amt;
    byDay.set(r.day, d);
  }
  const days: Array<{ day: string; cashInHand: number; bankBalance: number }> = [];
  for (let day = start; day <= today; day = addDays(day, 1)) {
    const d = byDay.get(day);
    if (d) {
      cash += d.cash;
      bank += d.bank;
    }
    days.push({ day, cashInHand: Math.round(cash * 100) / 100, bankBalance: Math.round(bank * 100) / 100 });
  }
  res.json({ days });
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
export async function loadPartyLabels(rows: Array<{ sourceType: string; sourceId: string | null }>) {
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
      linkKind: bankTransactionLinks.kind,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
    .leftJoin(
      bankTransactionLinks,
      and(eq(bankTransactionLinks.journalEntryId, journalEntries.id), eq(bankTransactionLinks.bankAccountId, bank.id)),
    )
    .leftJoin(bankTransactions, eq(bankTransactions.id, bankTransactionLinks.bankTransactionId))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntryLines.lineOrder));

  const partyLabels = await loadPartyLabels(rows);

  const withLinks = rows.map((r) => {
    const base = SOURCE_DOC_BASE[r.sourceType];
    const docId = base && r.sourceId ? r.sourceId : r.entryId;
    const docPath = base && r.sourceId ? `${base}/${r.sourceId}` : `/accountant/journals/${r.entryId}`;

    let status: "Categorized" | "Matched" | "Manually Added" = "Manually Added";
    if (r.linkedTxnId) status = r.linkKind === "categorized" ? "Categorized" : "Matched";

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
      // The raw kind as well as its label, so the page's advanced search can
      // filter by Transaction Type without matching on display text.
      sourceType: r.sourceType,
      party,
      status,
      // The statement line it is matched to, for Unmatch / Uncategorize.
      statementLineId: r.linkedTxnId ?? null,
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
  /** Made from this statement line (Categorize Manually); it is linked in the same transaction. */
  bankTransactionId: z.string().uuid().optional(),
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
        const line = body.bankTransactionId ? await tx.query.bankTransactions.findFirst({ where: eq(bankTransactions.id, body.bankTransactionId) }) : undefined;
        if (line) {
          const ours = line.direction === "debit" ? from.id : to.id;
          await assertLineFits(tx, line.id, { bankAccountId: ours, date: body.date });
        }
        const jeId = await postJournal(tx, {
          entryDate: body.date,
          narration: `Transfer: ${from.name} → ${to.name}${body.reference ? ` (${body.reference})` : ""}`,
          reference: body.reference,
          sourceType: "banking",
          postedBy: req.session.user!.id,
          lines: [
            { accountId: to.glAccountId, debit: body.amount },
            { accountId: from.glAccountId, credit: body.amount },
          ],
        });
        if (line) await linkStatementLine(tx, { bankTransactionId: line.id, journalEntryIds: [jeId], kind: "categorized" });
        return jeId;
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

/**
 * The statement side of the account page's advanced search — Zoho's "Search
 * In: Statement". It searches the lines imported from the bank, whatever became
 * of them, with the same boxes the Transactions side offers:
 *
 * - Status: a line still waiting is Uncategorized; one turned into its own
 *   journal here is Categorized; one paired with a document already in the
 *   books is Matched; Excluded is excluded. "Manually Added" describes an entry
 *   typed into the books without a statement line, so no line ever is one.
 * - Transaction Type: Deposit and Withdrawal read the line's direction; the
 *   document kinds read the journal the line was matched to, so "Vendor
 *   Payment" finds the statement lines that paid a vendor.
 */
const statementSearch: DocumentSearch = {
  advanced: {
    date: { kind: "dateRange", col: bankTransactions.txnDate },
    total: { kind: "numberRange", col: bankTransactions.amount },
    reference: { kind: "text", col: bankTransactions.utr },
    status: {
      kind: "custom",
      build: (get) => {
        const v = get("status");
        if (!v) return undefined;
        if (v === "uncategorized") return eq(bankTransactions.matchStatus, "unmatched");
        if (v === "excluded") return eq(bankTransactions.matchStatus, "excluded");
        if (v === "categorized" || v === "matched") {
          return and(
            eq(bankTransactions.matchStatus, "matched"),
            inArray(
              bankTransactions.id,
              db
                .select({ id: bankTransactionLinks.bankTransactionId })
                .from(bankTransactionLinks)
                .where(eq(bankTransactionLinks.kind, v)),
            ),
          );
        }
        return sql`false`;
      },
    },
    type: {
      kind: "custom",
      build: (get) => {
        const v = get("type");
        if (!v) return undefined;
        if (v === "deposit") return eq(bankTransactions.direction, "credit");
        if (v === "withdrawal") return eq(bankTransactions.direction, "debit");
        const linesOf = (where: ReturnType<typeof sql>) =>
          inArray(
            bankTransactions.id,
            db
              .select({ id: bankTransactionLinks.bankTransactionId })
              .from(bankTransactionLinks)
              .innerJoin(journalEntries, eq(journalEntries.id, bankTransactionLinks.journalEntryId))
              .where(where),
          );
        if (v === "transfer") {
          return linesOf(sql`${journalEntries.sourceType} = 'banking' AND ${journalEntries.narration} LIKE 'Transfer: %'`);
        }
        if (!(journalSourceType.enumValues as readonly string[]).includes(v)) return sql`false`;
        return linesOf(sql`${journalEntries.sourceType} = ${v}`);
      },
    },
  },
};

bankingRouter.get(
  "/transactions",
  requirePermission("banking", "view"),
  async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const { bankAccountId, matchStatus, from, to } = query;
    const conditions = [];
    if (bankAccountId) conditions.push(eq(bankTransactions.bankAccountId, bankAccountId));
    if (matchStatus) {
      conditions.push(
        eq(bankTransactions.matchStatus, matchStatus as typeof bankTransactions.$inferSelect.matchStatus),
      );
    }
    if (from) conditions.push(gte(bankTransactions.txnDate, from));
    if (to) conditions.push(lte(bankTransactions.txnDate, to));
    const advanced = advancedSearch(statementSearch, query);
    conditions.push(...advanced);
    const rows = db
      .select()
      .from(bankTransactions)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(bankTransactions.txnDate));
    // A search is not capped, for the reason listLimit gives: a truncated
    // result answers "no such line" when the line exists.
    const lines = advanced.length ? await rows : await rows.limit(500);
    res.json(await withLinkInfo(lines));
  },
);

/**
 * Every narration already tied to a party, which is what the learned names
 * are read from: the statement lines somebody categorized, and the reference
 * on every receipt and payment. Both say "this text was this party".
 *
 * Kept for a minute. It only changes when somebody categorizes something, and
 * rebuilding it per keystroke on the Categorize screen would read four
 * thousand rows to answer one question.
 */
let corpusAt = 0;
let corpusRows: Array<{ partyId: string; displayName: string; text: string; side: string }> = [];
let houseAccounts: string[] = [];
async function learnedCorpus() {
  if (Date.now() - corpusAt < 60_000 && corpusRows.length) return corpusRows;
  corpusRows = (
    await db.execute(sql`
      SELECT c.id::text AS party_id, c.display_name, p.reference AS text, 'customer' AS side
        FROM customer_payments p JOIN contacts c ON c.id = p.customer_id
       WHERE p.reference IS NOT NULL
      UNION ALL
      SELECT c.id::text, c.display_name, p.reference, 'vendor'
        FROM vendor_payments p JOIN contacts c ON c.id = p.vendor_id
       WHERE p.reference IS NOT NULL
      UNION ALL
      SELECT c.id::text, c.display_name, t.description,
             CASE WHEN j.source_type = 'vendor_payment' THEN 'vendor' ELSE 'customer' END
        FROM bank_transactions t
        JOIN bank_transaction_links l ON l.bank_transaction_id = t.id
        JOIN journal_entries j ON j.id = l.journal_entry_id
        LEFT JOIN customer_payments cp ON cp.id = j.source_id AND j.source_type = 'customer_payment'
        LEFT JOIN vendor_payments vp ON vp.id = j.source_id AND j.source_type = 'vendor_payment'
        JOIN contacts c ON c.id = coalesce(cp.customer_id, vp.vendor_id)
       WHERE t.description IS NOT NULL
    `)
  ).rows as typeof corpusRows;
  houseAccounts = (
    await db.select({ n: bankAccounts.accountNumber }).from(bankAccounts)
  ).map((r) => r.n ?? "");
  corpusAt = Date.now();
  return corpusRows;
}

/** The names of the customers and vendors each line spells out or carries the account number of. */
export async function linePartyNames(lines: Array<{ id: string; description: string | null; utr: string | null; counterparty: string | null }>) {
  const out = new Map<string, Set<string>>();
  if (!lines.length) return out;
  const people = await db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      companyName: contacts.companyName,
      beneficiary: contacts.bankBeneficiaryName,
      accountNumber: contacts.bankAccountNumber,
    })
    .from(contacts)
    .where(and(eq(contacts.isActive, true), eq(contacts.isGroupCompany, false)));
  const seen = await learnedCorpus();
  for (const l of lines) {
    const text = `${l.description ?? ""} ${l.utr ?? ""} ${l.counterparty ?? ""}`;
    const found = [...suggestParties(text, people), ...suggestLearned(text, seen, houseAccounts)];
    out.set(l.id, new Set(found.map((f) => f.displayName)));
  }
  return out;
}

/**
 * Does a transaction's party ("Customer: NB Traders") agree with the names a
 * line carries? "same" when it is one of them, "other" when the line names
 * someone else, undefined when either side names nobody.
 */
export function partyVerdict(label: string | null | undefined, names: Set<string> | undefined) {
  if (!label || !names?.size) return undefined;
  const name = label.slice(label.indexOf(": ") + 2);
  return names.has(name) ? ("same" as const) : ("other" as const);
}

/**
 * Each line with what it stands for in the books, and for a line still
 * uncategorized whether exactly one transaction in the books fits it — Zoho's
 * "Match found" tag: same bank, same side, the very amount, within three days (a week-old receipt of the same sum is
 * usually the week before's, not this one), not
 * matched to anything yet.
 */
/**
 * For each line, the posted transactions on its bank that fit it exactly:
 * the very amount on the same side, within `days` of it, not matched on this
 * bank yet. One query for the lot, however many lines.
 */
export async function exactFits(lineIds: string[], days: number) {
  if (!lineIds.length) return [];
  const rows = await db.execute(sql`
    SELECT t.id AS line_id, je.id AS entry_id, je.entry_number, je.entry_date::text AS entry_date,
           je.reference, je.source_type, je.source_id
      FROM bank_transactions t
      JOIN bank_accounts b ON b.id = t.bank_account_id
      JOIN journal_entries je ON je.status = 'posted' AND NOT je.is_reversal
        AND je.entry_date BETWEEN t.txn_date - ${days}::int AND t.txn_date + ${days}::int
      JOIN journal_entry_lines l ON l.entry_id = je.id AND l.account_id = b.gl_account_id
      WHERE t.id IN (${sql.join(lineIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND NOT EXISTS (SELECT 1 FROM bank_transaction_links k WHERE k.journal_entry_id = je.id AND k.bank_account_id = b.id)
      GROUP BY t.id, t.direction, t.amount, je.id
      HAVING SUM(l.debit - l.credit) = CASE WHEN t.direction = 'credit' THEN t.amount ELSE -t.amount END`);
  return rows.rows as Array<{
    line_id: string;
    entry_id: string;
    entry_number: string;
    entry_date: string;
    reference: string | null;
    source_type: string;
    source_id: string | null;
  }>;
}

export const lineText = (l: { description: string | null; utr: string | null; counterparty: string | null }) =>
  `${l.description ?? ""} ${l.utr ?? ""} ${l.counterparty ?? ""}`;

async function withLinkInfo(lines: Array<typeof bankTransactions.$inferSelect>) {
  if (!lines.length) return [];
  const ids = lines.map((l) => l.id);
  const links = await db
    .select({ lineId: bankTransactionLinks.bankTransactionId, journalEntryId: bankTransactionLinks.journalEntryId, kind: bankTransactionLinks.kind })
    .from(bankTransactionLinks)
    .where(inArray(bankTransactionLinks.bankTransactionId, ids));
  const openLines = lines.filter((l) => l.matchStatus === "unmatched");
  const fits = new Map<string, number>();
  if (openLines.length) {
    const exact = await exactFits(openLines.map((l) => l.id), 3);
    const labels = await loadPartyLabels(exact.map((r) => ({ sourceType: r.source_type, sourceId: r.source_id })));
    const named = await linePartyNames(openLines);
    // Two customers paid ₹2,62,013 on the same day: the amount alone would
    // tag both lines with the one receipt. A line that names its payer only
    // fits a receipt from that payer.
    for (const r of exact) {
      if (partyVerdict(labels.get(`${r.source_type}:${r.source_id}`), named.get(r.line_id)) === "other") continue;
      fits.set(r.line_id, (fits.get(r.line_id) ?? 0) + 1);
    }
  }
  return lines.map((l) => ({
    ...l,
    links: links.filter((k) => k.lineId === l.id).map(({ lineId: _l, ...k }) => k),
    matchFound: fits.get(l.id) === 1,
  }));
}

// ---------- Auto-match ----------

/**
 * Auto-match, the preview: every uncategorized line on this account that has
 * exactly one confident fit (see pickConfident), with the transaction it
 * would be matched to and why. Nothing is matched until the person confirms.
 */
bankingRouter.get("/accounts/:id/auto-match", requirePermission("banking", "view"), async (req, res) => {
  const lines = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.bankAccountId, req.params.id!), eq(bankTransactions.matchStatus, "unmatched")))
    .orderBy(asc(bankTransactions.txnDate));
  const exact = await exactFits(lines.map((l) => l.id), 3);
  const labels = await loadPartyLabels(exact.map((r) => ({ sourceType: r.source_type, sourceId: r.source_id })));
  const named = await linePartyNames(lines);
  const byLine = new Map(lines.map((l) => [l.id, l]));
  const signals = exact.map((r) => ({
    lineId: r.line_id,
    entryId: r.entry_id,
    party: partyVerdict(labels.get(`${r.source_type}:${r.source_id}`), named.get(r.line_id)),
    sharedRef: sharesBankRef(r.reference, lineText(byLine.get(r.line_id)!)),
  }));
  const entry = new Map(exact.map((r) => [`${r.line_id}:${r.entry_id}`, r]));
  const proposals = pickConfident(signals).map((p) => {
    const l = byLine.get(p.lineId)!;
    const e = entry.get(`${p.lineId}:${p.entryId}`)!;
    const base = SOURCE_DOC_BASE[e.source_type];
    return {
      line: { id: l.id, date: l.txnDate, direction: l.direction, amount: l.amount, description: l.description, utr: l.utr },
      match: {
        journalEntryId: e.entry_id,
        entryNumber: e.entry_number,
        date: e.entry_date,
        typeLabel: SOURCE_LABEL[e.source_type] ?? e.source_type,
        party: labels.get(`${e.source_type}:${e.source_id}`) ?? null,
        reference: e.reference,
        docPath: base && e.source_id ? `${base}/${e.source_id}` : `/accountant/journals/${e.entry_id}`,
      },
      sameRef: p.sameRef,
      samePayer: p.samePayer,
    };
  });
  res.json({ uncategorized: lines.length, proposals });
});

/**
 * Auto-match, confirmed: the pairs the person ticked. Each is matched on its
 * own, with the same checks as matching by hand, so one that no longer fits
 * (matched meanwhile, or edited) is reported and the rest still go through.
 */
bankingRouter.post(
  "/accounts/:id/auto-match",
  requirePermission("banking", "edit"),
  validateBody(
    z.object({
      pairs: z.array(z.object({ bankTransactionId: z.string().uuid(), journalEntryId: z.string().uuid() })).min(1).max(2000),
    }),
  ),
  async (req, res) => {
    let matched = 0;
    const failed: Array<{ bankTransactionId: string; error: string }> = [];
    for (const p of req.body.pairs as Array<{ bankTransactionId: string; journalEntryId: string }>) {
      try {
        await db.transaction(async (tx) => {
          const line = await tx.query.bankTransactions.findFirst({ where: eq(bankTransactions.id, p.bankTransactionId) });
          if (!line || line.bankAccountId !== req.params.id) throw new PostingError("Statement line is not on this account");
          await linkStatementLine(tx, { bankTransactionId: p.bankTransactionId, journalEntryIds: [p.journalEntryId], kind: "matched" });
        });
        matched++;
      } catch (err) {
        if (!(err instanceof PostingError)) throw err;
        failed.push({ bankTransactionId: p.bankTransactionId, error: err.message });
      }
    }
    res.json({ matched, failed });
  },
);

// ---------- Categorize, match, unmatch (Zoho's statement-line pane) ----------

/**
 * Heads a line may not be categorized to as a bare journal. Receivables and
 * payables belong to a customer or vendor: money in from one is a Customer
 * Payment or Advance, out to one a Vendor Payment or Advance, or it lands in
 * the ledger against nobody.
 */
const PARTY_KEYS = new Set(["ar", "ap", "customer_advances", "vendor_advances"]);

/**
 * Categorize to an account (Interest Income, Other Income, Owner's
 * Contribution, Owner Drawings and the rest): the line against the chosen
 * head, made from the line and linked to it.
 */
bankingRouter.post(
  "/transactions/:id/categorize",
  requirePermission("banking", "create"),
  validateBody(z.object({ accountId: z.string().uuid(), narration: z.string().min(1) })),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const txn = await loadUnmatchedTxn(tx, req.params.id!);
        const bank = await tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, txn.bankAccountId) });
        if (!bank) throw new PostingError("Bank account not found");
        const account = await tx.query.accounts.findFirst({ where: eq(accounts.id, req.body.accountId) });
        if (!account) throw new PostingError("Account not found");
        if (account.systemKey && PARTY_KEYS.has(account.systemKey)) {
          throw new PostingError(
            `${account.name} carries a customer or vendor — categorize this as a ${txn.direction === "credit" ? "Customer Payment or Customer Advance" : "Vendor Payment or Vendor Advance"} instead`,
          );
        }
        const asBank = await tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.glAccountId, account.id) });
        if (asBank) throw new PostingError(`${asBank.name} is a bank account — categorize this as a transfer`);

        const isCredit = txn.direction === "credit";
        const jeId = await postJournal(tx, {
          entryDate: txn.txnDate,
          narration: req.body.narration,
          reference: txn.utr ?? undefined,
          sourceType: "banking",
          sourceId: txn.id,
          postedBy: req.session.user!.id,
          lines: [
            { accountId: bank.glAccountId, [isCredit ? "debit" : "credit"]: txn.amount } as never,
            { accountId: account.id, [isCredit ? "credit" : "debit"]: txn.amount } as never,
          ],
        });
        return linkStatementLine(tx, { bankTransactionId: txn.id, journalEntryIds: [jeId], kind: "categorized" });
      });
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

/**
 * Match a line to transactions already in the books: one, or several that
 * together move this bank by exactly the line.
 */
bankingRouter.post(
  "/transactions/:id/match",
  requirePermission("banking", "edit"),
  validateBody(z.object({ journalEntryIds: z.array(z.string().uuid()).min(1).max(50) })),
  async (req, res) => {
    try {
      const result = await db.transaction((tx) =>
        linkStatementLine(tx, { bankTransactionId: req.params.id!, journalEntryIds: req.body.journalEntryIds, kind: "matched" }),
      );
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

const fromPaiseStr = (p: number) => (p / 100).toFixed(2);
const dayDiff = (a: string, b: string) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Zoho's Possible Matches: posted transactions on this bank, not yet matched
 * here, on the line's side and no larger than it (several may be added up),
 * dated near it. The closest come first: the exact amount, then a shared
 * reference, then the nearest date. The filter widens or narrows the search.
 */
bankingRouter.get("/transactions/:id/possible-matches", requirePermission("banking", "view"), async (req, res) => {
  const line = await db.query.bankTransactions.findFirst({ where: eq(bankTransactions.id, req.params.id!) });
  if (!line) return res.status(404).json({ error: "Bank statement line not found" });
  const bank = await db.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, line.bankAccountId) });
  if (!bank) return res.status(404).json({ error: "Bank account not found" });
  const q = req.query as Record<string, string | undefined>;
  const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const isMoney = (v?: string) => !!v && /^\d+(\.\d{1,2})?$/.test(v);
  const from = isDate(q.from) ? q.from! : addDays(line.txnDate, -7);
  const to = isDate(q.to) ? q.to! : addDays(line.txnDate, 7);
  const lineP = toPaise(line.amount);
  const minP = isMoney(q.min) ? toPaise(q.min!) : 0;
  const maxP = isMoney(q.max) ? toPaise(q.max!) : lineP;
  const wantDebit = line.direction === "credit";
  const both = q.includeOpposite === "true";

  const net = sql<string>`SUM(${journalEntryLines.debit} - ${journalEntryLines.credit})::numeric(14,2)`;
  const rows = await db
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      narration: journalEntries.narration,
      reference: journalEntries.reference,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      net,
    })
    .from(journalEntries)
    .innerJoin(journalEntryLines, eq(journalEntryLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalEntryLines.accountId, bank.glAccountId),
        eq(journalEntries.status, "posted"),
        eq(journalEntries.isReversal, false),
        gte(journalEntries.entryDate, from),
        lte(journalEntries.entryDate, to),
        q.type && (journalSourceType.enumValues as readonly string[]).includes(q.type)
          ? sql`${journalEntries.sourceType} = ${q.type}`
          : undefined,
        sql`NOT EXISTS (SELECT 1 FROM bank_transaction_links k WHERE k.journal_entry_id = ${journalEntries.id} AND k.bank_account_id = ${bank.id})`,
      ),
    )
    .groupBy(journalEntries.id)
    .having(sql`${net} <> 0`);

  const labels = await loadPartyLabels(rows);
  const named = (await linePartyNames([line])).get(line.id);
  const text = (q.contact ?? "").trim().toLowerCase();
  const ref = (q.reference ?? "").trim().toLowerCase();
  const candidates = rows
    .map((r) => {
      const p = toPaise(r.net);
      const party = labels.get(`${r.sourceType}:${r.sourceId}`) ?? null;
      const base = SOURCE_DOC_BASE[r.sourceType];
      return {
        journalEntryId: r.entryId,
        entryNumber: r.entryNumber,
        date: r.entryDate,
        typeLabel: SOURCE_LABEL[r.sourceType] ?? r.sourceType,
        sourceType: r.sourceType,
        docPath: base && r.sourceId ? `${base}/${r.sourceId}` : `/accountant/journals/${r.entryId}`,
        party,
        narration: r.narration,
        reference: r.reference,
        direction: p > 0 ? ("credit" as const) : ("debit" as const),
        amount: fromPaiseStr(Math.abs(p)),
        exact: Math.abs(p) === lineP && p > 0 === wantDebit,
        sharedRef: sharesBankRef(r.reference, lineText(line)),
        party_: partyVerdict(party, named),
        days: Math.abs(dayDiff(r.entryDate, line.txnDate)),
        p,
      };
    })
    .filter((c) => both || c.p > 0 === wantDebit)
    .filter((c) => Math.abs(c.p) >= minP && Math.abs(c.p) <= maxP)
    .filter((c) => !text || (c.party ?? "").toLowerCase().includes(text) || c.narration.toLowerCase().includes(text))
    .filter((c) => !ref || (c.reference ?? "").toLowerCase().includes(ref) || c.entryNumber.toLowerCase().includes(ref))
    // The closest first: the very amount from the payer the line names, then
    // the payer, then a shared reference, then the amount, then the date.
    .sort(
      (a, b) =>
        Number(b.exact && b.party_ !== "other") - Number(a.exact && a.party_ !== "other") ||
        Number(b.party_ === "same") - Number(a.party_ === "same") ||
        Number(b.sharedRef) - Number(a.sharedRef) ||
        Number(b.exact) - Number(a.exact) ||
        a.days - b.days,
    )
    .slice(0, 100)
    .map(({ p: _p, party_, ...c }) => ({ ...c, sameParty: party_ === "same", otherParty: party_ === "other" }));
  res.json({ from, to, candidates });
});

/**
 * Who a statement line is probably from or to: a customer or vendor whose
 * bank account number the line carries, or whose name it spells out.
 * Offered at the top of the picker; never chosen for anyone.
 */
bankingRouter.get("/transactions/:id/party-suggestions", requirePermission("banking", "view"), async (req, res) => {
  const line = await db.query.bankTransactions.findFirst({ where: eq(bankTransactions.id, req.params.id!) });
  if (!line) return res.status(404).json({ error: "Bank statement line not found" });
  const side = req.query.side === "vendor" ? "vendor" : "customer";
  const people = await db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      companyName: contacts.companyName,
      beneficiary: contacts.bankBeneficiaryName,
      accountNumber: contacts.bankAccountNumber,
    })
    .from(contacts)
    .where(and(inArray(contacts.type, [side, "both"]), eq(contacts.isActive, true), eq(contacts.isGroupCompany, false)));
  const text = `${line.description ?? ""} ${line.utr ?? ""} ${line.counterparty ?? ""}`;
  const named = suggestParties(text, people);
  /**
   * The name on the account comes first — it is what we invoice them under —
   * and the names they have actually paid under follow, which is how SANKET S
   * reaches SS Food. A party already suggested is not suggested twice.
   */
  const known = new Set(named.map((n) => n.id));
  const allowed = new Set(people.map((p) => p.id));
  const learned = suggestLearned(text, (await learnedCorpus()).filter((r) => r.side === side), houseAccounts)
    .filter((l) => !known.has(l.id) && allowed.has(l.id));
  res.json([...named, ...learned].slice(0, 6));
});

// ---------- Salary Payment (a payslip paid from the bank) ----------

/**
 * Payslips a salary transfer could be paying: confirmed runs whose journal
 * owes the pay in Salary Payable, from the line's month and the three before,
 * not paid yet, net pay to the rupee. The employee the line names (or whose
 * bank account it carries) first.
 */
async function salaryCandidates(tx: Tx | typeof db, line: typeof bankTransactions.$inferSelect) {
  const [y, m] = line.txnDate.split("-").map(Number) as [number, number];
  const ym = y * 12 + (m - 1);
  const rows = await tx
    .select({
      slipId: salarySlips.id,
      employeeId: employees.id,
      employeeName: employees.name,
      accountNumber: salarySlips.bankAccountNumber,
      netPay: salarySlips.netPay,
      month: payrollRuns.month,
      year: payrollRuns.year,
    })
    .from(salarySlips)
    .innerJoin(payrollRuns, eq(payrollRuns.id, salarySlips.payrollRunId))
    .innerJoin(employees, eq(employees.id, salarySlips.employeeId))
    .where(
      and(
        eq(payrollRuns.status, "confirmed"),
        sql`${payrollRuns.journalEntryId} IS NOT NULL`,
        sql`${salarySlips.paidJournalEntryId} IS NULL`,
        eq(salarySlips.netPay, line.amount),
        sql`${payrollRuns.year} * 12 + ${payrollRuns.month} - 1 BETWEEN ${ym - 3} AND ${ym}`,
      ),
    );
  const named = new Map(
    suggestParties(
      `${line.description ?? ""} ${line.utr ?? ""} ${line.counterparty ?? ""}`,
      rows.map((r) => ({ id: r.slipId, displayName: r.employeeName, accountNumber: r.accountNumber })),
    ).map((s) => [s.id, s.reason]),
  );
  return rows
    .map((r) => ({
      slipId: r.slipId,
      employeeName: r.employeeName,
      month: r.month,
      year: r.year,
      netPay: r.netPay,
      reason: named.get(r.slipId) ?? null,
    }))
    .sort((a, b) => Number(!!b.reason) - Number(!!a.reason) || b.year * 12 + b.month - (a.year * 12 + a.month));
}

bankingRouter.get("/transactions/:id/salary-suggestions", requirePermission("banking", "view"), async (req, res) => {
  const line = await db.query.bankTransactions.findFirst({ where: eq(bankTransactions.id, req.params.id!) });
  if (!line) return res.status(404).json({ error: "Bank statement line not found" });
  if (line.direction !== "debit") return res.json([]);
  res.json(await salaryCandidates(db, line));
});

/**
 * Pay a payslip from a statement line: Salary Payable against the bank. The
 * month's run already put the pay in Salary Payable and the expense in
 * salaries; this only says it left the bank, so posting it to an expense
 * would count the month twice.
 */
bankingRouter.post(
  "/transactions/:id/salary-payment",
  requirePermission("banking", "create"),
  validateBody(z.object({ salarySlipId: z.string().uuid(), reference: z.string().max(100).optional() })),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const txn = await loadUnmatchedTxn(tx, req.params.id!);
        if (txn.direction !== "debit") throw new PostingError("A salary payment is money out — this line is a deposit");
        const bank = await tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, txn.bankAccountId) });
        if (!bank) throw new PostingError("Bank account not found");
        const slip = (await salaryCandidates(tx, txn)).find((c) => c.slipId === req.body.salarySlipId);
        if (!slip) {
          throw new PostingError(
            "That payslip cannot be paid from this line: it is already paid, its run is not confirmed and posted, or its net pay is not the line's amount",
          );
        }
        const month = `${String(slip.month).padStart(2, "0")}/${slip.year}`;
        const jeId = await postJournal(tx, {
          entryDate: txn.txnDate,
          narration: `Salary ${month} — ${slip.employeeName}`,
          reference: req.body.reference || txn.utr || undefined,
          sourceType: "banking",
          sourceId: txn.id,
          postedBy: req.session.user!.id,
          lines: [
            { systemKey: "salary_payable", debit: txn.amount, description: `Salary ${month} — ${slip.employeeName}` },
            { accountId: bank.glAccountId, credit: txn.amount },
          ] as never,
        });
        const [paid] = await tx
          .update(salarySlips)
          .set({ paidJournalEntryId: jeId })
          .where(and(eq(salarySlips.id, slip.slipId), sql`${salarySlips.paidJournalEntryId} IS NULL`))
          .returning({ id: salarySlips.id });
        if (!paid) throw new PostingError(`${slip.employeeName}'s ${month} payslip was paid a moment ago`);
        await linkStatementLine(tx, { bankTransactionId: txn.id, journalEntryIds: [jeId], kind: "categorized" });
        return { journalEntryId: jeId, employeeName: slip.employeeName, month };
      });
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

/**
 * Unmatch, or uncategorize. A matched line only lets go of what it was
 * matched to. A categorized line also deletes what it made — the payment,
 * expense or journal — as Zoho does, so categorizing it again does not post
 * it twice. Either way the line is uncategorized again.
 */
bankingRouter.post("/transactions/:id/unmatch", requirePermission("banking", "edit"), async (req, res) => {
  try {
    const result = await db.transaction(async (tx) => {
      const [line] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, req.params.id!)).for("update");
      if (!line) throw new PostingError("Bank statement line not found");
      // An excluded line comes back the same way, with nothing to let go of.
      if (line.matchStatus === "unmatched") throw new PostingError("That statement line is not matched or excluded");

      const links = await tx.select().from(bankTransactionLinks).where(eq(bankTransactionLinks.bankTransactionId, line.id));
      await tx.delete(bankTransactionLinks).where(eq(bankTransactionLinks.bankTransactionId, line.id));

      const deleted: string[] = [];
      for (const link of links.filter((l) => l.kind === "categorized")) {
        const [elsewhere] = await tx
          .select({ id: bankTransactionLinks.id })
          .from(bankTransactionLinks)
          .where(eq(bankTransactionLinks.journalEntryId, link.journalEntryId))
          .limit(1);
        if (elsewhere) {
          throw new PostingError("That transfer is matched on the other account's statement too — unmatch it there first");
        }
        const je = await tx.query.journalEntries.findFirst({ where: eq(journalEntries.id, link.journalEntryId) });
        if (!je) continue;
        if (je.sourceType === "customer_payment" && je.sourceId) {
          deleted.push((await deleteCustomerPayment(tx, je.sourceId, req.session.user!.id)).number);
        } else if (je.sourceType === "vendor_payment" && je.sourceId) {
          deleted.push((await deleteVendorPayment(tx, je.sourceId, req.session.user!.id)).number);
        } else if (je.sourceType === "expense" && je.sourceId) {
          deleted.push(await deleteStatementExpense(tx, je.sourceId));
        } else if (je.sourceType === "banking") {
          await assertPeriodOpen(tx, je.entryDate, "banking");
          await tx.delete(journalEntries).where(eq(journalEntries.id, je.id));
          deleted.push(je.entryNumber);
        } else {
          throw new PostingError(`A ${SOURCE_LABEL[je.sourceType] ?? je.sourceType} cannot be uncategorized here`);
        }
      }

      const [updated] = await tx
        .update(bankTransactions)
        .set({ matchStatus: "unmatched", reconciledAt: null })
        .where(eq(bankTransactions.id, line.id))
        .returning();
      return { line: updated!, deleted };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof PostingError) return res.status(422).json({ error: err.message });
    throw err;
  }
});

/**
 * An expense made from a statement line, deleted when the line is
 * uncategorized: its journals, custom field values and attachments with it.
 * Only a paid one — an unpaid expense is owed through the vendor and may sit
 * on the Vendor Sheet.
 */
async function deleteStatementExpense(tx: Tx, expenseId: string) {
  const expense = await tx.query.expenses.findFirst({ where: eq(expenses.id, expenseId) });
  if (!expense) throw new PostingError("Expense not found");
  if (!expense.paidThroughId) throw new PostingError(`${expense.number} is unpaid — it cannot be uncategorized`);
  await assertPeriodOpen(tx, expense.expenseDate, "expense");
  await tx
    .delete(journalEntries)
    .where(and(eq(journalEntries.sourceType, "expense"), eq(journalEntries.sourceId, expense.id)));
  await tx.delete(customFieldValues).where(eq(customFieldValues.entityId, expense.id));
  await tx.delete(attachments).where(and(eq(attachments.entityType, "expense"), eq(attachments.entityId, expense.id)));
  await tx.delete(expenses).where(eq(expenses.id, expense.id));
  return expense.number;
}

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
