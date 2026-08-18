/**
 * Finding the purchase order a delivery belongs to.
 *
 * No Indian trade bill carries a PO number, so the link is never read — it is
 * established from what the paperwork and the order must have in common.
 *
 * **Every condition is hard.** Vendor, material, rate, quantity and date each
 * pass or the order is not a match; there is no score to trade one against
 * another. A near-miss on the rate is not three-quarters of a match, it is a
 * different price than we agreed, and the truck waits until somebody says why.
 *
 * The reasons come back in words either way, because the person deciding
 * whether to turn a loaded truck away has to see which condition failed.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { items, purchaseOrderLines, purchaseOrders } from "@shared/schema";
import { getPreferences } from "./preferences";
import type { Db, Tx } from "../db";
import type { LineMatch, MatchReason, PoCandidate } from "@shared/po-match-types";

export type { LineMatch, MatchMethod, MatchReason, PoCandidate } from "@shared/po-match-types";

/** A purchase order is open to receiving in exactly these states. */
export const OPEN_PO_STATUSES = ["issued", "partially_billed"] as const;

/**
 * How far the bill's rate may sit from the order's and still be the same price.
 * A paisa, to absorb the rounding in deriving ₹/kg from a per-quintal figure —
 * not to tolerate a renegotiation nobody recorded.
 */
export const RATE_TOLERANCE = 0.01;

/**
 * How much over the outstanding quantity a delivery may run, in percent, when
 * the org has expressed no preference. Read from preferences.poOverDeliveryPct
 * in practice — see that column for why this cannot be zero.
 */
export const DEFAULT_QUANTITY_TOLERANCE_PCT = 1;

/** How far either side of the expected delivery date still counts as on time. */
export const DATE_WINDOW_DAYS = 14;

/** A line of the bill, as far as matching cares about it. */
export interface LineToMatch {
  itemId?: string | null;
  itemName?: string | null;
  quantityKg?: number | null;
  ratePerKg?: number | null;
}

const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
const kg = (v: number) => `${v.toLocaleString("en-IN")} kg`;

function checkRate(billRate: number | null, poRate: number): MatchReason {
  if (billRate == null) {
    return { factor: "rate", passed: false, detail: "No rate on the bill to compare" };
  }
  const passed = Math.abs(billRate - poRate) <= RATE_TOLERANCE;
  return {
    factor: "rate",
    passed,
    detail: passed
      ? `Rate ₹${billRate.toFixed(2)}/kg is the agreed rate`
      : `Rate ₹${billRate.toFixed(2)}/kg, but the order says ₹${poRate.toFixed(2)}/kg`,
  };
}

function checkQuantity(qty: number | null, remaining: number, tolerancePct: number): MatchReason {
  if (qty == null) {
    return { factor: "quantity", passed: false, detail: "No quantity on the bill" };
  }
  const ceiling = remaining * (1 + tolerancePct / 100);
  const passed = qty <= ceiling;
  const over = qty - remaining;
  return {
    factor: "quantity",
    passed,
    detail: passed
      ? over > 0
        ? `${kg(qty)} is ${kg(Number(over.toFixed(3)))} over the ${kg(remaining)} still due, ` +
          `within the ${tolerancePct}% allowed`
        : `${kg(qty)} is within the ${kg(remaining)} still due`
      : `${kg(qty)} is more than the ${kg(remaining)} still due, ` +
        `beyond the ${tolerancePct}% allowed`,
  };
}

function checkDate(billDate: string | null, expected: string | null): MatchReason {
  // An order with no expected date cannot fail this condition; there is nothing
  // to be late for.
  if (!expected) {
    return { factor: "date", passed: true, detail: "The order sets no expected delivery date" };
  }
  if (!billDate) {
    return { factor: "date", passed: false, detail: "No date on the bill to compare" };
  }
  const days = Math.round(
    (new Date(`${billDate}T00:00:00Z`).getTime() - new Date(`${expected}T00:00:00Z`).getTime()) /
      86_400_000,
  );
  const off = Math.abs(days);
  const when = off === 0 ? "on the expected date" : `${off} day${off === 1 ? "" : "s"} ${days < 0 ? "early" : "late"}`;
  const passed = off <= DATE_WINDOW_DAYS;
  return {
    factor: "date",
    passed,
    detail: passed ? `Arrived ${when}` : `Arrived ${when} — outside the ${DATE_WINDOW_DAYS}-day window`,
  };
}

/**
 * Match each line of a bill to an open purchase order line.
 *
 * Lines are matched in order and a PO line claimed by one is never offered to
 * the next, which is what makes a multi-line bill safe.
 */
