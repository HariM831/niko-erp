/**
 * Advanced-search fields the mill's own records need and the document kinds
 * in document-search.ts do not cover: goods receipts, weigh slips, production
 * runs and feed transfers.
 *
 * Three things differ from a bill. These records are dated by a timestamp (the
 * moment a truck arrived, the moment it was weighed) rather than a document
 * date, and a "YYYY-MM-DD" compared against a timestamp stops at midnight — a
 * range ending on the 22nd would leave out everything weighed on the 22nd. So
 * the day is taken in IST, the way the office dashboard counts "today", and
 * compared as a date.
 *
 * A vehicle number is asked for the way it is painted — "AS 12 AB 1234" — and
 * stored without the spaces, so both sides are compared with them stripped.
 *
 * And some ranges are over a figure the row does not store, such as the kilos
 * summed across a receipt's lines, so a range can take any SQL expression.
 * Each returns a `custom` field for an `advanced` map.
 */
import { type SQL, and, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Field } from "./document-search";
import { contains } from "./document-search";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A figure typed into a range box, or nothing if it is not a number. */
const num = (v: string | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? v : undefined);

/**
 * The IST calendar day of a timestamp.
 *
 * The columns are `timestamp without time zone` holding UTC (the database runs
 * on GMT and fills them with now()). A bare `AT TIME ZONE 'Asia/Kolkata'` on
 * such a value reads it as already being IST and shifts it the wrong way, so a
 * truck weighed at 04:00 IST lands on the day before. Saying it is UTC first
 * gives an instant; the second AT TIME ZONE turns that into IST wall time.
 */
export const istDay = (expr: PgColumn | SQL): SQL =>
  sql`((${expr} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date`;

/**
 * Reads `<key>From` and `<key>To` and keeps rows whose day falls between them,
 * both ends included. `day` is the expression that yields the day — a date
 * column as it is, or istDay() of a timestamp.
 */
export function dayRange(key: string, day: PgColumn | SQL): Field {
  return {
    kind: "custom",
    build: (get) => {
      const from = get(`${key}From`);
      const to = get(`${key}To`);
      return and(
        from && DAY.test(from) ? sql`${day} >= ${from}::date` : undefined,
        to && DAY.test(to) ? sql`${day} <= ${to}::date` : undefined,
      );
    },
  };
}

/**
 * Reads `<key>Min` and `<key>Max` against any numeric expression. A box with
 * something other than a number in it is ignored rather than sent to Postgres
 * to fail the whole list.
 */
export function amountRange(key: string, expr: PgColumn | SQL): Field {
  return {
    kind: "custom",
    build: (get) => {
      const min = num(get(`${key}Min`));
      const max = num(get(`${key}Max`));
      return and(
        min ? sql`${expr} >= ${min}::numeric` : undefined,
        max ? sql`${expr} <= ${max}::numeric` : undefined,
      );
    },
  };
}

/** A vehicle number matched anywhere in the plate, spaces ignored on both sides. */
export function plate(key: string, col: PgColumn): Field {
  return {
    kind: "custom",
    build: (get) => {
      const v = get(key)?.replace(/\s+/g, "");
      return v ? sql`regexp_replace(${col}, '\\s', '', 'g') ILIKE ${contains(v)}` : undefined;
    },
  };
}
