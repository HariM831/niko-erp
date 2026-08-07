import { eq, sql } from "drizzle-orm";
import { documentSeries } from "@shared/schema";
import type { Tx } from "../db";

/**
 * Claim the next document number for a series, atomically, inside the
 * caller's transaction. The row-level lock taken by UPDATE serialises
 * concurrent claims; a rolled-back transaction releases the number only
 * if no later number was issued (acceptable gap-on-failure semantics).
 */
export async function nextDocumentNumber(
  tx: Tx,
  entity: string,
): Promise<string> {
  const [row] = await tx
    .update(documentSeries)
    .set({ nextNumber: sql`${documentSeries.nextNumber} + 1` })
    .where(eq(documentSeries.entity, entity))
    .returning({
      prefix: documentSeries.prefix,
      claimed: sql<number>`${documentSeries.nextNumber} - 1`,
      padding: documentSeries.padding,
    });
  if (!row) throw new Error(`No document series configured for "${entity}"`);
  return `${row.prefix}${String(row.claimed).padStart(row.padding, "0")}`;
}
