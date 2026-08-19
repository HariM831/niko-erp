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
  miscellaneous: "Miscellaneous",
};

/** The farm's own output, as against anything bought in. */
export const PRODUCE_CATEGORIES: ItemCategory[] = ["eggs", "birds", "manure"];

/** What the formulator may offer as a material. */
export const FORMULATION_CATEGORIES: ItemCategory[] = ["feed", "medicines"];

/** What the Farm Store may hold, when it is built. */
export const FARM_STORE_CATEGORIES: ItemCategory[] = ["vaccines", "medicines", "miscellaneous"];
