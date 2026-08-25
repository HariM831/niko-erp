/**
 * Text search across documents, shared by every list.
 *
 * Zoho's quick search reaches past the document's own columns and into its
 * lines: typing "petrol" finds bills whose notes, line descriptions or line
 * account names mention it, not only those whose number or vendor does. It
 * does not match amounts — an amount is a range in the advanced search, not a
 * string to be matched — and this follows the same rule.
 *
 * Each list declares what it exposes; the two builders below turn that into a
 * WHERE clause. Nothing here reads req.query directly, so a module cannot
 * silently accept a filter it never applies.
 */
import { type SQL, and, eq, exists, gte, ilike, lte, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { accounts, contacts } from "@shared/schema";
import { db } from "../db";

/**
 * A search for "50%" must find the string "50%", not every row in the table.
 * The value is parameterised by the driver, but LIKE metacharacters inside it
 * are still live once it reaches Postgres, so they are escaped here. The
 * backslash is Postgres's default ESCAPE for LIKE.
 */
export const contains = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Where a document keeps its lines, and which of their columns are text. */
export interface Lines {
  /** The line table, e.g. billLines. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Line column pointing back at the document, e.g. billLines.billId. */
  documentId: PgColumn;
  /** Free-text line columns — the item name as written and its description. */
  text: PgColumn[];
  /** Account the line posts to; its *name* is searchable, as in Zoho. */
  accountId?: PgColumn;
  /** Catalogue item, matched by id from the advanced search's picker. */
  itemId?: PgColumn;
}

export type Field =
  | { kind: "text"; col: PgColumn }
  | { kind: "eq"; col: PgColumn }
  /** Reads `<key>From` and `<key>To`. */
  | { kind: "dateRange"; col: PgColumn }
  /** Reads `<key>Min` and `<key>Max`. */
  | { kind: "numberRange"; col: PgColumn }
  /** Matches a column on the linked contact, e.g. their PAN. */
  | { kind: "contactText"; on: PgColumn }
  | { kind: "lineText"; on: PgColumn }
  | { kind: "lineItem" }
  | { kind: "accountName" };

export interface DocumentSearch {
  /** The document's own id, used to correlate the EXISTS subqueries. */
  id: PgColumn;
  /** Columns the quick search matches directly. */
  text: PgColumn[];
  /** Vendor or customer; both their display and company names are matched. */
  contactId?: PgColumn;
  /** For documents that post to one account rather than carrying lines. */
  accountId?: PgColumn;
  lines?: Lines;
  /** Advanced-search fields, keyed by the query parameter that supplies them. */
  advanced?: Record<string, Field>;
}

const one = { one: sql<number>`1` };

/** Does the linked contact match, by display name or company name? */
function contactMatches(contactId: PgColumn, term: string) {
  return exists(
    db
      .select(one)
      .from(contacts)
      .where(
        and(
          eq(contacts.id, contactId),
          or(ilike(contacts.displayName, term), ilike(contacts.companyName, term)),
        ),
      ),
  );
}

/** Does the named account match? Used both for expenses and for line accounts. */
function accountMatches(accountId: PgColumn, term: string) {
  return exists(
    db.select(one).from(accounts).where(and(eq(accounts.id, accountId), ilike(accounts.name, term))),
  );
}

/**
 * Does any line match?
 *
 * EXISTS rather than a join on purpose: joining the lines in would return the
 * document once per matching line, so a three-line bill about feed would appear
 * three times in the list.
 */
function lineMatches(lines: Lines, documentId: PgColumn, term: string) {
  const conditions: (SQL | undefined)[] = lines.text.map((c) => ilike(c, term));
  if (lines.accountId) conditions.push(accountMatches(lines.accountId, term));
  return exists(
    db
      .select(one)
      .from(lines.table)
      .where(and(eq(lines.documentId, documentId), or(...conditions))),
  );
}

/**
 * The quick search: one term, matched anywhere the module says it may appear.
 * Returns undefined for an empty term so the caller can drop it from the WHERE.
 */
export function quickSearch(spec: DocumentSearch, raw: string | undefined): SQL | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const term = contains(trimmed);

  const conditions: (SQL | undefined)[] = spec.text.map((c) => ilike(c, term));
  if (spec.contactId) conditions.push(contactMatches(spec.contactId, term));
  if (spec.accountId) conditions.push(accountMatches(spec.accountId, term));
  if (spec.lines) conditions.push(lineMatches(spec.lines, spec.id, term));
  return or(...conditions);
}

