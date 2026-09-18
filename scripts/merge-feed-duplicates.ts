/**
 * Fold the feed items I created onto the ones that already carry the buying.
 *
 * import-formulas-2026-09.ts matched a recipe's ingredient to the item master
 * by name, and the mill's names are not the office's: the recipe says
 * "Soda Bicarb" where the ledger says "Sodium Bicarbonate", "DCP
 * (Di-Calcium Phosphate)" against "Dicalcium Phosphate", "Lime Stone Grit"
 * against "Lime Stone Grits". Eight ingredients therefore arrived as new items
 * with no purchase history and no price, standing beside items holding years
 * of it — 69 DORB purchases, 24 of limestone.
 *
 * Each duplicate's formula lines and nutrient profile move to the real item and
 * the duplicate goes. Nothing that was ever bought, stocked or billed is
 * touched: the duplicates are days old and referenced only by the recipes this
 * same pair of scripts wrote.
 *
 * Soybean Meal is NOT in this list. It reads like a duplicate of the two
 * hi-pro soyas and is not one: the recipes use hi-pro (50% protein) AND a 46%
 * soyabean meal, and both existing items are hi-pro. It stays as its own item.
 *
 *   npx tsx scripts/merge-feed-duplicates.ts
 *   npx tsx scripts/merge-feed-duplicates.ts --write
 */
import { eq, sql } from "drizzle-orm";
import { formulaLines, itemNutrients, items } from "@shared/schema";
import { db, pool } from "../server/db";

const write = process.argv.includes("--write");

/** The item I made → the item that has the history. */
const FOLD: Record<string, string> = {
  "De-Oiled Rice Bran (DORB - 16)": "DORB (De-Oiled Rice Bran)",
  "DOGN": "DOGN (De-Oiled Ground Nut)",
  "Hypro Soya": "Soya Hipro (DOC)",
  "Lime Stone Grit": "Lime Stone Grits",
  "L-Lysine HCl": "L-Lysine",
  "Soda Bicarb": "Sodium Bicarbonate",
  "DCP (Di-Calcium Phosphate)": "Dicalcium Phosphate",
  "MixiBlend P": "Mixiblend P Layer Premix (4Kg)",
};

/**
 * Bought in kilograms and recorded as "pieces" — 691,420 of them. A formula is
 * costed per kilo, so a per-piece rate against a kilo quantity is wrong before
 * the arithmetic starts. Confirmed as kg by the user on 18 Sep 2026.
 */
const FIX_UNIT: Record<string, string> = { "Soya Hipro (DOC)": "kg" };

async function main() {
  console.log(`\n  Folding duplicate feed items — ${write ? "WRITING" : "dry run"}\n`);

  const all = await db.select({ id: items.id, name: items.name, unit: items.unit }).from(items);
  const byName = new Map(all.map((i) => [i.name, i]));

  const plan: Array<{ dupe: typeof all[number]; target: typeof all[number]; lines: number; nutrients: number }> = [];
  const missing: string[] = [];
  for (const [dupeName, targetName] of Object.entries(FOLD)) {
    const dupe = byName.get(dupeName);
    const target = byName.get(targetName);
    if (!dupe || !target) { missing.push(`${dupeName} -> ${targetName}`); continue; }
    const [{ n: lines }] = await db.select({ n: sql<number>`count(*)::int` }).from(formulaLines).where(eq(formulaLines.itemId, dupe.id));
    const [{ n: nutrients }] = await db.select({ n: sql<number>`count(*)::int` }).from(itemNutrients).where(eq(itemNutrients.itemId, dupe.id));
    plan.push({ dupe, target, lines: lines!, nutrients: nutrients! });
  }
  if (missing.length) {
    console.log("  not found, so nothing to fold:");
    for (const m of missing) console.log(`    ${m}`);
    console.log();
  }

  // A duplicate that has been bought, stocked or billed is not a duplicate.
  const unsafe: string[] = [];
  for (const p of plan) {
    const [{ n }] = await db.execute(sql`
      SELECT (SELECT count(*) FROM bill_lines WHERE item_id = ${p.dupe.id}::uuid)
           + (SELECT count(*) FROM invoice_lines WHERE item_id = ${p.dupe.id}::uuid) AS n
    `).then((r) => r.rows as Array<{ n: number }>);
    if (Number(n) > 0) unsafe.push(`${p.dupe.name} is on ${n} document line(s)`);
  }
  if (unsafe.length) {
    for (const u of unsafe) console.log(`  x ${u}`);
    throw new Error("a duplicate has documents against it — stopping rather than moving history");
  }

  console.log(`  ${"duplicate".padEnd(32)}${"lines".padStart(6)}${"values".padStart(8)}   folds onto`);
  for (const p of plan) {
    console.log(`  ${p.dupe.name.slice(0, 31).padEnd(32)}${String(p.lines).padStart(6)}${String(p.nutrients).padStart(8)}   ${p.target.name}`);
  }
  for (const [name, unit] of Object.entries(FIX_UNIT)) {
    const it = byName.get(name);
    if (it && it.unit !== unit) console.log(`\n  unit: ${name} is "${it.unit}" and should be "${unit}"`);
  }

  if (!write) {
    console.log("\n  Dry run — nothing written. Re-run with --write.\n");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const p of plan) {
      // The recipe may already name the target as well; the index on
      // (formula, item) forbids two lines of one ingredient, so a collision is
      // reported rather than silently doubling the inclusion.
      const clash = await tx.execute(sql`
        SELECT f.name FROM formula_lines a
          JOIN formula_lines b ON b.formula_id = a.formula_id AND b.item_id = ${p.target.id}::uuid
          JOIN formulas f ON f.id = a.formula_id
         WHERE a.item_id = ${p.dupe.id}::uuid
      `);
      if (clash.rows.length) {
        throw new Error(`${p.dupe.name} and ${p.target.name} are both on ${(clash.rows[0] as any).name} — merge those by hand`);
      }
      await tx.update(formulaLines).set({ itemId: p.target.id }).where(eq(formulaLines.itemId, p.dupe.id));
      // The analysis belongs to the material, not to the row that held it.
      await tx.delete(itemNutrients).where(eq(itemNutrients.itemId, p.target.id));
      await tx.update(itemNutrients).set({ itemId: p.target.id }).where(eq(itemNutrients.itemId, p.dupe.id));
      await tx.update(items).set({ isFeedIngredient: true, category: "feed" }).where(eq(items.id, p.target.id));
      await tx.delete(items).where(eq(items.id, p.dupe.id));
      console.log(`  ${p.dupe.name} -> ${p.target.name}`);
    }
    for (const [name, unit] of Object.entries(FIX_UNIT)) {
      const it = byName.get(name);
      if (it && it.unit !== unit) {
        await tx.update(items).set({ unit }).where(eq(items.id, it.id));
        console.log(`  unit: ${name} ${it.unit} -> ${unit}`);
      }
    }
  });

  console.log(`\n  Folded ${plan.length} duplicate(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
