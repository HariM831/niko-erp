/**
 * Freight agreed on a purchase order and paid to the transporter by us
 * (22 Oct 2026, migrations/0134_po_freight.sql).
 *
 * Soya comes at so much a ton, pallets at a lump sum a truck. Either way it is
 * part of what the material cost, so each truck's freight is debited to the
 * material's own account — its stock account, for stock — and credited to
 * Freight Payable. Transporters are not vendors: a freight payment clears the
 * trucks it covers out of a bank account, and that is all.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  bankAccounts,
  billLines,
  freightChargeLines,
  freightCharges,
  freightPayments,
  purchaseOrders,
} from "@shared/schema";
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError, postJournal, reverseJournal } from "./posting";
import { fromPaise, toPaise } from "./documents";

/** One material on the truck, as the freight sees it. */
export interface FreightLineInput {
  /** The caller's own key for the line (a receipt line id), handed back on the plan. */
  key: string;
  itemId: string | null;
  /** Where the material's cost goes: its stock account, or its purchase account. */
  accountId: string | null;
  name: string;
  /** The vendor's billed kilos, or null where the line is not weighed. */
  kg: number | null;
  /** The line's value, for splitting a lump sum. */
  value: number;
}

export interface FreightPlan {
  purchaseOrderId: string;
  poNumber: string;
  basis: "per_ton" | "per_truck";
  rate: string;
  quantityKg: string | null;
  amountP: number;
  lines: Array<{ key: string; itemId: string | null; accountId: string; name: string; kg: number | null; amountP: number }>;
}

/** Split a whole across weights in paise; the largest takes the rounding. */
function split(totalP: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!(sum > 0)) return weights.map((_, i) => (i === 0 ? totalP : 0));
  const out = weights.map((w) => Math.floor((totalP * w) / sum));
  const rest = totalP - out.reduce((s, v) => s + v, 0);
  let big = 0;
  weights.forEach((w, i) => {
    if (w > weights[big]!) big = i;
  });
  out[big]! += rest;
  return out;
}

/**
 * What one truck owes in freight, PO by PO, under each order's own terms.
 *
 * Per ton is on the kilos the vendor billed (the user, 22 Oct 2026) and is
 * split across that order's materials by those kilos. A lump sum is charged
 * once per truck per order, split by value.
 */
export async function planFreight(
  tx: Tx | Db,
  groups: Array<{ purchaseOrderId: string; lines: FreightLineInput[] }>,
): Promise<FreightPlan[]> {
  const ids = [...new Set(groups.map((g) => g.purchaseOrderId))];
  if (!ids.length) return [];
  const pos = await tx
    .select({
      id: purchaseOrders.id,
      number: purchaseOrders.number,
      basis: purchaseOrders.freightBasis,
      rate: purchaseOrders.freightRate,
    })
    .from(purchaseOrders)
    .where(inArray(purchaseOrders.id, ids));
  const byId = new Map(pos.map((p) => [p.id, p]));

  const plans: FreightPlan[] = [];
  for (const g of groups) {
    const po = byId.get(g.purchaseOrderId);
    if (!po || po.basis === "none" || !(Number(po.rate) > 0) || !g.lines.length) continue;
    const noAccount = g.lines.find((l) => !l.accountId);
    if (noAccount) {
      throw new PostingError(`${noAccount.name} has no account to carry its freight — set one on the item`);
    }

    let amountP: number;
    let weights: number[];
    let quantityKg: string | null = null;
    if (po.basis === "per_ton") {
      const unweighed = g.lines.find((l) => l.kg == null || !(l.kg > 0));
      if (unweighed) {
        throw new PostingError(
          `${po.number} charges freight per ton, but ${unweighed.name} has no kilos to charge it on`,
        );
      }
      const kg = g.lines.reduce((s, l) => s + l.kg!, 0);
      quantityKg = kg.toFixed(3);
      amountP = Math.round((Number(po.rate) * kg) / 10);
      weights = g.lines.map((l) => l.kg!);
    } else {
      amountP = toPaise(po.rate);
      weights = g.lines.map((l) => Math.max(0, l.value));
    }
    if (amountP <= 0) continue;
    const parts = split(amountP, weights);
    plans.push({
      purchaseOrderId: po.id,
      poNumber: po.number,
      basis: po.basis,
      rate: po.rate,
      quantityKg,
      amountP,
      lines: g.lines.map((l, i) => ({
        key: l.key,
        itemId: l.itemId,
        accountId: l.accountId!,
        name: l.name,
        kg: l.kg,
        amountP: parts[i]!,
      })),
    });
  }
  return plans;
}

