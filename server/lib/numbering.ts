import { and, eq, sql } from "drizzle-orm";
import { documentSeries, numberSeries } from "@shared/schema";
import type { Tx } from "../db";
import { PostingError } from "../services/posting";

/**
 * Claim the next document number, atomically, inside the caller's transaction.
 *
 * An organisation can run several named series in parallel (Zoho's "Transaction
 * Number Series") — pass `seriesId` to draw from a specific one, or omit it to
 * use the default. The row-level lock taken by UPDATE serialises concurrent
 * claims; a rolled-back transaction releases the number only if no later number
 * was issued (acceptable gap-on-failure semantics).
 */
export async function nextDocumentNumber(
  tx: Tx,
  entity: string,
  seriesId?: string | null,
): Promise<string> {
  const resolvedSeriesId = seriesId ?? (await defaultSeriesId(tx));

  const [row] = await tx
    .update(documentSeries)
    .set({ nextNumber: sql`${documentSeries.nextNumber} + 1` })
    .where(
      and(eq(documentSeries.entity, entity), eq(documentSeries.seriesId, resolvedSeriesId)),
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
  return `${row.prefix}${String(row.claimed).padStart(row.padding, "0")}`;
}

/**
 * Tables a released number can be reclaimed from.
 *
 * A whitelist rather than a computed table name: `entity` reaches this from a
 * route, and an identifier interpolated into DDL-shaped SQL is exactly the
 * thing that must never be caller-controlled.
 */
const NUMBER_SOURCES: Record<string, { table: string; column: string }> = {
  office_receipt: { table: "office_receipts", column: "number" },
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

  const table = sql.identifier(source.table);
  const column = sql.identifier(source.column);

  for (const series of rows) {
    // The sequence is whatever follows the prefix. Only all-digit remainders
    // count, so a hand-edited or imported number in some other shape is
    // ignored rather than crashing the cast.
    // The ::int cast is load-bearing. A bare bind parameter here is typed as
    // text, which silently selects substring(string from pattern) — the regex
    // form — and every number comes back empty.
    const suffixFrom = sql`${series.prefix.length + 1}::int`;
    const result = await tx.execute(sql`
      SELECT COALESCE(MAX(substring(${column} from ${suffixFrom})::bigint), 0) AS max_seq
      FROM ${table}
      WHERE ${column} LIKE ${`${series.prefix}%`}
        AND substring(${column} from ${suffixFrom}) ~ '^[0-9]+$'
    `);
    const highest = Number((result.rows[0] as { max_seq: string } | undefined)?.max_seq ?? 0);
    const shouldBe = highest + 1;
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

async function defaultSeriesId(tx: Tx): Promise<string> {
  const [row] = await tx
    .select({ id: numberSeries.id })
    .from(numberSeries)
    .where(eq(numberSeries.isDefault, true))
    .limit(1);
  if (!row) throw new PostingError("No default transaction number series is configured");
  return row.id;
}
