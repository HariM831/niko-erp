/**
 * Keeping a payment's ledger in step with its applications.
 *
 * The rule, the user's on 22 Oct 2026: when money already received is put
 * against an invoice — or taken off one — after the receipt was recorded, the
 * change posts its own small entry, dated the day of the change and tied to the
 * receipt. The receipt's own journal stays as it was when the money came in.
 *
 * Receivables must equal the open invoices and customer advances the receipts'
 * unapplied total, so a receipt's applications and its postings have to move
 * together. Rather than each path working out its own entry, every path that
 * changes applications takes the payment's position before, makes its change,
 * and settles: the documents moved by so much, the payment's own journals by so
 * much, and the difference is posted. That one measurement is right whatever
 * came before — an edit that re-posts the receipt, a dissociation, a delete
 * that removes every journal the payment owns, or history the payment cannot
 * see (the egg bay's auto-apply and the October allocation scripts posted
 * their entries against the invoice, not the receipt).
 *
 * The buying side is the same. A vendor payment holds its unapplied part in
 * vendor advances — Zoho's always did, and niko's do since 22 Oct 2026 — and
 * that part moves with its applications. A niko payment older than that still
 * has its advance inside payables (advances_in_ledger false), so nothing moves
 * for it until scripts/move-vendor-advances.ts or an edit brings it across.
 */
import { eq, sql } from "drizzle-orm";
import { paymentApplications, vendorPayments } from "@shared/schema";
import { postJournal } from "./posting";
import { fromPaise } from "./documents";
import type { db as Db } from "../db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
export type Side = "vendor" | "customer";

/** Where a payment stands, in paise. Null for a vendor payment that never moves. */
export interface Position {
  side: Side;
  paymentId: string;
  /** Customer: applied to invoices. Vendor: unapplied. */
  held: number;
  /** What the payment's own journals say about the same figure. */
  ledger: number;
}

export async function positionOf(tx: Tx, side: Side, paymentId: string): Promise<Position | null> {
  if (side === "customer") {
    const [a] = await tx
      .select({ v: sql<string>`coalesce(sum(${paymentApplications.amountApplied}), 0)` })
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentId, paymentId));
    return { side, paymentId, held: paise(a!.v), ledger: await moved(tx, "customer_payment", paymentId, "ar", -1) };
  }
  const [p] = await tx
    .select({ unapplied: vendorPayments.unappliedAmount, inLedger: vendorPayments.advancesInLedger })
    .from(vendorPayments)
    .where(eq(vendorPayments.id, paymentId));
  if (!p?.inLedger) return null;
  return {
    side,
    paymentId,
    held: p ? paise(p.unapplied) : 0,
    ledger: await moved(tx, "vendor_payment", paymentId, "vendor_advances", 1),
  };
}

/**
 * Post the difference between how far the documents moved and how far the
 * payment's journals moved since `before`.
 *
 * `gone` is for a delete: the payment, its applications and its journals have
 * just been removed, so it stands at nothing, and the entry is filed as an
 * advance application rather than under a payment that no longer exists.
 */
export async function settlePayment(
  tx: Tx,
  before: Position | null,
  opts: { on: string; userId: string; narration: string; gone?: boolean },
): Promise<void> {
  if (!before) return;
  const after = opts.gone ? { held: 0, ledger: 0 } : await positionOf(tx, before.side, before.paymentId);
  if (!after) return;
  const diffP = after.held - before.held - (after.ledger - before.ledger);
  if (diffP === 0) return;
  const amount = fromPaise(Math.abs(diffP));
  // Customer: more applied than posted → DR advances / CR receivables.
  // Vendor: more unapplied than posted → DR vendor advances / CR payables.
  const [dr, cr] =
    before.side === "customer"
      ? diffP > 0 ? ["customer_advances", "ar"] : ["ar", "customer_advances"]
      : diffP > 0 ? ["vendor_advances", "ap"] : ["ap", "vendor_advances"];
  await postJournal(tx, {
    entryDate: opts.on,
    narration: opts.narration,
    sourceType: opts.gone ? "advance_application" : before.side === "customer" ? "customer_payment" : "vendor_payment",
    sourceId: before.paymentId,
    postedBy: opts.userId,
    lines: [
      { systemKey: dr, debit: amount },
      { systemKey: cr, credit: amount },
    ],
  });
}

/** Net movement on a system account across the journals a payment owns, signed so its normal side is positive. */
async function moved(tx: Tx, sourceType: string, paymentId: string, key: string, sign: 1 | -1): Promise<number> {
  const [r] = (
    await tx.execute(sql`
      SELECT coalesce(sum(l.debit - l.credit), 0)::numeric AS v
        FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        JOIN accounts a ON a.id = l.account_id
       WHERE a.system_key = ${key} AND e.source_type = ${sourceType} AND e.source_id = ${paymentId}`)
  ).rows as Array<{ v: string }>;
  return sign * paise(r!.v);
}

const paise = (v: string | number) => Math.round(Number(v) * 100);