export async function matchPurchaseOrderLines(
  db: Db | Tx,
  input: { vendorId: string | null; billDate: string | null; lines: LineToMatch[] },
): Promise<LineMatch[]> {
  const { vendorId, billDate, lines } = input;

  const none = (message: string): LineMatch[] =>
    lines.map((_, i) => ({
      lineNo: i + 1,
      method: "unmatched" as const,
      chosen: null,
      candidates: [],
      message,
    }));

  if (!vendorId) return none("Identify the vendor before an order can be matched");

  // Read here rather than taking it as an argument, so every caller of the
  // matcher honours the same setting and none can be given a different one.
  const tolerancePct = Number((await getPreferences(db)).poOverDeliveryPct);

  const open = await db
    .select({
      poId: purchaseOrders.id,
      poNumber: purchaseOrders.number,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      lineId: purchaseOrderLines.id,
      itemId: purchaseOrderLines.itemId,
      name: purchaseOrderLines.name,
      rate: purchaseOrderLines.rate,
      quantity: purchaseOrderLines.quantity,
      delivered: purchaseOrderLines.deliveredQuantity,
    })
    .from(purchaseOrders)
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .where(
      and(
        eq(purchaseOrders.vendorId, vendorId),
        inArray(purchaseOrders.status, [...OPEN_PO_STATUSES]),
        // Only what the vendor still owes us.
        sql`${purchaseOrderLines.deliveredQuantity} < ${purchaseOrderLines.quantity}`,
      ),
    );

  if (!open.length) return none("This vendor has no open order with anything still due");

  // Alias lookup, so "DORB" on a bill finds "De-Oiled Rice Bran" on the order.
  const itemIds = [...new Set(open.map((o) => o.itemId).filter(Boolean))] as string[];
  const master = itemIds.length
    ? await db
        .select({ id: items.id, name: items.name, aliases: items.aliases })
        .from(items)
        .where(inArray(items.id, itemIds))
    : [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliasesById = new Map(master.map((m) => [m.id, [m.name, ...(m.aliases ?? [])].map(norm)]));

  const claimed = new Set<string>();
  const out: LineMatch[] = [];

  for (const [i, line] of lines.entries()) {
    const candidates: PoCandidate[] = [];

    for (const po of open) {
      if (claimed.has(po.lineId)) continue;
      const remaining = n(po.quantity) - n(po.delivered);
      if (remaining <= 0) continue;

      // Material decides whether this order is even in the conversation. A
      // maize order is not a near-match for rice bran at any rate.
      const sameItem = !!line.itemId && !!po.itemId && line.itemId === po.itemId;
      const knownAs =
        !!line.itemName && !!po.itemId && (aliasesById.get(po.itemId) ?? []).includes(norm(line.itemName));
      if (!sameItem && !knownAs) continue;

      const reasons: MatchReason[] = [
        {
          factor: "material",
          passed: true,
          detail: sameItem ? `${po.name} is on this order` : `"${line.itemName}" is a known name for ${po.name}`,
        },
        checkRate(line.ratePerKg ?? null, n(po.rate)),
        checkQuantity(line.quantityKg ?? null, remaining, tolerancePct),
        checkDate(billDate, po.expectedDeliveryDate),
      ];

      candidates.push({
        purchaseOrderId: po.poId,
        poLineId: po.lineId,
        poNumber: po.poNumber,
        itemId: po.itemId,
        itemName: po.name,
        unitRate: n(po.rate),
        orderedQuantity: n(po.quantity),
        remainingQuantity: remaining,
        expectedDeliveryDate: po.expectedDeliveryDate,
        matched: reasons.every((r) => r.passed),
        reasons,
      });
    }

    const passing = candidates.filter((c) => c.matched);

    if (passing.length === 1) {
      const chosen = passing[0]!;
      claimed.add(chosen.poLineId);
      out.push({ lineNo: i + 1, method: "matched", chosen, candidates, message: `Matched to ${chosen.poNumber}` });
      continue;
    }

    if (passing.length > 1) {
      // Two orders for the same material at the same rate with room on both.
      // Nothing distinguishes them, so a person picks rather than the code.
      out.push({
        lineNo: i + 1,
        method: "choose",
        chosen: null,
        candidates: passing,
        message: `${passing.length} orders fit this delivery — choose one`,
      });
      continue;
    }

    // Name the nearest miss and exactly which conditions failed. "No match" on
    // its own tells a guard nothing they can act on; "the rate is ₹26.50 but
    // the order says ₹23.10" tells them to ring the purchaser.
    const nearest = candidates[0];
    out.push({
      lineNo: i + 1,
      method: "unmatched",
      chosen: null,
      candidates,
      message: nearest
        ? `${nearest.poNumber}: ${nearest.reasons.filter((r) => !r.passed).map((r) => r.detail).join("; ")}`
        : "Nothing on order from this vendor matches this material",
    });
  }

  return out;
}
