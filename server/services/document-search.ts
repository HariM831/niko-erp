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
import { type SQL, and, eq, exists, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
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

/**
 * A name search that matches the start of any word, the way a person scans a
 * list of names: "agr" finds Agarwal Industries and Agro Trade Global, "trade"
 * finds Agro Trade Global too, "music" finds M/S MUSIC MAHAL — but "gra" does
 * not find Nagra. A word starts at the beginning of the name or after anything
 * that is not a letter or digit, so the "S" in "M/S" counts.
 *
 * The term is escaped for the regex, so a dot or a bracket is looked for
 * literally.
 */
export const wordStart = (col: PgColumn, term: string): SQL => {
  const t = term.trim();
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The ILIKE is implied by the regex and costs a fraction of it, so it goes
  // first and the regex only runs on rows that contain the text at all. Across
  // every bill line, on every key pressed, that is the difference that shows.
  return sql`(${col} ILIKE ${contains(t)} AND ${col} ~* ${`(^|[^[:alnum:]])${escaped}`})`;
};

/**
 * The one rule every list's search follows, typed a key at a time.
 *
 * Words match from their start — "agr" finds Agro Trade but not Nagra. Once a
 * digit is typed the term is a number, and numbers are remembered by their
 * tail: "2097" has to find BILL-002097 and "1580" UN/26-27/1580, so a term
 * with a digit in it matches anywhere.
 */
export const matches = (col: PgColumn, term: string): SQL =>
  /\d/.test(term) ? ilike(col, contains(term.trim())) : wordStart(col, term);

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
  | { kind: "accountName" }
  /** An account picked by id: the document's own account, or any line's. */
  | { kind: "accountId" }
  /** One box matched against several columns — a name that may be the display or the company name. */
  | { kind: "anyText"; cols: PgColumn[] }
  /** "true"/"false" (or "yes"/"no") against a boolean column. */
  | { kind: "bool"; col: PgColumn }
  /**
   * Anything the kinds above cannot say — a join, a computed status. Handed a
   * reader for the query so it can take its own key, or several; returns
   * nothing when its value is absent.
   */
  | { kind: "custom"; build: (get: (k: string) => string | undefined) => SQL | undefined };

export interface DocumentSearch {
  /** The document's own id, used to correlate the EXISTS subqueries. Needed with `lines`. */
  id?: PgColumn;
  /** Columns the quick search matches directly. */
  text?: PgColumn[];
  /** Vendor or customer; both their display and company names are matched. */
  contactId?: PgColumn;
  /** For documents that post to one account rather than carrying lines. */
  accountId?: PgColumn;
  lines?: Lines;
  /** Advanced-search fields, keyed by the query parameter that supplies them. */
  advanced?: Record<string, Field>;
}

const one = { one: sql<number>`1` };

/** How a column is tested against the term — the quick search's rule, or the advanced search's. */
type Matcher = (col: PgColumn) => SQL;

/*
 * Each helper below asks "which contacts / accounts / lines match?" once, and
 * keeps the documents that point at one — `col IN (SELECT …)`, uncorrelated,
 * which Postgres runs a single time and hashes. Written as a correlated EXISTS
 * inside the quick search's OR, the same question was re-asked for every
 * document: 1,900 bills each scanning the bill lines, most of a second a key.
 * IN also cannot repeat a document the way a join would, so a three-line bill
 * about feed still appears once.
 */

/** Does the linked contact match, by display name or company name? */
function contactMatches(contactId: PgColumn, m: Matcher) {
  return inArray(
    contactId,
    db.select({ id: contacts.id }).from(contacts).where(or(m(contacts.displayName), m(contacts.companyName))),
  );
}

/** Does the named account match? Used both for expenses and for line accounts. */
function accountMatches(accountId: PgColumn, m: Matcher) {
  return inArray(accountId, db.select({ id: accounts.id }).from(accounts).where(m(accounts.name)));
}

/** Does any line match, by its own text or by the name of the account it posts to? */
function lineMatches(lines: Lines, documentId: PgColumn, m: Matcher) {
  const conditions: (SQL | undefined)[] = lines.text.map(m);
  if (lines.accountId) conditions.push(accountMatches(lines.accountId, m));
  return inArray(
    documentId,
    db.select({ id: lines.documentId }).from(lines.table).where(or(...conditions)),
  );
}

/**
 * The quick search: one term, matched everywhere the module says it may
 * appear, by the rule in matches(). Returns undefined for an empty term so the
 * caller can drop it from the WHERE.
 */
export function quickSearch(spec: DocumentSearch, raw: string | undefined): SQL | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const m: Matcher = (col) => matches(col, trimmed);

  const conditions: (SQL | undefined)[] = (spec.text ?? []).map(m);
  if (spec.contactId) conditions.push(contactMatches(spec.contactId, m));
  if (spec.accountId) conditions.push(accountMatches(spec.accountId, m));
  if (spec.lines && spec.id) conditions.push(lineMatches(spec.lines, spec.id, m));
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
        //
        // A timestamp column (createdAt) is compared by its IST day: compared
        // raw, "<= 2026-09-22" stops at midnight and leaves out the whole of
        // the 22nd. They hold UTC without a zone, hence the double AT TIME ZONE.
        const day =
          field.col.columnType === "PgTimestamp" || field.col.columnType === "PgTimestampString"
            ? sql`((${field.col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date`
            : sql`${field.col}`;
        if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) out.push(sql`${day} >= ${from}::date`);
        if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) out.push(sql`${day} <= ${to}::date`);
        break;
      }
      case "numberRange": {
        const min = value(`${key}Min`);
        const max = value(`${key}Max`);
        // Compared as numbers, not as the strings numeric columns come back as,
        // or "9" would sort above "10".
        // Anything that is not a number is dropped rather than handed to
        // Postgres, where it would fail the whole list.
        if (min && Number.isFinite(Number(min))) out.push(gte(field.col, min));
        if (max && Number.isFinite(Number(max))) out.push(lte(field.col, max));
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
                .where(and(eq(spec.lines.documentId, spec.id!), ilike(field.on, contains(v)))),
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
                .where(and(eq(spec.lines.documentId, spec.id!), eq(spec.lines.itemId, v))),
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
        const m: Matcher = (col) => ilike(col, contains(v));
        if (spec.accountId) out.push(accountMatches(spec.accountId, m));
        else if (spec.lines?.accountId) {
          const lines = spec.lines;
          out.push(
            exists(
              db
                .select(one)
                .from(lines.table)
                .where(and(eq(lines.documentId, spec.id!), accountMatches(lines.accountId!, m))),
            ),
          );
        }
        break;
      }
      case "accountId": {
        const v = value(key);
        if (!v) break;
        if (spec.accountId) out.push(eq(spec.accountId, v));
        else if (spec.lines?.accountId && spec.id) {
          out.push(
            inArray(
              spec.id,
              db.select({ id: spec.lines.documentId }).from(spec.lines.table).where(eq(spec.lines.accountId, v)),
            ),
          );
        }
        break;
      }
      case "anyText": {
        const v = value(key);
        if (v) out.push(or(...field.cols.map((c) => ilike(c, contains(v))))!);
        break;
      }
      case "bool": {
        const v = value(key)?.toLowerCase();
        if (v === "true" || v === "yes") out.push(eq(field.col, true));
        else if (v === "false" || v === "no") out.push(eq(field.col, false));
        break;
      }
      case "custom": {
        const c = field.build(value);
        if (c) out.push(c);
        break;
      }
    }
  }
  return out;
}
