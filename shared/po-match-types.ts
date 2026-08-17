/**
 * The shape of a purchase-order match, shared by the matcher and the gate
 * screen.
 *
 * Lives in shared/ because the guard's screen renders the reasons verbatim: a
 * truck is only refused entry when nothing on order fits, and the person
 * turning it away has to be able to see which condition failed.
 */

export type MatchFactor = "vendor" | "material" | "rate" | "quantity" | "date";

export interface MatchReason {
  factor: MatchFactor;
  /** Every condition must pass. There is no partial credit. */
  passed: boolean;
  /** Written for a person, not a log. */
  detail: string;
}

export interface PoCandidate {
  purchaseOrderId: string;
  poLineId: string;
  poNumber: string;
  itemId: string | null;
  itemName: string;
  unitRate: number;
  orderedQuantity: number;
  remainingQuantity: number;
  expectedDeliveryDate: string | null;
  /** True only when every reason passed. */
  matched: boolean;
  reasons: MatchReason[];
}

export type MatchMethod = "matched" | "choose" | "unmatched";

export interface LineMatch {
  lineNo: number;
  method: MatchMethod;
  /** Set when exactly one order line satisfied every condition. */
  chosen: PoCandidate | null;
  /** Everything considered, so a refusal can name the nearest miss. */
  candidates: PoCandidate[];
  message: string;
}
