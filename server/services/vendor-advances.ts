import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  paymentBatchLines,
  paymentBatches,
  purchaseOrders,
  users,
  vendorAdvanceRequests,
  vendorPayments,
} from "@shared/schema";
import type { Db, Tx } from "../db";
import { nextDocumentNumber } from "../lib/numbering";
import { fromPaise, toPaise } from "./documents";
import { PostingError } from "./posting";

/**
 * Advances asked for against a purchase order, before its bill
 * (docs/vendor-advances-and-batches-plan.md).
 *
 * A request is not money and posts nothing. It waits on the Vendor Sheet's
 * Advances tab, goes to the bank in a batch like a bill, and only Mark paid on
 * that batch turns it into a vendor payment — one with nothing applied, held
 * in Vendor Advances until the order's bill takes it.
 */

/** Orders an advance can still be asked for on: issued, and not billed in full. */
const ADVANCEABLE = new Set(["issued", "partially_billed"]);

export interface AdvanceRequestInput {
  purchaseOrderId: string;
  amount: string;
  proformaNumber?: string | null;
  proformaDate?: string | null;
  notes?: string | null;
  seriesId?: string | null;
}

export async function createAdvanceRequest(tx: Tx, input: AdvanceRequestInput, userId: string) {
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.purchaseOrderId))
    .for("update")
    .limit(1);
  if (!po) throw new PostingError("Purchase order not found");
  if (!ADVANCEABLE.has(po.status)) {
    throw new PostingError(
      po.status === "draft"
        ? `${po.number} is still a draft — issue it before asking for an advance`
        : `${po.number} is ${po.status.replace(/_/g, " ")}, so no advance can be asked for on it`,
    );
  }
  const amountP = toPaise(input.amount);
  if (amountP <= 0) throw new PostingError("The advance must be more than nothing");

  // An order cannot be paid ahead for more than it is worth. Open and paid
  // requests both count; a cancelled one gave its share back.
  const [taken] = await tx
    .select({ v: sql<string>`coalesce(sum(${vendorAdvanceRequests.amount}), 0)` })
    .from(vendorAdvanceRequests)
    .where(
      and(
        eq(vendorAdvanceRequests.purchaseOrderId, po.id),
        inArray(vendorAdvanceRequests.status, ["open", "paid"]),
      ),
    );
  const takenP = toPaise(taken!.v);
  const totalP = toPaise(po.total);
  if (takenP + amountP > totalP) {
    throw new PostingError(
      `${po.number} is for ${fromPaise(totalP)} and already has ${fromPaise(takenP)} in advances — ` +
        `at most ${fromPaise(Math.max(0, totalP - takenP))} more can be asked for`,
    );
  }

  const number = await nextDocumentNumber(tx, "vendor_advance_request", input.seriesId);
  const [created] = await tx
    .insert(vendorAdvanceRequests)
    .values({
      number,
      purchaseOrderId: po.id,
      vendorId: po.vendorId,
      amount: fromPaise(amountP),
      proformaNumber: input.proformaNumber?.trim() || null,
      proformaDate: input.proformaDate || null,
      notes: input.notes?.trim() || null,
      createdBy: userId,
    })
    .returning();
  return created!;
}

/**
 * Withdraw a request nobody will pay. Kept, marked, with the reason. One in a
 * live batch is refused: the file may already be at the bank, so the transfer
 * is cancelled first, on Sent to bank, by whoever knows it did not go.
 */
export async function cancelAdvanceRequest(tx: Tx, id: string, reason: string, userId: string) {
  const [req] = await tx
    .select()
    .from(vendorAdvanceRequests)
    .where(eq(vendorAdvanceRequests.id, id))
    .for("update")
    .limit(1);
  if (!req) throw new PostingError("Advance request not found");
  if (req.status === "paid") {
    throw new PostingError(`${req.number} is paid — delete its payment to undo it`);
  }
  if (req.status === "cancelled") throw new PostingError(`${req.number} is already cancelled`);
  const [live] = await tx
    .select({ batch: paymentBatches.number })
    .from(paymentBatchLines)
    .innerJoin(paymentBatches, eq(paymentBatches.id, paymentBatchLines.batchId))
    .where(and(eq(paymentBatchLines.advanceRequestId, req.id), sql`${paymentBatchLines.cancelledAt} IS NULL`))
    .limit(1);
  if (live) {
    throw new PostingError(`${req.number} is in ${live.batch} — cancel that transfer on Sent to bank first`);
  }
  const [updated] = await tx
    .update(vendorAdvanceRequests)
    .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: userId, cancelReason: reason })
    .where(eq(vendorAdvanceRequests.id, req.id))
    .returning();
  return updated!;
}

/** A purchase order's advances, newest first, each with where it has got to. */
export async function advancesForOrder(conn: Db | Tx, purchaseOrderId: string) {
  const rows = await conn
    .select({
      id: vendorAdvanceRequests.id,
      number: vendorAdvanceRequests.number,
      amount: vendorAdvanceRequests.amount,
      proformaNumber: vendorAdvanceRequests.proformaNumber,
      proformaDate: vendorAdvanceRequests.proformaDate,
      notes: vendorAdvanceRequests.notes,
      status: vendorAdvanceRequests.status,
      createdAt: vendorAdvanceRequests.createdAt,
      createdByName: users.name,
      cancelReason: vendorAdvanceRequests.cancelReason,
      vendorPaymentId: vendorAdvanceRequests.vendorPaymentId,
      paymentNumber: vendorPayments.number,
      paymentDate: vendorPayments.paymentDate,
      /** What the bill has not yet taken of it. */
      unapplied: vendorPayments.unappliedAmount,
      sentBatchId: sql<string | null>`(
        SELECT pb.id FROM payment_batch_lines l JOIN payment_batches pb ON pb.id = l.batch_id
         WHERE l.advance_request_id = ${vendorAdvanceRequests.id} AND l.cancelled_at IS NULL
         ORDER BY pb.created_at DESC LIMIT 1)`,
      sentBatchNumber: sql<string | null>`(
        SELECT pb.number FROM payment_batch_lines l JOIN payment_batches pb ON pb.id = l.batch_id
         WHERE l.advance_request_id = ${vendorAdvanceRequests.id} AND l.cancelled_at IS NULL
         ORDER BY pb.created_at DESC LIMIT 1)`,
    })
    .from(vendorAdvanceRequests)
    .leftJoin(users, eq(users.id, vendorAdvanceRequests.createdBy))
    .leftJoin(vendorPayments, eq(vendorPayments.id, vendorAdvanceRequests.vendorPaymentId))
    .where(eq(vendorAdvanceRequests.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(vendorAdvanceRequests.createdAt));
  return rows;
}
