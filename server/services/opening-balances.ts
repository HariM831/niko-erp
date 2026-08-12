import { and, eq, ne, sql } from "drizzle-orm";
import {
  accounts,
  contacts,
  journalEntries,
  journalEntryLines,
  orgProfile,
} from "@shared/schema";
import type { Db, Tx } from "../db";
import { PostingError, postJournal } from "./posting";

type Reader = Db | Tx;

const toPaise = (s: string | number | null | undefined): number =>
  Math.round(Number(s ?? 0) * 100);
const fromPaise = (p: number): string => (p / 100).toFixed(2);

export interface OpeningLine {
  accountId: string;
  debit: string;
  credit: string;
}

export interface OpeningAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  systemKey: string | null;
  debit: string;
  credit: string;
  /** True for AR/AP, whose totals come from contacts rather than being typed. */
  derived: boolean;
}

export interface OpeningBalanceState {
  migrationDate: string | null;
  posted: boolean;
  postedEntryId: string | null;
  accounts: OpeningAccount[];
  totalDebit: string;
  totalCredit: string;
  difference: string;
  /** Live AR/AP from contacts, which may differ from what was last posted. */
  receivable: string;
  payable: string;
  needsReposting: boolean;
}

/** The single journal that carries the opening balances, if it has been posted. */
async function findOpeningEntry(tx: Reader) {
  return tx.query.journalEntries.findFirst({
    where: and(
      eq(journalEntries.sourceType, "opening_balance"),
      eq(journalEntries.status, "posted"),
    ),
  });
}

/**
 * Opening receivable and payable, summed from each contact's opening balance.
 *
 * These are never typed on the opening balances screen: a customer's ledger
 * starts from its own opening balance, so if the AR total were entered
 * separately the two could disagree. Deriving it makes that impossible.
 */
export async function contactOpeningTotals(
  tx: Reader,
): Promise<{ receivable: number; payable: number }> {
  const rows = await tx
    .select({
      type: contacts.type,
      total: sql<string>`coalesce(sum(${contacts.openingBalance}), 0)`,
    })
    .from(contacts)
    .where(ne(contacts.openingBalance, "0"))
    .groupBy(contacts.type);
  let receivable = 0;
  let payable = 0;
  for (const r of rows) {
    if (r.type === "customer") receivable = toPaise(r.total);
    else payable = toPaise(r.total);
  }
  return { receivable, payable };
}

export async function getOpeningBalances(tx: Reader): Promise<OpeningBalanceState> {
  const [org] = await tx.select().from(orgProfile).limit(1);
  const entry = await findOpeningEntry(tx);

  const postedLines = entry
    ? await tx
        .select({
          accountId: journalEntryLines.accountId,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
        })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.entryId, entry.id))
    : [];
  const postedByAccount = new Map(
    postedLines.map((l) => [l.accountId, { debit: toPaise(l.debit), credit: toPaise(l.credit) }]),
  );

  const all = await tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      systemKey: accounts.systemKey,
      isGroup: accounts.isGroup,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .orderBy(accounts.code);

  const { receivable, payable } = await contactOpeningTotals(tx);

  const rows: OpeningAccount[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const a of all) {
    if (a.isGroup || !a.isActive) continue;
    // The balancing account is the result, not an input.
    if (a.systemKey === "opening_balance_adj") continue;

    const derived = a.subtype === "accounts_receivable" || a.subtype === "accounts_payable";
    let debitP = 0;
    let creditP = 0;
    if (derived) {
      if (a.subtype === "accounts_receivable") debitP = receivable;
      else creditP = payable;
    } else {
      const posted = postedByAccount.get(a.id);
      debitP = posted?.debit ?? 0;
      creditP = posted?.credit ?? 0;
    }
    totalDebit += debitP;
    totalCredit += creditP;
    rows.push({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      systemKey: a.systemKey,
      debit: fromPaise(debitP),
      credit: fromPaise(creditP),
      derived,
    });
  }

  // If contact balances moved since the entry was posted, the books are stale.
  let needsReposting = false;
  if (entry) {
    const arAccount = all.find((a) => a.subtype === "accounts_receivable");
    const apAccount = all.find((a) => a.subtype === "accounts_payable");
    const postedAr = arAccount ? (postedByAccount.get(arAccount.id)?.debit ?? 0) : 0;
    const postedAp = apAccount ? (postedByAccount.get(apAccount.id)?.credit ?? 0) : 0;
    needsReposting = postedAr !== receivable || postedAp !== payable;
  }

  return {
    migrationDate: org?.migrationDate ?? null,
    posted: !!entry,
    postedEntryId: entry?.id ?? null,
    accounts: rows,
    totalDebit: fromPaise(totalDebit),
    totalCredit: fromPaise(totalCredit),
    difference: fromPaise(totalDebit - totalCredit),
    receivable: fromPaise(receivable),
    payable: fromPaise(payable),
    needsReposting,
  };
}