/** Each plan line's freight by the caller's key, in paise. */
export function freightByKey(plans: FreightPlan[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of plans) for (const l of p.lines) out.set(l.key, (out.get(l.key) ?? 0) + l.amountP);
  return out;
}

/** Raise the planned charges: one row and one entry per order on the truck. */
export async function postFreightCharges(
  tx: Tx,
  args: {
    plans: FreightPlan[];
    billId: string;
    billNumber: string;
    receiptId?: string | null;
    vehicleNumber?: string | null;
    chargeDate: string;
    userId: string;
  },
): Promise<void> {
  for (const p of args.plans) {
    const [charge] = await tx
      .insert(freightCharges)
      .values({
        billId: args.billId,
        receiptId: args.receiptId ?? null,
        purchaseOrderId: p.purchaseOrderId,
        chargeDate: args.chargeDate,
        vehicleNumber: args.vehicleNumber ?? null,
        basis: p.basis,
        rate: p.rate,
        quantityKg: p.quantityKg,
        amount: fromPaise(p.amountP),
        createdBy: args.userId,
      })
      .returning();
    const lines = p.lines.filter((l) => l.amountP > 0);
    await tx.insert(freightChargeLines).values(
      lines.map((l) => ({
        chargeId: charge!.id,
        itemId: l.itemId,
        accountId: l.accountId,
        name: l.name,
        quantityKg: l.kg != null ? l.kg.toFixed(3) : null,
        amount: fromPaise(l.amountP),
      })),
    );
    const terms =
      p.basis === "per_ton"
        ? `₹${Number(p.rate).toLocaleString("en-IN")}/t on ${Number(p.quantityKg).toLocaleString("en-IN")} kg`
        : `₹${Number(p.rate).toLocaleString("en-IN")} a truck`;
    const what = [args.billNumber, args.vehicleNumber, p.poNumber].filter(Boolean).join(" · ");
    const jeId = await postJournal(tx, {
      entryDate: args.chargeDate,
      narration: `Freight — ${what} (${terms})`,
      sourceType: "freight_charge",
      sourceId: charge!.id,
      postedBy: args.userId,
      lines: [
        ...lines.map((l) => ({ accountId: l.accountId, debit: fromPaise(l.amountP), description: `Freight on ${l.name}` })),
        { systemKey: "freight_payable", credit: fromPaise(p.amountP), description: `Freight — ${what}` },
      ],
    });
    await tx.update(freightCharges).set({ journalEntryId: jeId }).where(eq(freightCharges.id, charge!.id));
  }
}

/**
 * Put a bill's PO freight onto its lines' landed cost.
 *
 * The formulator prices a material at its landed cost, so the freight has to
 * show there. Called after settlement and again after anything that rebuilds
 * the bill's lines (edit, repost). Does nothing to a bill with no PO freight,
 * so freight keyed on the bill itself is left as it is.
 */
export async function applyFreightToBillLines(tx: Tx, billId: string): Promise<void> {
  const rows = await tx
    .select({ itemId: freightChargeLines.itemId, amount: freightChargeLines.amount })
    .from(freightChargeLines)
    .innerJoin(freightCharges, eq(freightCharges.id, freightChargeLines.chargeId))
    .where(and(eq(freightCharges.billId, billId), isNull(freightCharges.voidedAt)));
  if (!rows.length) return;
  const byItem = new Map<string, number>();
  for (const r of rows) if (r.itemId) byItem.set(r.itemId, (byItem.get(r.itemId) ?? 0) + toPaise(r.amount));

  const lines = await tx.select().from(billLines).where(eq(billLines.billId, billId));
  for (const [itemId, freightP] of byItem) {
    const mine = lines.filter((l) => l.itemId === itemId && toPaise(l.amount) > 0);
    if (!mine.length) continue;
    const parts = split(freightP, mine.map((l) => toPaise(l.amount)));
    for (const [i, l] of mine.entries()) {
      const qty = Number(l.quantity);
      const landedP = toPaise(l.amount) + parts[i]!;
      await tx
        .update(billLines)
        .set({
          allocatedFreight: fromPaise(parts[i]!),
          landedUnitCost: qty > 0 ? (landedP / 100 / qty).toFixed(2) : "0",
        })
        .where(eq(billLines.id, l.id));
    }
  }
}

