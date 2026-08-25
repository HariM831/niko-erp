import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  aiObservations,
  bills,
  creditNotes,
  customerPayments,
  expenses,
  fixedAssets,
  inventoryAdjustments,
  invoices,
  items,
  journalEntries,
  officeReceiptLines,
  officeReceipts,
  purchaseOrders,
  vendorCredits,
  vendorPayments,
  contacts,
} from "@shared/schema";
import type { Db, Tx } from "../db";

type Conn = Db | Tx;

/**
 * The table behind every key in `ATTACHABLE_ENTITIES` (shared/entities.ts).
 * Kept as its own small map rather than derived from `ENTITIES`, since that
 * list carries no table reference and a wrong guess here would either reject
 * a legitimate attachment or silently accept one on a record that doesn't
 * exist — the exact thing this file exists to prevent.
 */
const TABLE_OF: Record<string, PgTable> = {
  contact: contacts,
  item: items,
  invoice: invoices,
  credit_note: creditNotes,
  customer_payment: customerPayments,
  bill: bills,
  purchase_order: purchaseOrders,
  vendor_credit: vendorCredits,
  vendor_payment: vendorPayments,
  expense: expenses,
  journal_entry: journalEntries,
  fixed_asset: fixedAssets,
  inventory_adjustment: inventoryAdjustments,
  office_receipt: officeReceipts,
  office_receipt_line: officeReceiptLines,
  ai_observation: aiObservations,
};

/**
 * Does this entityType/entityId pair name a real row? `entityType` should
 * already be checked against `ATTACHABLE_ENTITIES` before this runs — an
 * unmapped type is treated as "not found" rather than throwing, so a future
 * entity added there and forgotten here fails closed.
 */
export async function entityExists(
  conn: Conn,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const table = TABLE_OF[entityType];
  if (!table) return false;
  const idCol = (table as unknown as { id: unknown }).id;
  const [row] = await conn
    .select({ id: idCol as never })
    .from(table as never)
    .where(eq(idCol as never, entityId))
    .limit(1);
  return !!row;
}
