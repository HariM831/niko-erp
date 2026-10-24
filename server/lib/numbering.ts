import { and, eq, sql } from "drizzle-orm";
import { documentSeries, numberSeries, orgProfile } from "@shared/schema";
import type { Tx } from "../db";
import { PostingError } from "../services/posting";

/** Stands in a prefix for the financial year: "A-PO-{FY}-" issues A-PO-27-0001 in FY 2026-27. */
const FY_TOKEN = "{FY}";

/**
 * The financial year as a prefix shows it: the two-digit year it ends in.
 * 3 Oct 2026 with an April start is FY 2026-27, so "27"; from 1 Apr 2027,
 * "28". With a January start the year is the calendar year, so "26".
 */
export function fyTag(date: string, start = "04-01"): string {
  const year = Number(date.slice(0, 4));
  const from = date.slice(5, 10) >= start ? year : year - 1;
  const ends = start === "01-01" ? from : from + 1;
  return String(ends % 100).padStart(2, "0");
}

/**
 * Claim the next document number, atomically, inside the caller's transaction.
 *
 * An organisation can run several named series in parallel (Zoho's "Transaction
 * Number Series") — pass `seriesId` to draw from a specific one, or omit it to
 * use the default. The row-level lock taken by UPDATE serialises concurrent
 * claims; a rolled-back transaction releases the number only if no later number
 * was issued (acceptable gap-on-failure semantics).
 *
 * A prefix holding {FY} numbers each financial year from 0001 again, by the
 * document's own `date`: A-PO-27-0412 on 31 Mar 2027, A-PO-28-0001 on 1 Apr.
 * The count is then taken from the numbers the year already has, under the
 * same row lock — one counter cannot serve two years, and a PO keyed in April
 * but dated March still lands in March's year. Only for entities listed in
 * NUMBER_SOURCES, and only safe where a document is never deleted.
 */
export async function nextDocumentNumber(
  tx: Tx,
  entity: string,
  seriesId?: string | null,
  date?: string,
): Promise<string> {
  const resolvedSeriesId = seriesId ?? (await defaultSeriesId(tx));

  // documentSeries carries the counter; isActive lives on its parent
  // numberSeries — a deactivated series must stop handing out numbers even
  // though the per-entity row it owns is otherwise perfectly usable.
  const [row] = await tx
    .update(documentSeries)
    .set({ nextNumber: sql`${documentSeries.nextNumber} + 1` })
    .where(
      and(
        eq(documentSeries.entity, entity),
        eq(documentSeries.seriesId, resolvedSeriesId),
        sql`${documentSeries.seriesId} IN (SELECT id FROM ${numberSeries} WHERE is_active)`,
      ),
    )
    .returning({
      prefix: documentSeries.prefix,
      claimed: sql<number>`${documentSeries.nextNumber} - 1`,
      padding: documentSeries.padding,
    });
  if (!row) {
    // A bad or inactive series is caller error, not a server fault — PostingError
    // makes the routes answer 422 instead of letting the rejection escape.
    throw new PostingError(
      `No numbering is configured for "${entity}" in the selected number series`,
    );
  }
  if (!row.prefix.includes(FY_TOKEN)) {
    return `${row.prefix}${String(row.claimed).padStart(row.padding, "0")}`;
  }

  const source = NUMBER_SOURCES[entity];
  if (!source || !date) {
    throw new PostingError(`The "${entity}" number series uses {FY}, which needs a dated document`);
  }
  const [org] = await tx.select({ fyStart: orgProfile.fiscalYearStart }).from(orgProfile).limit(1);
  const prefix = row.prefix.replace(FY_TOKEN, fyTag(date, org?.fyStart));
  const highest = await highestNumber(tx, source, prefix);
  const claimed = highest + 1;
  // The counter follows the year, so Settings shows the number coming next.
  await tx
    .update(documentSeries)
    .set({ nextNumber: claimed + 1 })
    .where(and(eq(documentSeries.entity, entity), eq(documentSeries.seriesId, resolvedSeriesId)));
  return `${prefix}${String(claimed).padStart(row.padding, "0")}`;
}

