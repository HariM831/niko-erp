import { preferences } from "@shared/schema";
import type { Db, Tx } from "../db";

export type Preferences = typeof preferences.$inferSelect;

/** The shape a fresh install behaves as, before anyone opens Settings. */
export const DEFAULT_PREFERENCES: Omit<Preferences, "id" | "updatedAt"> = {
  discountLevel: "line",
  discountBeforeTax: true,
  enableAdjustment: true,
  enableShippingCharge: true,
  taxTreatment: "exclusive",
  roundingMode: "whole",
  roundingIncrement: "1.00",
  quantityDecimals: 2,
  allowDuplicateItemNames: false,
  preventNegativeStock: true,
  showOutOfStockWarning: true,
  notifyOnReorderLevel: false,
  allowDuplicateContactNames: false,
  defaultCustomerType: "business",
  enableCreditLimit: true,
  allowEditingSentInvoice: false,
  hideZeroValueLines: false,
  defaultInvoiceTerms: null,
  defaultInvoiceNotes: null,
  requireAccountCode: true,
  poOverDeliveryPct: "1.000",
  millMoistureRetention: "0.99",
  millOverheadPerKg: "0.75",
};

/**
 * Read the org's preferences, falling back to the defaults when the row has
 * never been written. Callers get a complete object either way, so no caller
 * has to decide what an absent preference means.
 */
export async function getPreferences(tx: Db | Tx): Promise<Preferences> {
  const [row] = await tx.select().from(preferences).limit(1);
  return row ?? { id: "default", ...DEFAULT_PREFERENCES, updatedAt: new Date() };
}

/** Round a paise total according to the org's rounding preference. */
export function applyRounding(
  rawPaise: number,
  mode: string,
  incrementRupees: string,
): number {
  if (mode === "none") return rawPaise;
  if (mode === "increment") {
    const stepP = Math.round(Number(incrementRupees) * 100);
    if (stepP <= 0) return rawPaise;
    return Math.round(rawPaise / stepP) * stepP;
  }
  return Math.round(rawPaise / 100) * 100;
}
