/**
 * The least-cost formulator.
 *
 * Finds the cheapest 100 kg mix that lands inside a life stage's feed standard,
 * subject to per-ingredient inclusion limits. Ported from Amino's
 * /api/formulator/solve with its arithmetic intact and two things changed:
 *
 * Nutrients come from `item_nutrients` rows, not from a key-to-column map that
 * existed twice and had to agree with itself. A material missing a figure the
 * standard constrains contributes zero of it — same behaviour as Amino, where
 * an empty column read 0 — but HERE the response lists those gaps, because a
 * solve that treated "unmeasured" as "none" silently is how a mix ends up
 * protein-short in a shed.
 *
 * The cost adjustments are ARGUMENTS, not constants. Amino hardcoded 1% baking
 * loss and ₹0.75/kg overhead in two files with comments begging them to match;
 * they live in feed mill settings now and are passed in. Neither changes the
 * optimal mix — a flat multiplier and a flat add-on move every candidate
 * equally — only the reported cost, which is why they are applied after the
 * solve rather than inside it.
 *
 * Shadow prices are the part worth having: for each priced ingredient the mix
 * left out, re-solve with a forced 1% inclusion and read the cost difference.
 * That is the break-even — the price at which the ingredient would start
 * earning its place — and it is what tells a buyer whether a quote is worth
 * taking before any money moves.
 */
import lpSolver from "javascript-lp-solver";

export interface SolveIngredient {
  id: string;
  name: string;
  /** ₹/kg as bought. Ingredients without a price cannot be costed, so they sit out. */
  costPerKg: number | null;
  /** nutrient key → value, from item_nutrients. Missing keys mean unmeasured. */
  nutrients: Record<string, number>;
  /** Inclusion limits, % of the mix. From the formula line or typed in the screen. */
  minPercent?: number | null;
  maxPercent?: number | null;
}

export interface SolveStandard {
  nutrient: string;
  minValue: number | null;
  maxValue: number | null;
}

export interface SolveOptions {
  ingredients: SolveIngredient[];
  standard: SolveStandard[];
  /** Output weighs this share of raw input after milling — Amino's 0.99. */
  moistureRetention: number;
  /** Flat ₹/kg milling overhead — Amino's 0.75. */
  overheadPerKg: number;
}

export interface ShadowPrice {
  ingredientId: string;
  ingredientName: string;
  currentPrice: number;
  /** ₹/kg at which one percent of this would not raise the mix cost. */
  breakEvenPrice: number | null;
  /** Already cheaper than break-even: the solve simply had better options. */
  wouldEnter: boolean;
  insight: string;
}

export interface Blocker {
  kind: "nutrient" | "inclusion";
  /** Nutrient key, or ingredient id for an inclusion limit. */
  key: string;
  label: string;
  /** What the standard or the limit asked for. */
  asked: string;
  /** The best these ingredients can do for it, ignoring every other bound. */
  best: number | null;
  detail: string;
}

export interface SolveResult {
  feasible: boolean;
  message?: string;
  /** When infeasible: the bounds that cannot be met. Empty if none stands out. */
  blockers?: Blocker[];
  /** ingredientId → % of the mix (i.e. kg per 100 kg). */
  solution: Record<string, number>;
  /** Raw-material cost of 100 kg of mix, before milling. */
  rawCostPer100kg: number;
  rawCostPerKg: number;
  /** Delivered: raw ÷ retention + overhead. What a kg of finished feed costs. */
  costPerKg: number;
  totalCostPer100kg: number;
  /** nutrient key → what the mix actually delivers. */
  nutritionAnalysis: Record<string, number>;
  /** Materials whose missing figures were treated as zero for a bound nutrient. */
  unmeasured: Array<{ ingredientName: string; nutrients: string[] }>;
  shadowPrices: ShadowPrice[];
}

type LpModel = {
  optimize: string;
  opType: "min" | "max";
  constraints: Record<string, { equal?: number; min?: number; max?: number }>;
  variables: Record<string, Record<string, number>>;
};

const round = (v: number, dp = 2) => Number(v.toFixed(dp));