/** The highest all-digit sequence after `prefix` in a source table, or 0. */
async function highestNumber(
  tx: Tx,
  source: { table: string; column: string },
  prefix: string,
): Promise<number> {
  const table = sql.identifier(source.table);
  const column = sql.identifier(source.column);
  // The sequence is whatever follows the prefix. Only all-digit remainders
  // count, so a hand-edited or imported number in some other shape is
  // ignored rather than crashing the cast.
  // The ::int cast is load-bearing. A bare bind parameter here is typed as
  // text, which silently selects substring(string from pattern) — the regex
  // form — and every number comes back empty.
  const suffixFrom = sql`${prefix.length + 1}::int`;
  const result = await tx.execute(sql`
    SELECT COALESCE(MAX(substring(${column} from ${suffixFrom})::bigint), 0) AS max_seq
    FROM ${table}
    WHERE ${column} LIKE ${`${prefix}%`}
      AND substring(${column} from ${suffixFrom}) ~ '^[0-9]+$'
  `);
  return Number((result.rows[0] as { max_seq: string } | undefined)?.max_seq ?? 0);
}

/**
 * Tables a series' issued numbers can be read back from: to reclaim a released
 * number, or to count a {FY} prefix's year.
 *
 * A whitelist rather than a computed table name: `entity` reaches this from a
 * route, and an identifier interpolated into DDL-shaped SQL is exactly the
 * thing that must never be caller-controlled.
 */
const NUMBER_SOURCES: Record<string, { table: string; column: string }> = {
  office_receipt: { table: "office_receipts", column: "number" },
  purchase_order: { table: "purchase_orders", column: "number" },
};

/**
 * Recompute a series counter from the documents that actually survive.
 *
 * Called after a delete so a discarded document does not leave a hole in the
 * sequence. Deliberately a recompute rather than a decrement: deleting three
 * receipts at once, or the second-newest of five, both land correctly, and
 * running it twice changes nothing the second time.
 *
 * It only ever moves the counter DOWN to one past the highest surviving
 * number. A gap in the middle stays a gap — resetting into it would hand out a
 * number that already exists, and the unique index would then reject a
 * perfectly good receipt at the gate.
 *
 * **Only safe for a document that never went anywhere.** A number that has been
 * quoted on a bill must never be issued again, even if that bill is later
 * voided: a void document still references GR-00007, and a second GR-00007
 * makes that reference ambiguous for good. Callers are responsible for
 * refusing the delete in that case — see the receipt delete route, which will
 * not touch a receipt that has produced a bill, void or otherwise.
 */
export async function resyncDocumentNumber(tx: Tx, entity: string): Promise<void> {
  const source = NUMBER_SOURCES[entity];
  if (!source) return;

  // Every series for this entity, not just the default: the deleted document
  // carries only its number, not the series it came from, so each is checked
  // against its own prefix. Locked first, so a concurrent claim cannot slip
  // between the MAX() below and the UPDATE that follows it.
  const rows = await tx
    .select({
      seriesId: documentSeries.seriesId,
      prefix: documentSeries.prefix,
      nextNumber: documentSeries.nextNumber,
    })
    .from(documentSeries)
    .where(eq(documentSeries.entity, entity))
    .for("update");

  for (const series of rows) {
    const shouldBe = (await highestNumber(tx, source, series.prefix)) + 1;
    // Only ever downwards, and never into a gap in the middle.
    if (shouldBe >= series.nextNumber) continue;

    await tx
      .update(documentSeries)
      .set({ nextNumber: shouldBe })
      .where(
        and(eq(documentSeries.entity, entity), eq(documentSeries.seriesId, series.seriesId)),
      );
  }
}

/**
 * Move a counter past numbers written directly, without going through
 * nextDocumentNumber — the Zoho loaders number in bulk. Without this the next
 * document created in the app is handed a number the load already used, and the
 * unique index refuses it (BILL-002272, 17 Oct 2026).
 *
 * Only the series issuing `prefix`, and only ever forwards.
 */
export async function advanceSeriesPast(
  tx: Tx,
  entity: string,
  prefix: string,
  nextNumber: number,
): Promise<void> {
  await tx
    .update(documentSeries)
    .set({ nextNumber: sql`GREATEST(${documentSeries.nextNumber}, ${nextNumber})` })
    .where(and(eq(documentSeries.entity, entity), eq(documentSeries.prefix, prefix)));
}

async function defaultSeriesId(tx: Tx): Promise<string> {
  const [row] = await tx
    .select({ id: numberSeries.id })
    .from(numberSeries)
    .where(eq(numberSeries.isDefault, true))
    .limit(1);
  if (!row) throw new PostingError("No default transaction number series is configured");
  return row.id;
}
