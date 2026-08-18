/**
 * The item categories — a fixed vocabulary, not a custom field.
 *
 * These five drive behaviour: the formulator's material picker offers only
 * Feed and Medicines, and the Farm Store (when it lands) accepts only
 * Vaccines, Medicines and Miscellaneous. A user-editable option list would
 * let a rename silently break those filters, so the options are code and the
 * assignment is data.
 */
export const ITEM_CATEGORIES = [
  "feed",
  "vaccines",
  "medicines",
  "construction",
  "miscellaneous",
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  feed: "Feed",
  vaccines: "Vaccines",
  medicines: "Medicines",
  construction: "Construction",
  miscellaneous: "Miscellaneous",
};

/** What the formulator may offer as a material. */
export const FORMULATION_CATEGORIES: ItemCategory[] = ["feed", "medicines"];

/** What the Farm Store may hold, when it is built. */
export const FARM_STORE_CATEGORIES: ItemCategory[] = ["vaccines", "medicines", "miscellaneous"];
