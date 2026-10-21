import { and, eq, inArray, sql } from "drizzle-orm";
import { bankAccounts, bankTransactionLinks, bankTransactions, journalEntries, journalEntryLines } from "@shared/schema";
import type { Tx } from "../db";
import { PostingError } from "./posting";
import { fromPaise, toPaise } from "./documents";

/**
 * Statement line ↔ journal links (Zoho's Match and Categorize).
 *
 * A line is matched when the journals linked to it move its bank account by
 * exactly the line: a deposit of ₹6,00,000 needs journals that put ₹6,00,000
 * into this bank, net. Several may add up to it; a deposit may even be met by
 * a receipt less a payment, as Zoho allows.
 */

/** Paise each journal moves this bank's GL account by, debit positive. */
export async function bankMovementPaise(tx: Tx, journalEntryIds: string[], glAccountId: string) {
  const out = new Map<string, number>();
  if (!journalEntryIds.length) return out;
  const rows = await tx
    .select({
      entryId: journalEntryLines.entryId,
      net: sql<string>`SUM(${journalEntryLines.debit} - ${journalEntryLines.credit})::numeric(14,2)`,
    })
    .from(journalEntryLines)
    .where(and(inArray(journalEntryLines.entryId, journalEntryIds), eq(journalEntryLines.accountId, glAccountId)))
    .groupBy(journalEntryLines.entryId);
  for (const r of rows) out.set(r.entryId, toPaise(r.net));
  return out;
}

/** A statement credit is money in: a debit on the bank's GL account. */
export const signedLinePaise = (line: { direction: "credit" | "debit"; amount: string }) =>
  (line.direction === "credit" ? 1 : -1) * toPaise(line.amount);

/**
 * Link journals to an unmatched statement line and mark it matched. Refused
 * unless every journal is posted, moves this bank, is not already spoken for
 * on this bank, and together they come to the line.
 */
export async function linkStatementLine(
  tx: Tx,
  input: { bankTransactionId: string; journalEntryIds: string[]; kind: "matched" | "categorized" },
) {
  const ids = [...new Set(input.journalEntryIds)];
  if (!ids.length) throw new PostingError("Select at least one transaction to match");

  const [line] = await tx
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, input.bankTransactionId))
    .for("update");
  if (!line) throw new PostingError("Bank statement line not found");
  if (line.matchStatus !== "unmatched") {
    throw new PostingError(`That statement line is already ${line.matchStatus === "matched" ? "matched or categorized" : "excluded"}`);
  }
  const bank = await tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, line.bankAccountId) });
  if (!bank) throw new PostingError("Bank account not found");

  const entries = await tx
    .select({ id: journalEntries.id, status: journalEntries.status, entryNumber: journalEntries.entryNumber })
    .from(journalEntries)
    .where(inArray(journalEntries.id, ids));
  if (entries.length !== ids.length) throw new PostingError("Journal entry not found");
  const notPosted = entries.find((e) => e.status !== "posted");
  if (notPosted) throw new PostingError(`${notPosted.entryNumber} is not posted`);

  const taken = await tx
    .select({ entryId: bankTransactionLinks.journalEntryId })
    .from(bankTransactionLinks)
    .where(and(inArray(bankTransactionLinks.journalEntryId, ids), eq(bankTransactionLinks.bankAccountId, bank.id)))
    .limit(1);
  if (taken.length) {
    const n = entries.find((e) => e.id === taken[0]!.entryId)?.entryNumber;
    throw new PostingError(`${n ?? "That transaction"} is already matched to another statement line`);
  }

  const moves = await bankMovementPaise(tx, ids, bank.glAccountId);
  const idle = entries.find((e) => !moves.get(e.id));
  if (idle) throw new PostingError(`${idle.entryNumber} does not move ${bank.name}`);
  const totalP = ids.reduce((s, id) => s + moves.get(id)!, 0);
  const wantP = signedLinePaise(line);
  if (totalP !== wantP) {
    throw new PostingError(
      `The selected transactions come to ${fromPaise(Math.abs(totalP))} ${totalP >= 0 ? "in" : "out"}; the statement line is ${line.amount} ${wantP >= 0 ? "in" : "out"}`,
    );
  }

  await tx.insert(bankTransactionLinks).values(
    ids.map((journalEntryId) => ({
      bankTransactionId: line.id,
      bankAccountId: bank.id,
      journalEntryId,
      kind: input.kind,
    })),
  );
  const [updated] = await tx
    .update(bankTransactions)
    .set({ matchStatus: "matched", reconciledAt: new Date() })
    .where(eq(bankTransactions.id, line.id))
    .returning();
  return updated!;
}

/**
 * A document made from a statement line (Categorize Manually) is checked
 * against the line before it is posted, so a wrong date or account fails with
 * a reason rather than as a sum that does not add up.
 */
