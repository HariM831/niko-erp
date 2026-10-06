/**
 * Which account head a hand-typed purchase line or an expense should go to
 * (docs/account-head-suggestion-plan.md).
 *
 * History answers first: what this business has already posted, counted, so
 * every suggestion can say why ("14 of 15 times for this vendor"). Only what
 * history cannot answer goes to the model, and the model may only choose from
 * the list it is handed — an id it was not given is thrown away, never posted.
 *
 * Nothing here writes. The form fills the box with the answer and the person
 * keying sees the head and the reason before anything is saved.
 */
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  accounts,
  billLines,
  bills,
  contacts,
  expenses,
  items,
  vendorCreditLines,
  vendorCredits,
} from "@shared/schema";
import type { Db, Tx } from "../db";
import { istDaysAgo } from "./day-resolution";

export type SuggestDocType = "bill" | "purchase_order" | "vendor_credit" | "expense";

export interface SuggestLine {
  key: string;
  text: string;
  hsnOrSac?: string;
  amount?: string;
}

export interface Suggestion {
  key: string;
  accountId: string | null;
  source: "history" | "ai" | null;
  reason: string;
}

/** Text → model answer. Injected so the checks can stand a stub in for Gemini. */
export type AskModel = (prompt: string) => Promise<string>;

const HISTORY_DAYS = 730;
const AI_TIMEOUT_MS = 8000;
export const SUGGEST_MODEL = process.env.ACCOUNT_SUGGEST_MODEL || "gemini-flash-lite-latest";

/* ── Text ─────────────────────────────────────────────────────────────── */

/**
 * Words that say nothing about what was bought: units, months, filler. Left in,
 * "Diesel 200 ltr Sept" and "Diesel for genset" would look half unrelated.
 */
const NOISE = new Set([
  "kg", "kgs", "ltr", "ltrs", "litre", "litres", "liter", "liters", "nos", "no", "pcs", "pc",
  "bag", "bags", "box", "boxes", "qty", "rs", "inr", "mt", "ton", "tons", "tonne", "tonnes",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september", "october",
  "november", "december", "the", "of", "for", "and", "to", "in", "at", "on", "by", "with",
  "from", "charges", "charge", "bill", "amount", "month", "paid", "payment",
]);

export function words(text: string | null | undefined): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2 && !NOISE.has(w));
}

/** Shared words over all words — "at least half the words shared" is ≥ 0.5. */
function overlap(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/* ── Which heads may be offered ───────────────────────────────────────── */

export interface AllowedAccount {
  id: string;
  code: string;
  name: string;
}

/**
 * An expense is offered expense heads only — never stock. A purchase line is
 * offered expense and fixed-asset heads, and never a stock account: stock
 * comes only from an item that tracks it, so a typed line cannot fill Feed
 * Stock. Bank, receivable, payable and tax heads are never offered — GST is
 * part of what a thing costs here, not a balance to recover.
 */
export async function allowedAccounts(db: Db | Tx, docType: SuggestDocType): Promise<AllowedAccount[]> {
  const stockIds = (
    await db
      .selectDistinct({ id: items.inventoryAccountId })
      .from(items)
      .where(isNotNull(items.inventoryAccountId))
  ).map((r) => r.id!);
  const rows = await db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.isActive, true),
        eq(accounts.isGroup, false),
        stockIds.length ? notInArray(accounts.id, stockIds) : undefined,
      ),
    )
    .orderBy(accounts.code);
  return rows
    .filter((a) => a.subtype !== "stock")
    .filter((a) =>
      docType === "expense" ? a.type === "expense" : a.type === "expense" || a.subtype === "fixed_asset",
    )
    .map(({ id, code, name }) => ({ id, code, name }));
}

/* ── History ──────────────────────────────────────────────────────────── */

interface HistoryRow {
  vendorId: string | null;
  words: string[];
  key: string;
  accountId: string;
  date: string;
}

/**
 * Posted hand-typed lines and expenses from the last two years. Lines with an
 * item are left out — their head is the item's, and counting them would let
 * maize teach the vendor's "usual head" to every repair bill they send.
 */