/** A voided bill takes its freight with it — unless a transporter has been paid for it. */
export async function voidFreightForBill(tx: Tx, billId: string, voidDate: string, userId: string): Promise<void> {
  const charges = await tx
    .select({ charge: freightCharges, paymentNumber: freightPayments.number })
    .from(freightCharges)
    .leftJoin(freightPayments, eq(freightPayments.id, freightCharges.freightPaymentId))
    .where(and(eq(freightCharges.billId, billId), isNull(freightCharges.voidedAt)));
  const paid = charges.find((c) => c.charge.freightPaymentId);
  if (paid) {
    throw new PostingError(
      `The freight on this bill was paid in ${paid.paymentNumber} — delete that freight payment first`,
    );
  }
  for (const { charge } of charges) {
    if (charge.journalEntryId) await reverseJournal(tx, charge.journalEntryId, voidDate, userId);
    await tx.update(freightCharges).set({ voidedAt: new Date() }).where(eq(freightCharges.id, charge.id));
  }
}

/** Pay a set of trucks' freight out of one bank account. */
export async function payFreight(
  tx: Tx,
  args: {
    chargeIds: string[];
    paymentDate: string;
    bankAccountId: string;
    transporter?: string;
    reference?: string;
    notes?: string;
    userId: string;
  },
) {
  const ids = [...new Set(args.chargeIds)];
  if (!ids.length) throw new PostingError("Pick the trucks this payment covers");
  const charges = await tx.select().from(freightCharges).where(inArray(freightCharges.id, ids)).for("update");
  if (charges.length !== ids.length) throw new PostingError("A freight charge was not found");
  const taken = charges.find((c) => c.freightPaymentId || c.voidedAt);
  if (taken) throw new PostingError("One of these trucks is already paid, or its bill was voided — refresh the list");
  const bank = await tx.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, args.bankAccountId) });
  if (!bank) throw new PostingError("Bank account not found");

  const totalP = charges.reduce((s, c) => s + toPaise(c.amount), 0);
  const number = await nextDocumentNumber(tx, "freight_payment");
  const [payment] = await tx
    .insert(freightPayments)
    .values({
      number,
      paymentDate: args.paymentDate,
      bankAccountId: bank.id,
      amount: fromPaise(totalP),
      transporter: args.transporter?.trim() || null,
      reference: args.reference?.trim() || null,
      notes: args.notes?.trim() || null,
      createdBy: args.userId,
    })
    .returning();
  const trucks = charges.map((c) => c.vehicleNumber).filter(Boolean);
  const jeId = await postJournal(tx, {
    entryDate: args.paymentDate,
    narration:
      `Freight paid ${number}` +
      (args.transporter?.trim() ? ` — ${args.transporter.trim()}` : "") +
      (trucks.length ? ` · ${trucks.join(", ")}` : ""),
    sourceType: "freight_payment",
    sourceId: payment!.id,
    postedBy: args.userId,
    lines: [
      { systemKey: "freight_payable", debit: fromPaise(totalP) },
      { accountId: bank.glAccountId, credit: fromPaise(totalP) },
    ],
  });
  await tx.update(freightPayments).set({ journalEntryId: jeId }).where(eq(freightPayments.id, payment!.id));
  await tx.update(freightCharges).set({ freightPaymentId: payment!.id }).where(inArray(freightCharges.id, ids));
  return { ...payment!, journalEntryId: jeId };
}

/** Undo a freight payment: its trucks are owed again. Refused once it is matched to a statement line. */
export async function deleteFreightPayment(tx: Tx, id: string, userId: string): Promise<void> {
  const payment = await tx.query.freightPayments.findFirst({ where: eq(freightPayments.id, id) });
  if (!payment) throw new PostingError("Freight payment not found");
  if (payment.journalEntryId) {
    const linked = await tx.execute(
      sql`SELECT 1 FROM bank_transaction_links WHERE journal_entry_id = ${payment.journalEntryId} LIMIT 1`,
    );
    if (linked.rows.length) {
      throw new PostingError(`${payment.number} is matched to a bank statement line — unmatch it in Banking first`);
    }
    await reverseJournal(tx, payment.journalEntryId, payment.paymentDate, userId);
  }
  await tx.update(freightCharges).set({ freightPaymentId: null }).where(eq(freightCharges.freightPaymentId, id));
  await tx.delete(freightPayments).where(eq(freightPayments.id, id));
}