export async function assertLineFits(
  tx: Tx,
  bankTransactionId: string,
  doc: { bankAccountId: string | null | undefined; date: string },
) {
  const line = await tx.query.bankTransactions.findFirst({ where: eq(bankTransactions.id, bankTransactionId) });
  if (!line) throw new PostingError("Bank statement line not found");
  if (line.matchStatus !== "unmatched") throw new PostingError("That statement line is no longer uncategorized");
  if (doc.bankAccountId !== line.bankAccountId) {
    throw new PostingError("A transaction made from a statement line must use that line's bank account");
  }
  if (doc.date !== line.txnDate) throw new PostingError(`The date must be the statement date, ${line.txnDate}`);
  return line;
}

/** The first statement line any of these journals is linked to, for "unmatch it first" refusals. */
export async function linkedStatementLine(tx: Tx, journalEntryIds: string[]) {
  if (!journalEntryIds.length) return undefined;
  const [hit] = await tx
    .select({ id: bankTransactionLinks.bankTransactionId })
    .from(bankTransactionLinks)
    .where(inArray(bankTransactionLinks.journalEntryId, journalEntryIds))
    .limit(1);
  return hit;
}

/**
 * Editing a document re-posts it, reversing the old journal and posting a new
 * one. A statement line matched to the old journal follows it to the new one,
 * provided the bank still moves by what the statement says; an edit that
 * changes the amount or the bank is refused until the line is unmatched.
 */
export async function carryLinks(tx: Tx, oldJournalEntryId: string | null | undefined, newJournalEntryId: string, docNumber: string) {
  if (!oldJournalEntryId) return;
  const links = await tx.select().from(bankTransactionLinks).where(eq(bankTransactionLinks.journalEntryId, oldJournalEntryId));
  for (const link of links) {
    const bank = await tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, link.bankAccountId) });
    if (!bank) continue;
    const moves = await bankMovementPaise(tx, [oldJournalEntryId, newJournalEntryId], bank.glAccountId);
    if ((moves.get(oldJournalEntryId) ?? 0) !== (moves.get(newJournalEntryId) ?? 0)) {
      throw new PostingError(
        `${docNumber} is matched to a statement line on ${bank.name} — unmatch it in Banking before changing its amount or account`,
      );
    }
  }
  if (links.length) {
    await tx
      .update(bankTransactionLinks)
      .set({ journalEntryId: newJournalEntryId })
      .where(eq(bankTransactionLinks.journalEntryId, oldJournalEntryId));
  }
}

/** Words a party's name is written with or without: "Chowdhury n Sons", "M/s Annapurna Bakery". */
const NAME_NOISE = new Set(["m", "s", "ms", "mr", "mrs", "shri", "smt", "pvt", "private", "ltd", "limited", "llp", "the"]);