export async function loadHistory(db: Db | Tx, since = istDaysAgo(HISTORY_DAYS)): Promise<HistoryRow[]> {
  const billRows = await db
    .select({
      vendorId: bills.vendorId,
      name: billLines.name,
      description: billLines.description,
      accountId: billLines.accountId,
      date: bills.billDate,
    })
    .from(billLines)
    .innerJoin(bills, eq(bills.id, billLines.billId))
    .where(
      and(
        isNull(billLines.itemId),
        isNotNull(billLines.accountId),
        inArray(bills.status, ["open", "partially_paid", "paid"]),
        gte(bills.billDate, since),
      ),
    );
  const creditRows = await db
    .select({
      vendorId: vendorCredits.vendorId,
      name: vendorCreditLines.name,
      description: vendorCreditLines.description,
      accountId: vendorCreditLines.accountId,
      date: vendorCredits.creditDate,
    })
    .from(vendorCreditLines)
    .innerJoin(vendorCredits, eq(vendorCredits.id, vendorCreditLines.vendorCreditId))
    .where(
      and(
        isNull(vendorCreditLines.itemId),
        isNotNull(vendorCreditLines.accountId),
        inArray(vendorCredits.status, ["open", "closed"]),
        gte(vendorCredits.creditDate, since),
      ),
    );
  const expenseRows = await db
    .select({
      vendorId: expenses.vendorId,
      name: expenses.notes,
      description: sql<string | null>`NULL`,
      accountId: expenses.expenseAccountId,
      date: expenses.expenseDate,
    })
    .from(expenses)
    .where(and(isNotNull(expenses.journalEntryId), gte(expenses.expenseDate, since)));

  return [...billRows, ...creditRows, ...expenseRows].map((r) => {
    const w = words(`${r.name ?? ""} ${r.description ?? ""}`);
    return { vendorId: r.vendorId, words: w, key: w.join(" "), accountId: r.accountId!, date: r.date };
  });
}

/** Most-used head among rows; a tie goes to the one used most recently. */
function topHead(rows: HistoryRow[]): { accountId: string; n: number; of: number } | null {
  if (!rows.length) return null;
  const tally = new Map<string, { n: number; last: string }>();
  for (const r of rows) {
    const t = tally.get(r.accountId) ?? { n: 0, last: "" };
    t.n++;
    if (r.date > t.last) t.last = r.date;
    tally.set(r.accountId, t);
  }
  let best: [string, { n: number; last: string }] | null = null;
  for (const e of tally) {
    if (!best || e[1].n > best[1].n || (e[1].n === best[1].n && e[1].last > best[1].last)) best = e;
  }
  return { accountId: best![0], n: best![1].n, of: rows.length };
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/**
 * H1–H4 from the plan, first answer wins. Rows on heads that may not be
 * offered for this document are dropped first, so a Zoho-era expense that went
 * to a stock account never teaches an expense to do the same.
 */
export function fromHistory(
  history: HistoryRow[],
  allowed: Set<string>,
  vendorId: string | null | undefined,
  text: string,
): { accountId: string; reason: string } | null {
  const rows = history.filter((r) => allowed.has(r.accountId));
  const w = words(text);
  const key = w.join(" ");
  const vendorRows = vendorId ? rows.filter((r) => r.vendorId === vendorId) : [];

  if (key) {
    // H1 — same vendor, same text.
    const h1 = topHead(vendorRows.filter((r) => r.key === key));
    if (h1) {
      return {
        accountId: h1.accountId,
        reason: h1.n === h1.of
          ? `History · ${times(h1.n)} for this vendor`
          : `History · ${h1.n} of ${h1.of} times for this vendor`,
      };
    }
    // H2 — same vendor, similar text.
    const h2 = topHead(vendorRows.filter((r) => overlap(r.words, w) >= 0.5));
    if (h2) return { accountId: h2.accountId, reason: "History · similar lines from this vendor" };
    // H3 — any vendor, same text, at least twice.
    const h3 = topHead(rows.filter((r) => r.key === key));
    if (h3 && h3.n >= 2) {
      return {
        accountId: h3.accountId,
        reason: h3.n === h3.of
          ? `History · ${h3.n} times across vendors`
          : `History · ${h3.n} of ${h3.of} times across vendors`,
      };
    }
  }
  // H4 — the vendor's usual head.
  const h4 = topHead(vendorRows);
  if (h4 && h4.of >= 3 && h4.n / h4.of >= 0.8) {
    return { accountId: h4.accountId, reason: "History · this vendor's usual head" };
  }
  return null;
}

/* ── The model ────────────────────────────────────────────────────────── */

export function geminiModel(apiKey: string, modelName = SUGGEST_MODEL): AskModel {
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });
  return async (prompt) => (await model.generateContent(prompt)).response.text();
}

