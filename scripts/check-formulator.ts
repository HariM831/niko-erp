/**
 * The least-cost solver, and — the part this script exists for — what it says
 * when there IS no answer.
 *
 * "No feasible solution" is useless to a nutritionist. They cannot tell from it
 * whether to loosen an inclusion limit, buy a denser material, or go and fix an
 * analysis figure that reads zero. So an infeasible solve has to name the bound
 * that cannot be met and how close the pool gets to it.
 *
 * Pure arithmetic, no database: the solver takes its ingredients and its
 * standard as arguments. That is what makes it testable, and why the awkward
 * cases below can be written down exactly rather than hunted for in real data.
 *
 * Run: npx tsx scripts/check-formulator.ts
 */
import { type SolveIngredient, solveLeastCost } from "../server/services/formulator";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};

/** Three materials that behave like maize, soya and limestone. */
const MAIZE: SolveIngredient = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Maize",
  costPerKg: 21.5,
  nutrients: { me: 3300, cp: 8.5, ca: 0.02 },
};
const SOYA: SolveIngredient = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Soya",
  costPerKg: 54,
  nutrients: { me: 2350, cp: 50, ca: 0.3 },
};
const LIME: SolveIngredient = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Limestone",
  costPerKg: 2,
  nutrients: { me: 0, cp: 0, ca: 38 },
};
const POOL = [MAIZE, SOYA, LIME];
const MILL = { moistureRetention: 0.99, overheadPerKg: 0.75 };

console.log("\n  A SOLVE THAT WORKS\n");

const ok = solveLeastCost({
  ingredients: POOL,
  standard: [
    { nutrient: "cp", minValue: 18, maxValue: null },
    { nutrient: "ca", minValue: 1, maxValue: 4 },
  ],
  ...MILL,
});
check("it finds a mix", ok.feasible, ok.message ?? "");
const total = Object.values(ok.solution).reduce((s, v) => s + v, 0);
check("the mix is exactly 100 kg", Math.abs(total - 100) < 0.01, `${total.toFixed(3)} kg`);
check("protein clears its minimum", (ok.nutritionAnalysis.cp ?? 0) >= 17.99, `cp ${ok.nutritionAnalysis.cp}`);
check("calcium sits inside its band", (ok.nutritionAnalysis.ca ?? 0) >= 0.99 && (ok.nutritionAnalysis.ca ?? 0) <= 4.01, `ca ${ok.nutritionAnalysis.ca}`);
check(
  "the delivered cost carries milling, the raw one does not",
  ok.costPerKg > ok.rawCostPerKg,
  `raw ₹${ok.rawCostPerKg} → ₹${ok.costPerKg}/kg`,
);

console.log("\n  A BOUND NOTHING CAN REACH\n");

const rich = solveLeastCost({
  ingredients: [MAIZE, LIME],
  standard: [{ nutrient: "cp", minValue: 20, maxValue: null }],
  ...MILL,
});
check("it refuses", !rich.feasible);
const cp = rich.blockers?.find((b) => b.key === "cp");
check("it names protein as the blocker", !!cp, cp?.detail ?? rich.message ?? "");
check(
  "and says how close the pool gets",
  cp?.best != null && Math.abs(cp.best - 8.5) < 0.01,
  `best ${cp?.best} against ${cp?.asked}`,
);

console.log("\n  TWO BOUNDS THAT FIGHT EACH OTHER\n");

// Each is reachable alone — 50% protein exists, and so does 0.02% calcium —
// but not together, because the only protein source carries calcium with it.
const conflict = solveLeastCost({
  ingredients: [MAIZE, SOYA],
  standard: [
    { nutrient: "cp", minValue: 45, maxValue: null },
    { nutrient: "ca", minValue: null, maxValue: 0.05 },
  ],
  ...MILL,
});
check("it refuses", !conflict.feasible);
check(
  "no single bound is blamed",
  (conflict.blockers ?? []).length === 0,
  "each is reachable alone; the pair is not",
);
check(
  "and it says the bounds conflict rather than picking one",
  /taken together/.test(conflict.message ?? ""),
  conflict.message ?? "",
);

