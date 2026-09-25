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

/**
 * Digestible methionine + cystine, which is how the guide states the sulphur
 * amino acids. Not a stored figure: materials carry methionine and cystine
 * apart, and the standard holds cystine as (Met+Cys) − Met, so the sum of the
 * two is both what a material carries and what the guide asked for.
 */
export const DIG_MET_CYS = "digMetCys";
const DERIVED: NutrientDef[] = [{ key: DIG_MET_CYS, label: "Dig. Met+Cys", unit: "%", group: "amino" }];
const DERIVED_BY_KEY = new Map(DERIVED.map((n) => [n.key, n]));

/**
 * What the least-cost solve is held to — energy, calcium, available
 * phosphorus, digestible lysine, digestible Met+Cys and crude fibre, the
 * figures the mill formulates on. Everything else in a standard is still
 * worked out and marked met or missed, but never binds: a mix is not made
 * dearer, or declared impossible, for a secondary amino acid or for protein.
 */
export const SOLVE_ON: readonly string[] = ["me", "ca", "avP", "digLys", DIG_MET_CYS, "cf"];
export const isSolvedOn = (key: string) => SOLVE_ON.includes(key);

/**
 * Fibre is a ceiling on bulk, not a daily need, so it is not scaled with feed
 * intake as the rest of a layer standard is.
 */
export const scalesWithIntake = (key: string) => key !== "cf";

type Bound = { nutrient: string; minValue: number | null; maxValue: number | null };

/**
 * A standard's rows as the formulator reads them: Met+Cys added after lysine
 * as the sum of the two, and a crude fibre row (possibly with no limit) so the
 * mix's fibre is always on show. The stored standard is left as it is.
 */
export function formulatorBounds<T extends Bound>(bounds: T[]): Bound[] {
  const out: Bound[] = bounds.map((b) => ({ nutrient: b.nutrient, minValue: b.minValue, maxValue: b.maxValue }));
  const met = out.find((b) => b.nutrient === "digMet");
  const cys = out.find((b) => b.nutrient === "digCyst");
  if (met && cys && !out.some((b) => b.nutrient === DIG_MET_CYS)) {
    const sum = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round((a + b) * 10000) / 10000);
    const row = { nutrient: DIG_MET_CYS, minValue: sum(met.minValue, cys.minValue), maxValue: sum(met.maxValue, cys.maxValue) };
    const at = out.findIndex((b) => b.nutrient === "digLys");
    out.splice(at >= 0 ? at + 1 : out.length, 0, row);
  }
  if (!out.some((b) => b.nutrient === "cf")) {
    const at = out.findIndex((b) => b.nutrient === "avP");
    out.splice(at >= 0 ? at + 1 : out.length, 0, { nutrient: "cf", minValue: null, maxValue: null });
  }
  return out;
}

/** A material's profile with the derived figures added. Unmeasured stays absent. */
export function withDerivedNutrients(n: Record<string, number>): Record<string, number> {
  if (n.digMet == null && n.digCyst == null) return n;
  return { ...n, [DIG_MET_CYS]: (n.digMet ?? 0) + (n.digCyst ?? 0) };
}

/** "Crude protein (%)" — for a column head or a form label. */
export function nutrientLabel(key: string): string {
  const def = BY_KEY.get(key) ?? DERIVED_BY_KEY.get(key);
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

/**
 * What a lab actually measures on an incoming raw material.
 *
 * A closed list, not free text. A spec whose parameter is typed by hand cannot
 * be compared across materials, cannot be printed on a purchase order in words
 * a vendor recognises, and — the expensive one — cannot be matched to a lab
 * reading, because "Moist." and "Moisture" are different columns to a machine.
 *
 * These are quality parameters, deliberately NOT the same vocabulary as
 * NUTRIENTS above. They overlap (protein, fat, fibre are both) but each list
 * has entries the other has no use for: a formulator needs digestible lysine
 * and never asks about sand, while a receiving bench asks about sand on every
 * truck and has no reading for lysine.
 *
 * `direction` is only the sensible default when the parameter is added — the
 * spec author can flip it, because the same figure cuts both ways depending on
 * the material.
 */
export interface QcParameterDef {
  key: string;
  label: string;
  unit: string;
  /** "max" fails above the limit, "min" fails below it. */
  direction: "max" | "min";
  hint: string;
}

export const QC_PARAMETERS: QcParameterDef[] = [
  { key: "moisture", label: "Moisture", unit: "%", direction: "max", hint: "Water bought at the price of material, and what spoils a stack in storage" },
  { key: "protein", label: "Protein", unit: "%", direction: "min", hint: "What the material is bought for — short protein is short value" },
  { key: "fat", label: "Fat", unit: "%", direction: "min", hint: "Energy. On a de-oiled cake a high reading means it was not fully extracted" },
  { key: "fiber", label: "Fiber", unit: "%", direction: "max", hint: "Bulk the bird cannot use; high fibre dilutes the ration" },
  { key: "sand_silica", label: "Sand Silica", unit: "%", direction: "max", hint: "Adulteration — weight that is neither feed nor accident" },
];

export const QC_PARAMETER_KEYS = QC_PARAMETERS.map((p) => p.key);
const QC_BY_KEY = new Map(QC_PARAMETERS.map((p) => [p.key, p]));
export const qcParameterDef = (key: string): QcParameterDef | undefined => QC_BY_KEY.get(key);