/** The model both the solve and every shadow-price re-solve share. */
function buildModel(ingredients: SolveIngredient[], standard: SolveStandard[]): LpModel {
  const model: LpModel = {
    optimize: "cost",
    opType: "min",
    constraints: { total: { equal: 100 } },
    variables: {},
  };

  for (const std of standard) {
    const key = `n_${std.nutrient}`;
    if (std.minValue != null) model.constraints[key] = { ...model.constraints[key], min: std.minValue };
    if (std.maxValue != null) model.constraints[key] = { ...model.constraints[key], max: std.maxValue };
  }

  for (const ing of ingredients) {
    const v: Record<string, number> = { cost: ing.costPerKg ?? 0, total: 1 };
    // Per-ingredient inclusion limits: a variable that only this ingredient
    // carries, bounded in the constraints. lpSolver's canonical dosage idiom.
    if (ing.minPercent != null && ing.minPercent > 0) {
      model.constraints[`dmin_${ing.id}`] = { min: ing.minPercent };
      v[`dmin_${ing.id}`] = 1;
    }
    if (ing.maxPercent != null) {
      model.constraints[`dmax_${ing.id}`] = { max: ing.maxPercent };
      v[`dmax_${ing.id}`] = 1;
    }
    for (const std of standard) {
      const key = `n_${std.nutrient}`;
      if (model.constraints[key]) {
        // A percentage point of ingredient carries value/100 of the nutrient.
        // Works identically for ME in kcal/kg: 60% of 3,300 → 1,980 kcal/kg.
        v[key] = (ing.nutrients[std.nutrient] ?? 0) / 100;
      }
    }
    model.variables[`i_${ing.id}`] = v;
  }
  return model;
}

/**
 * Which bound is the impossible one.
 *
 * "No feasible solution" is useless to a nutritionist: they cannot tell whether
 * to loosen a limit, buy a denser material, or go and fix an analysis figure.
 *
 * So each bound is tested on its own — drop every OTHER nutrient bound and see
 * whether this one alone can be met. A bound that fails in isolation is
 * genuinely unreachable with these materials, and it is named with the best the
 * pool can actually do. If every bound passes alone, the conflict is between
 * them, and saying so is more honest than picking one at random.
 *
 * Inclusion limits are checked by arithmetic rather than by solving: mins that
 * sum past 100, or maxes that cannot reach it, are the two ways a pool is
 * impossible before nutrition is even considered.
 */
function diagnose(priced: SolveIngredient[], standard: SolveStandard[]): Blocker[] {
  const out: Blocker[] = [];

  const minSum = priced.reduce((s, i) => s + (i.minPercent ?? 0), 0);
  if (minSum > 100.0001) {
    out.push({
      kind: "inclusion",
      key: "minimums",
      label: "Inclusion minimums",
      asked: "must total 100%",
      best: round(minSum, 3),
      detail: `The minimums alone add to ${round(minSum, 2)}% of the mix — more than the whole of it.`,
    });
  }
  // An ingredient with no max can carry the rest, so only an all-capped pool
  // can fall short of 100.
  const allCapped = priced.every((i) => i.maxPercent != null);
  const maxSum = priced.reduce((s, i) => s + (i.maxPercent ?? 0), 0);
  if (allCapped && maxSum < 99.9999) {
    out.push({
      kind: "inclusion",
      key: "maximums",
      label: "Inclusion maximums",
      asked: "must reach 100%",
      best: round(maxSum, 3),
      detail: `Every material is capped and the caps only add to ${round(maxSum, 2)}% — the mix cannot be filled.`,
    });
  }

  for (const std of standard) {
    if (std.minValue == null && std.maxValue == null) continue;
    // This bound alone, against the same inclusion limits.
    const solo = buildModel(priced, [std]);
    const r = lpSolver.Solve(solo) as Record<string, number> & { feasible: boolean };
    if (r.feasible) continue;

    // Unreachable on its own. Say how close the pool can get, by optimising
    // the nutrient itself with no bound on it at all.
    const probe = buildModel(priced, []);
    probe.optimize = `n_${std.nutrient}`;
    probe.opType = std.minValue != null ? "max" : "min";
    for (const ing of priced) {
      probe.variables[`i_${ing.id}`]![`n_${std.nutrient}`] =
        (ing.nutrients[std.nutrient] ?? 0) / 100;
    }
    const p = lpSolver.Solve(probe) as Record<string, number> & { feasible: boolean; result: number };
    const best = p.feasible ? round(p.result, 3) : null;
    const asked =
      std.minValue != null && std.maxValue != null
        ? `${std.minValue}–${std.maxValue}`
        : std.minValue != null
          ? `at least ${std.minValue}`
          : `at most ${std.maxValue}`;
    out.push({
      kind: "nutrient",
      key: std.nutrient,
      label: std.nutrient,
      asked,
      best,
      detail:
        best == null
          ? `Nothing in the pool can satisfy this bound.`
          : std.minValue != null
            ? `The richest mix these materials allow reaches ${best}, short of ${std.minValue}.`
            : `The leanest mix these materials allow is ${best}, over ${std.maxValue}.`,
    });
  }
  return out;
}