/**
 * Accounts go to the model as short labels (A1, A2…) rather than uuids: fewer
 * tokens, and an answer that is not one of the labels is plainly not one of
 * the accounts.
 */
export function buildPrompt(
  docType: SuggestDocType,
  vendorName: string | null,
  lines: SuggestLine[],
  allowed: AllowedAccount[],
): string {
  const chart = allowed.map((a, i) => `A${i + 1} | ${a.code} | ${a.name}`).join("\n");
  const doc = docType === "expense" ? "an expense" : "a purchase bill line";
  const asked = lines
    .map((l) =>
      JSON.stringify({ key: l.key, text: l.text, hsnOrSac: l.hsnOrSac ?? null, amount: l.amount ?? null }),
    )
    .join("\n");
  return [
    "You choose the ledger account for spending at an egg-laying poultry farm and feed mill in Assam, India.",
    `Each item below is ${doc}${vendorName ? ` from the vendor "${vendorName}"` : ""}.`,
    "Choose exactly one account label from this list for each item. Never invent a label.",
    "If nothing in the list fits, answer null for that item.",
    "",
    "Accounts (label | code | name):",
    chart,
    "",
    "Items:",
    asked,
    "",
    'Answer JSON only: {"answers":[{"key":"<key>","label":"A12" or null,"reason":"<six words or fewer>"}]}',
  ].join("\n");
}

export function parseAnswers(
  text: string,
  allowed: AllowedAccount[],
  keys: Set<string>,
): Map<string, { accountId: string; reason: string }> {
  const out = new Map<string, { accountId: string; reason: string }>();
  let parsed: unknown;
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
    parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
  } catch {
    return out;
  }
  const answers = (parsed as { answers?: unknown })?.answers;
  if (!Array.isArray(answers)) return out;
  for (const a of answers as Array<{ key?: unknown; label?: unknown; reason?: unknown }>) {
    if (typeof a?.key !== "string" || !keys.has(a.key) || typeof a.label !== "string") continue;
    const m = /^A(\d+)$/.exec(a.label.trim());
    const acct = m ? allowed[Number(m[1]) - 1] : undefined;
    if (!acct) continue;
    const why = typeof a.reason === "string" ? a.reason.trim().slice(0, 60) : "";
    out.set(a.key, { accountId: acct.id, reason: why ? `AI · ${why}` : "AI suggestion" });
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

/* ── The whole answer ─────────────────────────────────────────────────── */

export async function suggestAccounts(
  db: Db | Tx,
  input: { docType: SuggestDocType; vendorId?: string | null; lines: SuggestLine[] },
  ask: AskModel | null,
): Promise<Suggestion[]> {
  const allowed = await allowedAccounts(db, input.docType);
  const allowedIds = new Set(allowed.map((a) => a.id));
  const history = await loadHistory(db);

  const out = new Map<string, Suggestion>();
  const misses: SuggestLine[] = [];
  for (const l of input.lines) {
    const hit = fromHistory(history, allowedIds, input.vendorId, l.text);
    if (hit) out.set(l.key, { key: l.key, accountId: hit.accountId, source: "history", reason: hit.reason });
    // A line with no words has nothing for the model to read either.
    else if (words(l.text).length) misses.push(l);
  }

  if (misses.length && ask && allowed.length) {
    const [vendor] = input.vendorId
      ? await db
          .select({ name: contacts.displayName })
          .from(contacts)
          .where(eq(contacts.id, input.vendorId))
          .limit(1)
      : [];
    try {
      const answer = await withTimeout(
        ask(buildPrompt(input.docType, vendor?.name ?? null, misses, allowed)),
        AI_TIMEOUT_MS,
      );
      const picked = parseAnswers(answer, allowed, new Set(misses.map((m) => m.key)));
      for (const [key, p] of picked) out.set(key, { key, accountId: p.accountId, source: "ai", reason: p.reason });
    } catch (err) {
      console.warn("[account-suggestions] model call failed:", (err as Error)?.message);
    }
  }

  return input.lines.map(
    (l) => out.get(l.key) ?? { key: l.key, accountId: null, source: null, reason: "No suggestion" },
  );
}
