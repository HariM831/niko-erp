import { inArray } from "drizzle-orm";
import { items, orgProfile, taxes } from "@shared/schema";
import type { Tx } from "../db";
import { applyRounding, getPreferences } from "./preferences";

/** All arithmetic in integer paise to avoid float drift; output as "0.00" strings. */
const toPaise = (s: string | number | undefined): number =>
  Math.round(Number(s ?? 0) * 100);
const fromPaise = (p: number): string => (p / 100).toFixed(2);

export interface DocLineInput {
  itemId?: string;
  accountId?: string;
  name: string;
  description?: string;
  hsnOrSac?: string;
  quantity: string;
  unit?: string;
  rate: string;
  discountPercent?: string;
  taxId?: string;
  /** Reporting tag options, carried through to the line's ledger posting. */
  tagOptionIds?: string[];
}

export interface ComputedLine extends DocLineInput {
  taxAmount: string;
  amount: string;
  lineOrder: number;
}

export interface ComputedTotals {
  subTotal: string;
  discountTotal: string;
  cgst: string;
  sgst: string;
  igst: string;
  adjustment: string;
  adjustmentAccountId: string | null;
  adjustmentDescription: string | null;
  roundOff: string;
  total: string;
  lines: ComputedLine[];
}

/**
 * Compute line amounts and header totals server-side. Client-sent amounts are
 * never trusted. GST splits CGST/SGST when the place of supply matches the
 * org's home state, else IGST. Grand total is rounded to the nearest rupee
 * with the difference recorded as roundOff (Zoho behaviour).
 */
export async function computeDocumentTotals(
  tx: Tx,
  lines: DocLineInput[],
  placeOfSupplyState: string | null | undefined,
  /**
   * A manual correction to the total. Applied after tax and before rounding,
   * which is the order Zoho uses, so a document that rounds to the rupee still
   * rounds the figure the reader actually pays.
   */
  adjustment?: { amount: string; accountId?: string | null; description?: string | null },
): Promise<ComputedTotals> {
  const taxIds = [...new Set(lines.map((l) => l.taxId).filter((v): v is string => !!v))];
  const taxRows = taxIds.length
    ? await tx.select().from(taxes).where(inArray(taxes.id, taxIds))
    : [];
  const rateByTax = new Map(taxRows.map((t) => [t.id, Number(t.rate)]));
  for (const id of taxIds) {
    if (!rateByTax.has(id)) throw new Error(`Unknown tax: ${id}`);
  }

  const [org] = await tx
    .select({ stateCode: orgProfile.stateCode })
    .from(orgProfile)
    .limit(1);
  const homeState = org?.stateCode ?? null;
  const interState =
    !!placeOfSupplyState && !!homeState && placeOfSupplyState !== homeState;

  let subTotalP = 0;
  let discountP = 0;
  let taxTotalP = 0;

  const computed: ComputedLine[] = lines.map((l, i) => {
    const qty = Number(l.quantity);
    // Multiplied at the rate's own precision rather than rounding it to paise
    // first: feed is priced to six decimals, and truncating 24.813751 to 24.81
    // moves a 393,440 kg line by nearly two thousand rupees.
    const grossP = Math.round(qty * Number(l.rate) * 100);
    const discPct = Number(l.discountPercent ?? 0);
    const lineDiscP = Math.round((grossP * discPct) / 100);
    const netP = grossP - lineDiscP;
    const taxRate = l.taxId ? (rateByTax.get(l.taxId) ?? 0) : 0;
    const taxP = Math.round((netP * taxRate) / 100);

    subTotalP += grossP;
    discountP += lineDiscP;
    taxTotalP += taxP;

    return {
      ...l,
      discountPercent: discPct.toFixed(3),
      taxAmount: fromPaise(taxP),
      amount: fromPaise(netP),
      lineOrder: i,
    };
  });

  const cgstP = interState ? 0 : Math.round(taxTotalP / 2);
  const sgstP = interState ? 0 : taxTotalP - cgstP;
  const igstP = interState ? taxTotalP : 0;

  const adjustmentP = toPaise(adjustment?.amount ?? "0");
  const rawTotalP = subTotalP - discountP + taxTotalP + adjustmentP;
  // Rounding is an org preference — Zoho defaults to none, EGGSY to whole
  // rupees. Whatever it is, the difference is recorded as roundOff so the
  // document still ties to its own lines.
  const prefs = await getPreferences(tx);
  const roundedTotalP = applyRounding(rawTotalP, prefs.roundingMode, prefs.roundingIncrement);
  const roundOffP = roundedTotalP - rawTotalP;

  return {
    subTotal: fromPaise(subTotalP),
    discountTotal: fromPaise(discountP),
    cgst: fromPaise(cgstP),
    sgst: fromPaise(sgstP),
    igst: fromPaise(igstP),
    adjustment: fromPaise(adjustmentP),
    adjustmentAccountId: adjustmentP !== 0 ? (adjustment?.accountId ?? null) : null,
    adjustmentDescription: adjustmentP !== 0 ? (adjustment?.description ?? null) : null,
    roundOff: fromPaise(roundOffP),
    total: fromPaise(roundedTotalP),
    lines: computed,
  };
}

/**
 * Fill in each line's income account: an explicit override wins, otherwise the
 * item's default sales account. Lines that resolve to neither stay null and post
 * to the `sales` system account, which is Zoho's catch-all "Sales" behaviour.
 */
export async function applyDefaultSalesAccounts<T extends ComputedLine>(
  tx: Tx,
  lines: T[],
): Promise<T[]> {
  const itemIds = [
    ...new Set(lines.filter((l) => !l.accountId && l.itemId).map((l) => l.itemId!)),
  ];
  if (itemIds.length === 0) return lines;
  const rows = await tx
    .select({ id: items.id, salesAccountId: items.salesAccountId })
    .from(items)
    .where(inArray(items.id, itemIds));
  const defaults = new Map(rows.map((r) => [r.id, r.salesAccountId]));
  return lines.map((l) =>
    l.accountId || !l.itemId ? l : { ...l, accountId: defaults.get(l.itemId) ?? undefined },
  );
}

/**
 * Revenue totals per income account, in paise. Round-off rides on the largest
 * group so the journal still balances to the document total to the rupee.
 * A null accountId means "post to the `sales` system account".
 */
export function groupRevenueByAccount(
  lines: Array<{ accountId?: string | null; amount: string }>,
  roundOffPaise: number,
): Array<{ accountId: string | null; paise: number }> {
  const byAccount = new Map<string | null, number>();
  for (const l of lines) {
    const key = l.accountId ?? null;
    byAccount.set(key, (byAccount.get(key) ?? 0) + toPaise(l.amount));
  }
  const groups = [...byAccount.entries()].map(([accountId, paise]) => ({ accountId, paise }));
  if (groups.length === 0) return [{ accountId: null, paise: roundOffPaise }];
  if (roundOffPaise !== 0) {
    let largest = groups[0]!;
    for (const g of groups) if (Math.abs(g.paise) > Math.abs(largest.paise)) largest = g;
    largest.paise += roundOffPaise;
  }
  return groups.filter((g) => g.paise !== 0);
}

export { toPaise, fromPaise };