export function solveLeastCost(opts: SolveOptions): SolveResult {
  const priced = opts.ingredients.filter((i) => i.costPerKg != null && i.costPerKg > 0);
  const empty: SolveResult = {
    feasible: false,
    solution: {},
    rawCostPer100kg: 0,
    rawCostPerKg: 0,
    costPerKg: 0,
    totalCostPer100kg: 0,
    nutritionAnalysis: {},
    unmeasured: [],
    shadowPrices: [],
  };
  if (!priced.length) {
    return { ...empty, message: "No ingredient has a purchase price — the solver has nothing to cost." };
  }
  const bound = new Set(
    opts.standard.filter((s) => s.minValue != null || s.maxValue != null).map((s) => s.nutrient),
  );
  if (!bound.size) {
    return { ...empty, message: "The standard has no bounds — any mix would do, so there is nothing to optimise." };
  }

  const model = buildModel(priced, opts.standard);
  const out = lpSolver.Solve(model) as Record<string, number> & { feasible: boolean; result: number };

  if (!out.feasible) {
    const blockers = diagnose(priced, opts.standard);
    return {
      ...empty,
      blockers,
      message: blockers.length
        ? "No mix of these ingredients can meet every bound."
        : "No mix of these ingredients can land inside the standard, and no single bound is the cause — the inclusion limits are contradictory taken together.",
    };
  }

  const solution: Record<string, number> = {};
  for (const ing of priced) {
    const pct = out[`i_${ing.id}`] ?? 0;
    if (pct > 0.005) solution[ing.id] = round(pct, 3);
  }

  const rawCostPer100kg = round(out.result);
  const rawCostPerKg = round(rawCostPer100kg / 100, 4);
  const costPerKg = round(rawCostPerKg / opts.moistureRetention + opts.overheadPerKg, 4);

  const nutritionAnalysis: Record<string, number> = {};
  for (const std of opts.standard) {
    if (!bound.has(std.nutrient)) continue;
    let total = 0;
    for (const ing of priced) total += ((solution[ing.id] ?? 0) * (ing.nutrients[std.nutrient] ?? 0)) / 100;
    nutritionAnalysis[std.nutrient] = round(total, 3);
  }

  // Say which figures were guesses of zero, instead of silently believing them.
  const unmeasured = priced
    .filter((i) => (solution[i.id] ?? 0) > 0)
    .map((i) => ({
      ingredientName: i.name,
      nutrients: [...bound].filter((n) => i.nutrients[n] == null),
    }))
    .filter((u) => u.nutrients.length > 0);

  // ── Shadow prices ──
  // For each priced ingredient the mix left out: force 1% in, re-solve, and
  // read what that percent costs. break-even = current price − (cost increase
  // per kg of the forced percent). At that price the forced inclusion would
  // have been free, so the solver would take it on its own.
  const shadowPrices: ShadowPrice[] = [];
  for (const ing of priced) {
    if ((solution[ing.id] ?? 0) > 0) continue;
    const forced = buildModel(priced, opts.standard);
    forced.constraints[`force_${ing.id}`] = { min: 1 };
    forced.variables[`i_${ing.id}`]![`force_${ing.id}`] = 1;
    const test = lpSolver.Solve(forced) as { feasible: boolean; result: number };

    if (!test.feasible) {
      shadowPrices.push({
        ingredientId: ing.id,
        ingredientName: ing.name,
        currentPrice: ing.costPerKg!,
        breakEvenPrice: null,
        wouldEnter: false,
        insight: "Cannot enter at all — forcing even 1% breaks the standard.",
      });
      continue;
    }
    // The re-solve buys 1 kg of this ingredient per 100 kg and rebalances the
    // rest; the delta is what that swap costs at today's prices.
    const deltaPer100 = test.result - out.result;
    const breakEven = round(ing.costPerKg! - deltaPer100, 2);
    /**
     * A break-even at or below zero is not a price.
     *
     * It means forcing this material in costs more than it is worth even free:
     * it displaces something the mix needs and the rest has to be rebalanced
     * around it. Printing "buy under ₹-2.72" invites somebody to go looking for
     * a quote that cannot exist, so it is reported as what it is.
     */
    const worthless = breakEven <= 0;
    shadowPrices.push({
      ingredientId: ing.id,
      ingredientName: ing.name,
      currentPrice: ing.costPerKg!,
      breakEvenPrice: worthless ? null : breakEven,
      wouldEnter: !worthless && breakEven >= ing.costPerKg!,
      insight: worthless
        ? `No price would bring it in — it displaces something the mix needs.`
        : breakEven >= ing.costPerKg!
          ? `Degenerate tie at today's prices — the solver had an equally cheap mix without it.`
          : `Enters the mix below ₹${breakEven}/kg — today it is ₹${round(ing.costPerKg! - breakEven, 2)} too dear.`,
    });
  }
  shadowPrices.sort((a, b) => (b.breakEvenPrice ?? -1) - (a.breakEvenPrice ?? -1));

  return {
    feasible: true,
    solution,
    rawCostPer100kg,
    rawCostPerKg,
    costPerKg,
    totalCostPer100kg: round(costPerKg * 100),
    nutritionAnalysis,
    unmeasured,
    shadowPrices,
  };
}
