/**
 * Checks the semantics a nutrient profile rests on.
 *
 * The one that matters most: BLANK IS NOT ZERO. A missing reading means "we do
 * not know"; a zero tells the solver the material contains none of the nutrient,
 * which frees it to use as much of that material as it likes. Clearing a reading
 * must therefore DELETE the row, never write 0.
 *
 * Also: upsert is per nutrient — a lab result for one figure must not blank the
 * panel somebody typed last month — and the feed-ingredient flag is what keeps
 * cement off the nutritionist's screens.
 *
 * Rolled back; nothing survives.
 *
 * Run: npx tsx scripts/check-feed-nutrients.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { itemNutrients, items } from "@shared/schema";
import { NUTRIENTS, NUTRIENT_KEYS, nutrientLabel } from "@shared/feed";
import { db } from "../server/db";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
};

class Rollback extends Error {}

console.log("\n  THE VOCABULARY\n");

check("every nutrient key is unique", new Set(NUTRIENT_KEYS).size === NUTRIENTS.length);
check(
  "ME is the one non-percentage, and it says so",
  nutrientLabel("me") === "ME (kcal/kg)" && NUTRIENTS.filter((n) => n.unit !== "%").length === 1,
  nutrientLabel("me"),
);
check("an unknown key falls back to itself", nutrientLabel("nonesuch") === "nonesuch");

try {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: items.id, name: items.name })
      .from(items)
      .where(eq(items.isFeedIngredient, true))
      .limit(1);
    if (!item) throw new Error("Need a feed ingredient to test against");

    console.log("\n  BLANK IS NOT ZERO\n");

    // This item carries real book values, so the two nutrients under test are
    // cleared first — inside the transaction, which is rolled back with the rest.
    await tx
      .delete(itemNutrients)
      .where(
        and(eq(itemNutrients.itemId, item.id), inArray(itemNutrients.nutrient, ["cf", "fat"])),
      );

    // Set two readings, then clear one the way the route does: by deletion.
    await tx.insert(itemNutrients).values([
      { itemId: item.id, nutrient: "cf", value: "12.5", source: "book" as const },
      { itemId: item.id, nutrient: "fat", value: "3.1", source: "lab" as const },
    ]);

    await tx
      .delete(itemNutrients)
      .where(and(eq(itemNutrients.itemId, item.id), eq(itemNutrients.nutrient, "cf")));

    const left = await tx
      .select({ nutrient: itemNutrients.nutrient, value: itemNutrients.value })
      .from(itemNutrients)
      .where(and(eq(itemNutrients.itemId, item.id), eq(itemNutrients.nutrient, "cf")));
    check("clearing a reading deletes the row", left.length === 0, "no zero written in its place");

    const kept = await tx
      .select({ value: itemNutrients.value, source: itemNutrients.source })
      .from(itemNutrients)
      .where(and(eq(itemNutrients.itemId, item.id), eq(itemNutrients.nutrient, "fat")));
    check(
      "the reading beside it is untouched",
      kept.length === 1 && Number(kept[0]!.value) === 3.1 && kept[0]!.source === "lab",
      `${item.name} fat ${Number(kept[0]?.value ?? 0)}% (${kept[0]?.source})`,
    );

    console.log("\n  ONE ROW PER NUTRIENT\n");

    let refused = false;
    try {
      await tx.transaction(async (inner) => {
        await inner
          .insert(itemNutrients)
          .values({ itemId: item.id, nutrient: "fat", value: "9.9" });
      });
    } catch (e) {
      refused = (e as { code?: string }).code === "23505";
    }
    check("a second row for the same nutrient is refused", refused, "upsert or nothing");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

console.log(failed === 0 ? "\n  All nutrient checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
