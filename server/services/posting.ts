import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import {
  accounts,
  financialYears,
  journalEntries,
  journalEntryLines,
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

  await assertPeriodOpen(tx, req.entryDate);

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

  const entryNumber = await nextDocumentNumber(tx, "journal_entry");
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
  await assertPeriodOpen(tx, reversalDate);

  const lines = await tx
    .select()
    .from(journalEntryLines)
    .where(eq(journalEntryLines.entryId, entryId));

  const entryNumber = await nextDocumentNumber(tx, "journal_entry");
  const [reversal] = await tx
    .insert(journalEntries)
    .values({
      entryNumber,
      entryDate: reversalDate,
      status: "posted",
      narration: `Reversal of ${original.entryNumber}: ${original.narration}`,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
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

async function assertPeriodOpen(tx: Tx, dateStr: string) {
  const locked = await tx
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
  if (locked.length > 0) {
    throw new PostingError(`Period containing ${dateStr} is locked`);
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
    .select({ id: accounts.id, isActive: accounts.isActive, name: accounts.name })
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
  return account.id;
}

function parseAmount(v: string | undefined): number {
  if (v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new PostingError(`Invalid amount: ${v}`);
  return Math.round(n * 100) / 100;
}
