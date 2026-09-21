/**
 * The item categories — a fixed vocabulary, not a custom field.
 *
 * They drive behaviour: the formulator's material picker offers only Feed and
 * Medicines, and the Farm Store (when it lands) accepts only Vaccines,
 * Medicines and Miscellaneous. A user-editable option list would let a rename
 * silently break those filters, so the options are code and the assignment is
 * data.
 *
 * "Produce" used to cover everything the farm made, which turned out to mean
 * eggs, birds and manure in one bucket while the feed the mill produced sat
 * under Feed beside the maize it was made from. Nothing could be reported on.
 * So Feed is now raw material only, what the mill makes is Poultry Feed, and
 * the farm's own output splits into the three things it actually is.
 */
export const ITEM_CATEGORIES = [
  "feed",
  "poultry_feed",
  "eggs",
  "birds",
  "manure",
  "vaccines",
  "medicines",
  "construction",
  "packaging",
  "miscellaneous",
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  /** Raw material bought in — maize, soya, the minerals. */
  feed: "Raw Material",
  /** What the mill produces. Held in stock, transferred to a shed, consumed. */
  poultry_feed: "Poultry Feed",
  eggs: "Eggs",
  birds: "Birds",
  manure: "Manure",
  vaccines: "Vaccines",
  medicines: "Medicines",
  construction: "Construction",
  /** Egg boxes, trays, tape, strap, jute — what the eggs leave in. */
  packaging: "Packaging",
  miscellaneous: "Miscellaneous",
};

/** The farm's own output, as against anything bought in. */
export const PRODUCE_CATEGORIES: ItemCategory[] = ["eggs", "birds", "manure"];

/**
 * What niko sells, and so what an invoice or credit note may offer: the farm's
 * output and the mill's feed. Feed is sold — to the group's own LLPs, through
 * owner billing — so it is here beside eggs, birds and manure (litter is
 * invoiced as manure). An item outside these has its sale terms stripped.
 * Decided with the user on 21 Sep 2026.
 */
export const SALE_CATEGORIES: ItemCategory[] = ["eggs", "poultry_feed", "birds", "manure"];

/**
 * What a bill, purchase order or vendor credit may offer: everything but
 * manure, which the farm only ever produces. Eggs, birds and poultry feed stay
 * — eggs are bought in to trade, day-old chicks are bought, and chick feed
 * comes ready-made in bags. An item with no category yet is offered too: it
 * was almost certainly bought, and hiding it would stop the bill.
 */
export const PURCHASE_CATEGORIES: ItemCategory[] = ITEM_CATEGORIES.filter((c) => c !== "manure");

/** What the formulator may offer as a material. */
export const FORMULATION_CATEGORIES: ItemCategory[] = ["feed", "medicines"];

/** What the Farm Store may hold, when it is built. */
export const FARM_STORE_CATEGORIES: ItemCategory[] = ["vaccines", "medicines", "miscellaneous"];