/**
 * How many rows a list returns.
 *
 * Browsing is capped, so opening Bills does not pull 1,906 rows to fill one
 * screen. A search is not capped: the whole point of searching is to reach the
 * rows the cap hides, and a truncated result set silently answers "no such
 * bill" when the bill exists. An explicit limit — the quick-search dropdown
 * asks for ten — always wins.
 */
export function listLimit(
  query: Record<string, string | undefined>,
  searching: boolean,
): number | undefined {
  const asked = Number(query.limit);
  if (Number.isFinite(asked) && asked > 0) return asked;
  return searching ? undefined : 200;
}

/**
 * The advanced search: each field is independent and they combine with AND, so
 * an unsupplied field narrows nothing. Only fields the module declared are
 * read, so a stray query parameter cannot quietly become a filter.
 */
export function advancedSearch(
  spec: DocumentSearch,
  query: Record<string, string | undefined>,
): SQL[] {
  const out: SQL[] = [];
  const value = (k: string) => query[k]?.trim() || undefined;

  for (const [key, field] of Object.entries(spec.advanced ?? {})) {
    switch (field.kind) {
      case "text": {
        const v = value(key);
        if (v) out.push(ilike(field.col, contains(v)));
        break;
      }
      case "eq": {
        const v = value(key);
        if (v) out.push(eq(field.col, v));
        break;
      }
      case "dateRange": {
        const from = value(`${key}From`);
        const to = value(`${key}To`);
        // Raw SQL rather than the typed gte/lte helpers: those serialise the
        // bound value based on the column's TS type, and a `timestamp` column
        // (createdAt/postedAt) expects a Date object there, not the plain
        // "YYYY-MM-DD" string this field is fed — Postgres itself casts a
        // date-shaped string against either a `date` or `timestamp` column
        // without trouble, so letting it do that sidesteps the mismatch.
        if (from) out.push(sql`${field.col} >= ${from}`);
        if (to) out.push(sql`${field.col} <= ${to}`);
        break;
      }
      case "numberRange": {
        const min = value(`${key}Min`);
        const max = value(`${key}Max`);
        // Compared as numbers, not as the strings numeric columns come back as,
        // or "9" would sort above "10".
        if (min) out.push(gte(field.col, min));
        if (max) out.push(lte(field.col, max));
        break;
      }
      case "contactText": {
        const v = value(key);
        if (v && spec.contactId) {
          out.push(
            exists(
              db
                .select(one)
                .from(contacts)
                .where(and(eq(contacts.id, spec.contactId), ilike(field.on, contains(v)))),
            ),
          );
        }
        break;
      }
      case "lineText": {
        const v = value(key);
        if (v && spec.lines) {
          out.push(
            exists(
              db
                .select(one)
                .from(spec.lines.table)
                .where(and(eq(spec.lines.documentId, spec.id), ilike(field.on, contains(v)))),
            ),
          );
        }
        break;
      }
      case "lineItem": {
        const v = value(key);
        if (v && spec.lines?.itemId) {
          out.push(
            exists(
              db
                .select(one)
                .from(spec.lines.table)
                .where(and(eq(spec.lines.documentId, spec.id), eq(spec.lines.itemId, v))),
            ),
          );
        }
        break;
      }
      case "accountName": {
        const v = value(key);
        if (!v) break;
        // An account matches either because the document posts to it directly
        // (an expense) or because one of its lines does (a bill).
        const term = contains(v);
        if (spec.accountId) out.push(accountMatches(spec.accountId, term));
        else if (spec.lines?.accountId) {
          const lines = spec.lines;
          out.push(
            exists(
              db
                .select(one)
                .from(lines.table)
                .where(and(eq(lines.documentId, spec.id), accountMatches(lines.accountId!, term))),
            ),
          );
        }
        break;
      }
    }
  }
  return out;
}
