/**
 * The vocabulary the feed mill is written in.
 *
 * Kept out of the schema file so a screen can import a label without pulling in
 * drizzle, and kept in ONE place because Amino carried this list twice — once in
 * `client/src/lib/feed-nutrients.ts` and again inside the solver endpoint — as a
 * map from nutrient key to a column name on `materials`. Nutrients are rows here,
 * so there is no column map to keep in step: adding a nutrient is data.
 */

/** A bird's life stages, in the order it passes through them. */
export const LIFE_STAGES = [
  "chick_starter",
  "developer",
  "grower",
  "prelayer",
  "layer_1",
  "layer_2",
  "layer_3",
] as const;

export type LifeStage = (typeof LIFE_STAGES)[number];

export const LIFE_STAGE_LABELS: Record<LifeStage, string> = {
  chick_starter: "Chick Starter",
  developer: "Developer",
  grower: "Grower",
  prelayer: "Prelayer",
  layer_1: "Layer 1",
  layer_2: "Layer 2",
  layer_3: "Layer 3",
};

export interface NutrientDef {
  key: string;
  /** What a nutritionist calls it. */
  label: string;
  /** "%" for everything an analysis reports as a proportion; ME is energy. */
  unit: string;
  /**
   * Grouped for the screens only. Energy and the proximates are entered for
   * every material; the digestible amino acids are a long tail that most
   * materials leave blank.
   */
  group: "energy" | "proximate" | "mineral" | "amino";
}

/**
 * The nutrients a mix is judged on.
 *
 * ME is kcal/kg and the rest are percentages, and the solver treats them
 * identically — a coefficient of value ÷ 100 per unit of ingredient, against a
 * 100 kg basis. That works for both: 60 kg of a 3,300 kcal/kg maize contributes
 * 60 × 3300 ÷ 100 = 1,980 kcal/kg to the mix, and 60 kg of an 8% protein maize
 * contributes 60 × 8 ÷ 100 = 4.8%. Same arithmetic, different unit, which is why
 * neither needs a special case.
 */
export const NUTRIENTS: NutrientDef[] = [
  { key: "me", label: "ME", unit: "kcal/kg", group: "energy" },
  { key: "cp", label: "Crude protein", unit: "%", group: "proximate" },
  { key: "cf", label: "Crude fibre", unit: "%", group: "proximate" },
  { key: "fat", label: "Fat", unit: "%", group: "proximate" },
  { key: "ca", label: "Calcium", unit: "%", group: "mineral" },
  { key: "totalP", label: "Total phosphorus", unit: "%", group: "mineral" },
  { key: "avP", label: "Available phosphorus", unit: "%", group: "mineral" },
  { key: "digLys", label: "Dig. lysine", unit: "%", group: "amino" },
  { key: "digMet", label: "Dig. methionine", unit: "%", group: "amino" },
  { key: "digCyst", label: "Dig. cystine", unit: "%", group: "amino" },
  { key: "digArg", label: "Dig. arginine", unit: "%", group: "amino" },
  { key: "digHis", label: "Dig. histidine", unit: "%", group: "amino" },
  { key: "digLeu", label: "Dig. leucine", unit: "%", group: "amino" },
  { key: "digIle", label: "Dig. isoleucine", unit: "%", group: "amino" },
  { key: "digPhe", label: "Dig. phenylalanine", unit: "%", group: "amino" },
  { key: "digThr", label: "Dig. threonine", unit: "%", group: "amino" },
  { key: "digTrp", label: "Dig. tryptophan", unit: "%", group: "amino" },
  { key: "digTyr", label: "Dig. tyrosine", unit: "%", group: "amino" },
  { key: "digVal", label: "Dig. valine", unit: "%", group: "amino" },
  { key: "digSer", label: "Dig. serine", unit: "%", group: "amino" },
];

export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key);
const BY_KEY = new Map(NUTRIENTS.map((n) => [n.key, n]));

export const nutrientDef = (key: string): NutrientDef | undefined => BY_KEY.get(key);

/** "Crude protein (%)" — for a column head or a form label. */
export function nutrientLabel(key: string): string {
  const def = BY_KEY.get(key);
  return def ? `${def.label} (${def.unit})` : key;
}

export const NUTRIENT_GROUPS: Array<{ group: NutrientDef["group"]; label: string }> = [
  { group: "energy", label: "Energy" },
  { group: "proximate", label: "Proximates" },
  { group: "mineral", label: "Minerals" },
  { group: "amino", label: "Digestible amino acids" },
];

/**
 * Where a figure came from.
 *
 * A least-cost mix is only as good as the analysis behind it, and a book value
 * standing in for a lab result is the kind of thing worth being able to see.
 */
export const NUTRIENT_SOURCES = ["lab", "supplier", "book"] as const;
export type NutrientSource = (typeof NUTRIENT_SOURCES)[number];

export const NUTRIENT_SOURCE_LABELS: Record<NutrientSource, string> = {
  lab: "Lab tested",
  supplier: "Supplier datasheet",
  book: "Book value",
};
