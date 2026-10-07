/**
 * The egg grades, once, for the server and every screen.
 *
 * The list follows the packing room's paper sheet, not a catalogue: the
 * weight grades first, then the two that are never weighed — brown is sorted
 * by colour, niko is a pack of its own. Each size has one column on every
 * per-size table, one stock item, and one heading on the sheet.
 */
export const EGG_SIZES = ["small", "medium", "large", "xl", "jumbo", "brown", "niko", "dirty"] as const;
export type EggSize = (typeof EGG_SIZES)[number];

export const EGG_SIZE_LABEL: Record<EggSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xl: "Extra Large",
  jumbo: "Jumbo",
  brown: "Brown",
  niko: "Niko",
  dirty: "Dirty",
};

/**
 * As the grading room writes them. Nine columns on a phone leaves about forty
 * pixels a heading; S, M, L, XL is how eggs are marked on the box, so the
 * short form is the one people already read.
 */
export const EGG_SIZE_SHORT: Record<EggSize, string> = {
  small: "S",
  medium: "M",
  large: "L",
  xl: "XL",
  jumbo: "J",
  brown: "Br",
  niko: "N",
  dirty: "D",
};

/**
 * Kept in the data, off the screens.
 *
 * XL is hidden, not removed ("hide xl", 13 Sep 2026): the sheet of 12 Sep
 * still shows 1,091 boxes of it in stock, so the column and its item stay,
 * and any figure in it is preserved and reported rather than keyed or lost.
 */
export const HIDDEN_EGG_SIZES: readonly EggSize[] = ["xl"];
export const VISIBLE_EGG_SIZES = EGG_SIZES.filter((s) => !HIDDEN_EGG_SIZES.includes(s));

/**
 * What one unit of a size is. Every grade is counted in boxes except Dirty,
 * which the packing room counts in trays of 30 (7 Oct 2026). Stock, loading
 * and the invoice all count the same unit; eggsInBox says how many eggs it is.
 */
export const EGG_UNIT: Record<EggSize, { one: string; many: string }> = {
  small: { one: "box", many: "boxes" },
  medium: { one: "box", many: "boxes" },
  large: { one: "box", many: "boxes" },
  xl: { one: "box", many: "boxes" },
  jumbo: { one: "box", many: "boxes" },
  brown: { one: "box", many: "boxes" },
  niko: { one: "box", many: "boxes" },
  dirty: { one: "tray", many: "trays" },
};

/**
 * The Daily Production & Stock Statement's own column order (7 Oct 2026):
 * Small, Medium, Large, NIKO, Brown, Jumbo, Dirty. The Egg stock page and its
 * PDF only — the Benchmark day sheets keep Jumbo last, as asked for there.
 */
export const STOCK_SHEET_SIZES: readonly EggSize[] = ["small", "medium", "large", "niko", "brown", "jumbo", "dirty"];

/**
 * Sold at a rate per box set on the Benchmark page, with nothing to do with
 * the benchmark, the size differentials or the customer's spread. Everything
 * else is priced per egg as benchmark + differential + spread.
 */
/**
 * Sold at a fixed rate per box, never off the benchmark: Niko ("a direct box
 * rate nothing to do with benchmark", 13 Sep 2026), and Brown at ₹8 an egg,
 * ₹1,680 a box of 210 (27 Sep 2026: "make brown a fixed rate grade").
 */
export const DIRECT_RATE_SIZES: readonly EggSize[] = ["niko", "brown"];
export const isDirectRate = (s: EggSize) => DIRECT_RATE_SIZES.includes(s);