/**
 * Replace the opening balance entry.
 *
 * Opening balances are a migration artefact, not a transaction — getting them
 * wrong and fixing them is the normal case, so re-saving voids the previous
 * entry outright rather than posting a correcting one. Any difference between
 * debits and credits lands in Opening Balance Adjustments, which is exactly
 * what that account is for: a trial balance that does not tie is still worth
 * recording while you find the missing piece.
 */
export async function saveOpeningBalances(
  tx: Tx,
  args: { migrationDate: string; lines: OpeningLine[]; postedBy: string },
): Promise<{ entryId: string | null; difference: string }> {
  const existing = await findOpeningEntry(tx);
  if (existing) {
    // Superseded, not reversed: a reversal would leave two entries that net to
    // nothing and clutter every ledger for the migration date.
    await tx.delete(journalEntryLines).where(eq(journalEntryLines.entryId, existing.id));
    await tx
      .update(journalEntries)
      .set({ status: "reversed", narration: `${existing.narration} (superseded)` })
      .where(eq(journalEntries.id, existing.id));
  }

  const postable = await tx
    .select({
      id: accounts.id,
      name: accounts.name,
      subtype: accounts.subtype,
      systemKey: accounts.systemKey,
      isGroup: accounts.isGroup,
      isActive: accounts.isActive,
    })
    .from(accounts);
  const byId = new Map(postable.map((a) => [a.id, a]));

  const jeLines: Parameters<typeof postJournal>[1]["lines"] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const line of args.lines) {
    const account = byId.get(line.accountId);
    if (!account) throw new PostingError(`Unknown account in opening balances`);
    if (account.isGroup) {
      throw new PostingError(`"${account.name}" is a heading — use one of its sub-accounts`);
    }
    if (account.subtype === "accounts_receivable" || account.subtype === "accounts_payable") {
      throw new PostingError(
        `${account.name} comes from each contact's opening balance, so it cannot be entered here`,
      );
    }
    if (account.systemKey === "opening_balance_adj") {
      throw new PostingError("Opening Balance Adjustments is the balancing figure, not an input");
    }
    const debitP = toPaise(line.debit);
    const creditP = toPaise(line.credit);
    if (debitP < 0 || creditP < 0) throw new PostingError("Amounts must be non-negative");
    if (debitP > 0 && creditP > 0) {
      throw new PostingError(`${account.name} has both a debit and a credit`);
    }
    if (debitP === 0 && creditP === 0) continue;
    totalDebit += debitP;
    totalCredit += creditP;
    jeLines.push(
      debitP > 0
        ? { accountId: account.id, debit: fromPaise(debitP) }
        : { accountId: account.id, credit: fromPaise(creditP) },
    );
  }

  // AR and AP come from the contacts themselves.
  const { receivable, payable } = await contactOpeningTotals(tx);
  if (receivable > 0) {
    const ar = postable.find((a) => a.subtype === "accounts_receivable" && !a.isGroup);
    if (!ar) throw new PostingError("No accounts receivable account in the chart");
    totalDebit += receivable;
    jeLines.push({ accountId: ar.id, debit: fromPaise(receivable) });
  }
  if (payable > 0) {
    const ap = postable.find((a) => a.subtype === "accounts_payable" && !a.isGroup);
    if (!ap) throw new PostingError("No accounts payable account in the chart");
    totalCredit += payable;
    jeLines.push({ accountId: ap.id, credit: fromPaise(payable) });
  }

  await tx
    .update(orgProfile)
    .set({ migrationDate: args.migrationDate, updatedAt: new Date() });

  if (!jeLines.length) return { entryId: null, difference: "0.00" };

  const differenceP = totalDebit - totalCredit;
  if (differenceP !== 0) {
    const adj = postable.find((a) => a.systemKey === "opening_balance_adj");
    if (!adj) throw new PostingError("No Opening Balance Adjustments account in the chart");
    jeLines.push(
      differenceP > 0
        ? { accountId: adj.id, credit: fromPaise(differenceP) }
        : { accountId: adj.id, debit: fromPaise(-differenceP) },
    );
  }

  const entryId = await postJournal(tx, {
    entryDate: args.migrationDate,
    narration: `Opening balances as at ${args.migrationDate}`,
    sourceType: "opening_balance",
    postedBy: args.postedBy,
    lines: jeLines,
  });

  return { entryId, difference: fromPaise(differenceP) };
}