/** A name squeezed to its letters and digits, "and" and "&" read as the "n" Amino's contacts write. */
export function squeezeName(text: string) {
  return text
    .toLowerCase()
    .replace(/&/g, " n ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NAME_NOISE.has(w))
    .map((w) => (w === "and" ? "n" : w))
    .join("");
}

/**
 * Who a statement line is probably from or to: a party whose bank account
 * number the line carries, or whose name (or name at the bank) it spells out,
 * longest name first. At most five; offered, never chosen.
 */
export function suggestParties(
  lineText: string,
  people: Array<{ id: string; displayName: string; companyName?: string | null; beneficiary?: string | null; accountNumber?: string | null }>,
) {
  const hay = squeezeName(lineText);
  const digits = new Set((lineText.match(/\d{9,18}/g) ?? []).map((d) => d.replace(/^0+/, "")));
  const scored = people.flatMap((c) => {
    const acct = (c.accountNumber ?? "").replace(/\D/g, "").replace(/^0+/, "");
    if (acct.length >= 9 && digits.has(acct)) {
      return [{ id: c.id, displayName: c.displayName, reason: "bank account number", score: 1000 }];
    }
    const names = [c.displayName, c.companyName, c.beneficiary].filter((n): n is string => !!n).map(squeezeName);
    const hit = names.filter((n) => n.length >= 5 && hay.includes(n)).sort((a, b) => b.length - a.length)[0];
    return hit ? [{ id: c.id, displayName: c.displayName, reason: "name", score: hit.length }] : [];
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(({ score: _s, ...rest }) => rest);
}

/**
 * Words a bank narration is made of whoever sent the money: the rails, the
 * instrument, the pleasantries. What is left is the only part that names a
 * person.
 */
const BANK_NOISE = new Set([
  "by", "to", "from", "transfer", "transfered", "trf", "neft", "rtgs", "imps", "upi", "utr",
  "no", "ref", "cr", "dr", "sent", "received", "receive", "cash", "deposit", "deposite",
  "dep", "csh", "cdm", "self", "bill", "payment", "pay", "inb", "ac", "acc", "account",
  "bank", "branch", "chq", "cheque", "clg", "fund", "funds", "txn", "charges", "sbi",
  "hdfc", "icici", "idfc", "axis", "pnb", "punb", "ucba", "cnrb", "bkid", "iob", "bdbl",
  "psib", "cbin", "ybl", "ybp", "ptm", "paytm", "gpay", "phonepe", "large", "small",
]);

/**
 * The name-ish words in a narration: letters only, three or more, none of the
 * rails above, and nothing that is really a code with digits in it.
 *
 * "BY TRANSFER- IMPS/629254237391 /RE1-XX766- SANKET S/200 large-" gives back
 * "sanket", which is the whole point: the payer's own name is in there and it
 * is not the name on the account we invoice.
 */
export function nameWords(text: string | null | undefined) {
  return [
    ...new Set(
      (text ?? "")
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length >= 3 && !BANK_NOISE.has(w)),
    ),
  ];
}

/**
 * Who this line is probably from, going by who money described like this has
 * been from before.
 *
 * The suggester above knows a party by the name we invoice them under, their
 * company name, their beneficiary name or their account number. None of those
 * is what a bank narration carries: Sanket Saraf pays for SS Food, Biju Das
 * and Debajeet pay for shops in their own names, and the line says so while
 * the contact record does not.
 *
 * So the names are learned from what has already been decided — every
 * statement line somebody categorized, and every receipt's reference, both of
 * which carry a narration and a party. A word counts for a party in
 * proportion to how exclusively it belongs to them: "sanket" naming one party
 * and nobody else is strong, a word seen against five parties is worth
 * nothing. Nothing is remembered that a person did not first decide.
 */
export function suggestLearned(
  lineText: string,
  seen: Array<{ partyId: string; displayName: string; text: string }>,
) {
  const byWord = new Map<string, Map<string, number>>();
  const names = new Map<string, string>();
  for (const s of seen) {
    names.set(s.partyId, s.displayName);
    for (const w of nameWords(s.text)) {
      const parties = byWord.get(w) ?? new Map<string, number>();
      parties.set(s.partyId, (parties.get(s.partyId) ?? 0) + 1);
      byWord.set(w, parties);
    }
  }
  const score = new Map<string, { score: number; words: string[] }>();
  for (const w of nameWords(lineText)) {
    const parties = byWord.get(w);
    // A word that has named more than two different parties is a word about
    // banking, not about anybody.
    if (!parties || parties.size > 2) continue;
    for (const [id, times] of parties) {
      const cur = score.get(id) ?? { score: 0, words: [] };
      cur.score += (w.length * times) / parties.size;
      cur.words.push(w);
      score.set(id, cur);
    }
  }
  return [...score]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5)
    .map(([id, v]) => ({
      id,
      displayName: names.get(id)!,
      reason: `paid under "${v.words.join(" ")}" before`,
    }));
}

/**
 * The bank's own reference inside a document's reference: the UTR, the IMPS
 * or UPI number, the bank's transfer code. Codes of eight or more letters and
 * digits that hold a digit, without IFSCs ("CBIN0281346"), which name the
 * payer's branch and recur on every payment from it.
 */
export function bankRefTokens(reference: string | null | undefined) {
  return (reference ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 8 && /\d/.test(t) && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(t));
}

/**
 * Does a statement line carry the document's bank reference? Compared with
 * spaces and punctuation gone, so a UTR the PDF wrapped
 * ("PSIBR22026100700 876935") still reads as one.
 */
export function sharesBankRef(reference: string | null | undefined, lineText: string) {
  const hay = lineText.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bankRefTokens(reference).some((t) => hay.includes(t));
}

export interface FitSignal {
  lineId: string;
  entryId: string;
  /** The line names this document's party, or someone else, or nobody. */
  party: "same" | "other" | undefined;
  sharedRef: boolean;
}

/**
 * Auto-match picks only what a person would not stop to think about: each
 * line with exactly one fit (same amount, side and days) that shares the
 * bank's reference or names the same payer, and nobody else's. A document
 * that is the one fit for two lines is left to the person: that is two
 * receipts of one sum, and only the statement order can tell them apart.
 */
export function pickConfident(signals: FitSignal[]) {
  const byLine = new Map<string, FitSignal[]>();
  for (const s of signals) {
    if (s.party === "other" || !(s.sharedRef || s.party === "same")) continue;
    byLine.set(s.lineId, [...(byLine.get(s.lineId) ?? []), s]);
  }
  const picks = [...byLine.values()].filter((c) => c.length === 1).map((c) => c[0]!);
  const uses = new Map<string, number>();
  for (const p of picks) uses.set(p.entryId, (uses.get(p.entryId) ?? 0) + 1);
  return picks
    .filter((p) => uses.get(p.entryId) === 1)
    .map((p) => ({ lineId: p.lineId, entryId: p.entryId, sameRef: p.sharedRef, samePayer: p.party === "same" }));
}
