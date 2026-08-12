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

async function defaultSeriesId(tx: Tx): Promise<string> {
  const [row] = await tx
    .select({ id: numberSeries.id })
    .from(numberSeries)
    .where(eq(numberSeries.isDefault, true))
    .limit(1);
  if (!row) throw new PostingError("No default transaction number series is configured");
  return row.id;
}
