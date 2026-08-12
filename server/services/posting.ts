import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import {
  accounts,
  financialYears,
  journalEntries,
  journalEntryLines,
  transactionLocks,
  type journalSourceType,
} from "@shared/schema";
import type { Tx } from "../db";
import { nextDocumentNumber } from "../lib/numbering";

export interface PostingLine {
  /** Either a concrete account id or a systemKey lookup ("ar", "ap", ...). */
  accountId?: string;
  systemKey?: string;
  debit?: string;
  credit?: string;
  description?: string;
  tag?: string;
}

export interface PostingRequest {
  entryDate: string; // YYYY-MM-DD
  narration: string;
  reference?: string;
  sourceType: (typeof journalSourceType.enumValues)[number];
  sourceId?: string;
  postedBy: string;
  /**
   * Number series to draw the entry number from. Manual journals pass the one
   * the user picked; document postings omit it and fall back to the default.
   */
  seriesId?: string;
  lines: PostingLine[];
}

const EPSILON = 0.005;

/**
 * Post a balanced journal entry. MUST be called inside a transaction —
 * the document that triggered the posting and the ledger entry commit or
 * roll back together. Throws on: unbalanced lines, unknown account,
 * inactive account, or a date inside a locked period.
 */
export async function postJournal(tx: Tx, req: PostingRequest): Promise<string> {
  if (req.lines.length < 2) throw new PostingError("A journal needs at least two lines");

  await assertPeriodOpen(tx, req.entryDate, req.sourceType);

  let totalDebit = 0;
  let totalCredit = 0;
  const resolved: Array<{ accountId: string; debit: string; credit: string; description?: string; tag?: string }> = [];

  for (const line of req.lines) {
    const debit = parseAmount(line.debit);
    const credit = parseAmount(line.credit);
    if (debit < 0 || credit < 0) throw new PostingError("Amounts must be non-negative");
    if (debit > 0 && credit > 0) throw new PostingError("A line cannot have both debit and credit");
    if (debit === 0 && credit === 0) continue;
    totalDebit += debit;
    totalCredit += credit;
    resolved.push({
      accountId: await resolveAccount(tx, line),
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      description: line.description,
      tag: line.tag,
    });
  }

  if (resolved.length < 2) throw new PostingError("A journal needs at least two non-zero lines");
  if (Math.abs(totalDebit - totalCredit) > EPSILON) {
    throw new PostingError(
      `Journal is unbalanced: debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}`,
    );
  }

  const entryNumber = await nextDocumentNumber(tx, "journal_entry", req.seriesId);
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      entryNumber,
      entryDate: req.entryDate,
      status: "posted",
      narration: req.narration,
      reference: req.reference,
      sourceType: req.sourceType,
      sourceId: req.sourceId,
      seriesId: req.seriesId,
      postedBy: req.postedBy,
    })
    .returning({ id: journalEntries.id });

  await tx.insert(journalEntryLines).values(
    resolved.map((l, i) => ({
      entryId: entry!.id,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description,
      tag: l.tag,
      lineOrder: i,
    })),
  );

  return entry!.id;
}

/**
 * Reverse a posted entry: creates a mirrored entry dated `reversalDate`
 * and marks the original reversed. Same-transaction as the caller.
 */