console.log("\n  IMPOSSIBLE INCLUSION LIMITS\n");

const overMin = solveLeastCost({
  ingredients: [
    { ...MAIZE, minPercent: 70 },
    { ...SOYA, minPercent: 40 },
  ],
  standard: [{ nutrient: "cp", minValue: 18, maxValue: null }],
  ...MILL,
});
check("minimums past 100% are caught", !overMin.feasible);
check(
  "and named as such, not as a nutrient problem",
  overMin.blockers?.some((b) => b.key === "minimums"),
  overMin.blockers?.find((b) => b.key === "minimums")?.detail ?? "",
);

const underMax = solveLeastCost({
  ingredients: [
    { ...MAIZE, maxPercent: 40 },
    { ...SOYA, maxPercent: 20 },
    { ...LIME, maxPercent: 5 },
  ],
  standard: [{ nutrient: "cp", minValue: 10, maxValue: null }],
  ...MILL,
});
check("caps that cannot fill the mix are caught", !underMax.feasible);
check(
  "and named",
  underMax.blockers?.some((b) => b.key === "maximums"),
  underMax.blockers?.find((b) => b.key === "maximums")?.detail ?? "",
);

console.log("\n  WHAT THE SOLVER REFUSES TO GUESS\n");

const unpriced = solveLeastCost({
  ingredients: POOL.map((i) => ({ ...i, costPerKg: null })),
  standard: [{ nutrient: "cp", minValue: 18, maxValue: null }],
  ...MILL,
});
check("nothing priced means nothing to optimise", !unpriced.feasible, unpriced.message ?? "");

const noBounds = solveLeastCost({
  ingredients: POOL,
  standard: [{ nutrient: "cp", minValue: null, maxValue: null }],
  ...MILL,
});
check("a standard with no bounds is refused", !noBounds.feasible, noBounds.message ?? "");

// The trap that makes a solve quietly wrong rather than loudly impossible: a
// material with no figure for a bound nutrient counts as zero. Limestone here
// has had its calcium deleted, and being the cheapest thing in the pool it is
// picked as filler — so the mix it produces is calcium-blind and says so.
// Only materials the solve actually CHOSE are reported: one it passed over
// cannot have distorted the answer.
const blind = solveLeastCost({
  ingredients: [MAIZE, SOYA, { ...LIME, nutrients: { me: 0, cp: 0 } }],
  standard: [
    { nutrient: "cp", minValue: 18, maxValue: null },
    { nutrient: "ca", minValue: null, maxValue: 2 },
  ],
  ...MILL,
});
check("the blind mix still solves", blind.feasible, blind.message ?? "");
check(
  "an unmeasured nutrient is reported, not silently zero",
  blind.unmeasured.some((u) => u.ingredientName === "Limestone" && u.nutrients.includes("ca")),
  blind.unmeasured.map((u) => `${u.ingredientName}: ${u.nutrients.join(",")}`).join(" · ") || "nothing reported",
);

console.log("\n  SHADOW PRICES\n");

const dear: SolveIngredient = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Fish meal",
  costPerKg: 120,
  nutrients: { me: 2800, cp: 60, ca: 5 },
};
const withDear = solveLeastCost({
  ingredients: [...POOL, dear],
  standard: [
    { nutrient: "cp", minValue: 18, maxValue: null },
    { nutrient: "ca", minValue: 1, maxValue: 4 },
  ],
  ...MILL,
});
const sp = withDear.shadowPrices.find((s) => s.ingredientName === "Fish meal");
check("a material left out gets a break-even price", !!sp, sp?.insight ?? "none returned");
check(
  "which is below what it costs today",
  sp?.breakEvenPrice != null && sp.breakEvenPrice < sp.currentPrice,
  sp ? `₹${sp.currentPrice} today, worth taking under ₹${sp.breakEvenPrice}` : "",
);

console.log(failed === 0 ? "\n  All formulator checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
