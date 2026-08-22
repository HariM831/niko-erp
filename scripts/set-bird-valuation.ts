/**
 * Build the bird valuation curve — what a pullet is worth at each age week.
 *
 * This is a transfer price between two companies, so it is DERIVED rather than
 * guessed: a pullet is worth what it cost to rear, which is the chick, the feed
 * it has eaten to that age, and the overhead of keeping it — all grossed up so
 * the survivors carry the cost of the birds that did not make it.
 *
 *     value(week) = (chick + feed to date + overhead x weeks) / liveability
 *
 * The feed side comes from the breed's own standard intake and the mill's real
 * cost per kg, so the curve moves when the feed cost moves. Only two numbers
 * cannot be derived and have to be told: what a day-old chick costs and what
 * rearing overhead runs to per bird per week.
 *
 * Stops at point of lay. Beyond it a bird is not worth what it cost — it is
 * worth the lay it has left, which is a different calculation and not this one.
 *
 *   npx tsx scripts/set-bird-valuation.ts --chick 52 --overhead 1.50
 *   npx tsx scripts/set-bird-valuation.ts --chick 52 --overhead 1.50 --apply
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  birdValuationRates,
  breeds,
  feedTransfers,
  standardPoints,
  standardSets,
} from "@shared/schema";
import { db } from "../server/db";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes("--apply");

/** What a day-old chick costs, landed. */
const chickCost = Number(arg("chick") ?? 52);
/** Labour, vaccines, medication, power, litter — per bird per week of rearing. */
const overheadPerWeek = Number(arg("overhead") ?? 1.5);
/** The last week a bird is valued on what it cost. */
const lastWeek = Number(arg("to") ?? 18);
const effectiveFrom = arg("from") ?? new Date().toISOString().slice(0, 10);

if ([chickCost, overheadPerWeek, lastWeek].some((v) => !Number.isFinite(v) || v < 0)) {
  console.log("\n  --chick, --overhead and --to must be positive numbers\n");
  process.exit(1);
}

const userId = ((await db.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;

/**
 * The mill's cost per kg, from what it has actually been sending out.
 *
 * The one feed cost, same as everywhere else — not a separate number kept for
 * valuing birds, which would drift away from it the first time either moved.
 */
const [feedRateRow] = await db
  .select({ rate: sql<string>`sum(${feedTransfers.value}) / nullif(sum(${feedTransfers.quantityKg}), 0)` })
  .from(feedTransfers)
  .where(and(isNotNull(feedTransfers.value), sql`${feedTransfers.status} <> 'void'`));
const feedRate = Number(feedRateRow?.rate ?? 0);

if (!feedRate) {
  console.log("\n  no priced feed transfers to read a cost per kg from — mill something first\n");
  process.exit(1);
}

console.log(`\n  chick ${chickCost.toFixed(2)}   overhead ${overheadPerWeek.toFixed(2)}/bird/week   feed ${feedRate.toFixed(4)}/kg`);
console.log(`  effective from ${effectiveFrom}\n`);

let wrote = 0;
for (const breed of await db.select().from(breeds)) {
  const [set] = await db
    .select()
    .from(standardSets)
    .where(and(eq(standardSets.breedId, breed.id), eq(standardSets.isDefault, true)));
  if (!set) {
    console.log(`  ${breed.name}: no default standard set — skipped`);
    continue;
  }

  const points = await db
    .select()
    .from(standardPoints)
    .where(eq(standardPoints.setId, set.id))
    .orderBy(asc(standardPoints.ageWeek));

  let cumFeedKg = 0;
  const curve: Array<{ week: number; feedKg: number; cost: number; live: number; value: number }> = [];
  for (const p of points) {
    if (p.ageWeek > lastWeek) break;
    // A week of intake at the standard rate. A week with no published intake
    // carries the previous week's, which is nearer the truth than zero.
    const gPerDay = Number(p.feedGPerBirdDay ?? 0);
    const weekKg = (gPerDay * 7) / 1000;
    cumFeedKg += weekKg;

    const live = 1 - Number(p.cumMortalityPct ?? 0) / 100;
    const cost = chickCost + cumFeedKg * feedRate + overheadPerWeek * p.ageWeek;
    // Grossed up: the flock's survivors carry what the dead ones cost.
    const value = live > 0 ? cost / live : cost;
    curve.push({ week: p.ageWeek, feedKg: cumFeedKg, cost, live, value });
  }

  if (!curve.length) {
    console.log(`  ${breed.name}: the standard has no rearing weeks — skipped`);
    continue;
  }

  console.log(`  ${breed.name} — ${set.name}`);
  console.log(`    week   cum feed kg    cost      liveability   value/bird`);
  for (const c of curve) {
    if (c.week % 2 === 0 || c.week === 1 || c.week === lastWeek) {
      console.log(
        `    ${String(c.week).padStart(4)}   ${c.feedKg.toFixed(3).padStart(11)}   ` +
          `${c.cost.toFixed(2).padStart(7)}   ${(c.live * 100).toFixed(2).padStart(10)}%   ` +
          `${c.value.toFixed(2).padStart(10)}`,
      );
    }
  }

  if (APPLY) {
    for (const c of curve) {
      await db
        .insert(birdValuationRates)
        .values({
          breedId: breed.id,
          ageWeek: c.week,
          rate: c.value.toFixed(2),
          effectiveFrom,
          note: `Derived: chick ${chickCost}, feed ${feedRate.toFixed(4)}/kg at standard intake, overhead ${overheadPerWeek}/bird/week, grossed up for standard mortality`,
          createdBy: userId,
        })
        // Re-running for the same date corrects the curve rather than failing;
        // a NEW date leaves the old one in place, which is what keeps a closed
        // period valued at what was agreed at the time.
        .onConflictDoUpdate({
          target: [birdValuationRates.breedId, birdValuationRates.ageWeek, birdValuationRates.effectiveFrom],
          set: { rate: c.value.toFixed(2) },
        });
      wrote++;
    }
  }
  console.log("");
}

console.log(
  APPLY
    ? `  ${wrote} rate(s) written, effective ${effectiveFrom}\n`
    : "  nothing written — add --apply to save this curve\n",
);
process.exit(0);