export async function reverseJournal(
  tx: Tx,
  entryId: string,
  reversalDate: string,
  postedBy: string,
): Promise<string> {
  const original = await tx.query.journalEntries.findFirst({
    where: eq(journalEntries.id, entryId),
  });
  if (!original) throw new PostingError("Journal entry not found");
  if (original.status !== "posted") {
    throw new PostingError(`Cannot reverse an entry with status "${original.status}"`);
  }
  // A reversal belongs to the same module as the entry it undoes.
  await assertPeriodOpen(tx, reversalDate, original.sourceType);

  const lines = await tx
    .select()
    .from(journalEntryLines)
    .where(eq(journalEntryLines.entryId, entryId));

  // A reversal is numbered from the same series as the entry it undoes.
  const entryNumber = await nextDocumentNumber(tx, "journal_entry", original.seriesId);
  const [reversal] = await tx
    .insert(journalEntries)
    .values({
      entryNumber,
      entryDate: reversalDate,
      status: "posted",
      narration: `Reversal of ${original.entryNumber}: ${original.narration}`,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      seriesId: original.seriesId,
      isReversal: true,
      reversesEntryId: entryId,
      postedBy,
    })
    .returning({ id: journalEntries.id });

  await tx.insert(journalEntryLines).values(
    lines.map((l, i) => ({
      entryId: reversal!.id,
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      description: l.description,
      tag: l.tag,
      lineOrder: i,
    })),
  );

  await tx
    .update(journalEntries)
    .set({ status: "reversed" })
    .where(eq(journalEntries.id, entryId));

  return reversal!.id;
}

export class PostingError extends Error {}

export type LockModule = "sales" | "purchases" | "banking" | "accountant";

/** Which lock governs a posting, based on the document that produced it. */
export function lockModuleFor(
  sourceType: (typeof journalSourceType.enumValues)[number],
): LockModule {
  switch (sourceType) {
    case "invoice":
    case "customer_payment":
    case "credit_note":
      return "sales";
    case "bill":
    case "vendor_payment":
    case "vendor_credit":
    case "expense":
      return "purchases";
    case "banking":
      return "banking";
    default:
      return "accountant";
  }
}

const MODULE_LABEL: Record<LockModule, string> = {
  sales: "Sales",
  purchases: "Purchases",
  banking: "Banking",
  accountant: "Accountant",
};

/**
 * Refuse anything dated on or before the module's lock date, or inside a locked
 * financial year. `sourceType` decides which module lock applies.
 */
export async function assertPeriodOpen(
  tx: Tx,
  dateStr: string,
  sourceType: (typeof journalSourceType.enumValues)[number],
) {
  const mod = lockModuleFor(sourceType);
  const [lock] = await tx
    .select({ lockedThrough: transactionLocks.lockedThrough })
    .from(transactionLocks)
    .where(eq(transactionLocks.module, mod))
    .limit(1);
  if (lock?.lockedThrough && dateStr <= lock.lockedThrough) {
    throw new PostingError(
      `${MODULE_LABEL[mod]} transactions are locked up to ${lock.lockedThrough}. ` +
        `Change the lock date to record something on ${dateStr}.`,
    );
  }

  const closedYear = await tx
    .select({ id: financialYears.id })
    .from(financialYears)
    .where(
      and(
        isNotNull(financialYears.lockedThrough),
        lte(financialYears.startDate, dateStr),
        gte(financialYears.lockedThrough, dateStr),
      ),
    )
    .limit(1);
  if (closedYear.length > 0) {
    throw new PostingError(`The financial year containing ${dateStr} is closed`);
  }
}

async function resolveAccount(tx: Tx, line: PostingLine): Promise<string> {
  const where = line.accountId
    ? eq(accounts.id, line.accountId)
    : line.systemKey
      ? eq(accounts.systemKey, line.systemKey)
      : null;
  if (!where) throw new PostingError("Line missing accountId or systemKey");
  const [account] = await tx
    .select({
      id: accounts.id,
      isActive: accounts.isActive,
      isGroup: accounts.isGroup,
      name: accounts.name,
    })
    .from(accounts)
    .where(where)
    .limit(1);
  if (!account) {
    throw new PostingError(
      `Account not found: ${line.accountId ?? line.systemKey}`,
    );
  }
  if (!account.isActive) {
    throw new PostingError(`Account "${account.name}" is inactive`);
  }
  // Group rows only exist to sub-total their children on reports.
  if (account.isGroup) {
    throw new PostingError(`"${account.name}" is a heading — post to one of its sub-accounts instead`);
  }
  return account.id;
}

function parseAmount(v: string | undefined): number {
  if (v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new PostingError(`Invalid amount: ${v}`);
  return Math.round(n * 100) / 100;
}
