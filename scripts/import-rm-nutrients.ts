/**
 * Nutrient profiles for the materials the mill actually uses, from the
 * nutritionist's own workbook (docs/feed-rm-nutrients-2026-09.xls, sheet RM).
 *
 * That sheet has three blocks side by side: raw figures, amino-acid content,
 * and a computed block (columns 38-87) that already carries energy, the
 * proximates, calcium and both phosphorus figures, and all thirteen DIGESTIBLE
 * amino acids. The computed block is what niko stores, so it is the one read;
 * docs/feed-rm-nutrients-2026-09.json is that block extracted verbatim, so what
 * this writes can be checked against the workbook without opening Excel.
 *
 * Two units differ from niko's and are converted in the extract, not here:
 *
 *   ME is Mcal/kg on the sheet — maize reads 3.30, meaning 3,300 kcal/kg.
 *   Taking it at face value is exactly how the old Amino data ended up with a
 *   premix at 18,750 kcal/kg, twice the energy of pure fat.
 *
 *   Sodium, chloride and potassium are g/kg. They are carried in the extract
 *   but NOT written: niko's nutrient vocabulary has no key for them. Salt is
 *   in every one of these recipes and its only purpose is sodium, so this is
 *   worth closing, but adding a nutrient is a decision about what the standards
 *   must then specify.
 *
 * Only the materials named below are touched: thirteen of the sheet's
 * fifty-eight. Filling the item master with the rest would mean rows nobody
 * buys, each needing an account somebody guessed.
 *
 * Mapped BY ROW, not by name. The sheet carries DORB twice — row 8 at 16%
 * protein and row 71 at 15% — and the recipe names "DORB - 16", which settles
 * which one it means. By name the second would silently win.
 *
 *   npx tsx scripts/import-rm-nutrients.ts
 *   npx tsx scripts/import-rm-nutrients.ts --write
 */
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { accounts, itemNutrients, items, users } from "@shared/schema";
import { NUTRIENT_KEYS } from "@shared/feed";
import { db, pool } from "../server/db";

const write = process.argv.includes("--write");

/** niko's item name → the row it is on the RM sheet. */
const FROM_ROW: Record<string, number> = {
  "Maize": 1,
  "Broken Rice": 3,                       // B.Rice
  "De-Oiled Rice Bran (DORB - 16)": 8,    // DORB at 16% CP, not row 71's 15%
  "DOGN": 10,
  "Hypro Soya": 11,
  "Soybean Meal": 12,                     // SOYA, the 46% variant
  "DDGS Rice": 21,
  "L-Lysine HCl": 31,                     // Lysine
  "DL-Methionine": 32,                    // Methionine
  "DCP (Di-Calcium Phosphate)": 37,       // DCP
  "Salt": 39,
  "Soda Bicarb": 40,
  // The sheet offers two calcium sources; the user confirmed on 18 Sep 2026
  // that the recipes' "Lime Stone Grit" is LSP/Cal Carb at 37% Ca, not the
  // 30% SG on the row below it.
  "Lime Stone Grit": 35,
};

/**
 * In the recipes, absent from the sheet, or on it twice over. Reported rather
 * than guessed: a calcium source picked wrongly is a layer's shell.
 */
const UNRESOLVED: Record<string, string> = {
  "MixiBlend P": "not on the sheet at all",
  "Cantaxanthin": "not on the sheet at all",
};

/** Materials to have as items even though no current recipe calls for them. */
const ALSO_CREATE = ["Broken Rice"];

interface Extract {
  materials: Array<{ row: number; name: string; costPerKg: number | null; nutrients: Record<string, number>; notRecordedInNiko: Record<string, number> }>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const data = JSON.parse(readFileSync("docs/feed-rm-nutrients-2026-09.json", "utf8")) as Extract;
  const byRow = new Map(data.materials.map((m) => [m.row, m]));
  console.log(`\n  Nutrient profiles from the RM sheet — ${write ? "WRITING" : "dry run"}\n`);

  // Nothing physically impossible reaches the database. The same sweep over the
  // old Amino export found a premix above the energy of pure fat, and enzymes
  // whose dose numbers had been stored as percentages.
  const suspect: string[] = [];
  for (const [item, row] of Object.entries(FROM_ROW)) {
    const m = byRow.get(row);
    if (!m) { suspect.push(`${item}: row ${row} is not in the extract`); continue; }
    const n = m.nutrients;
    if (n.me != null && n.me > 9000) suspect.push(`${item}: ME ${n.me} kcal/kg is above pure fat`);
    if (n.totalP != null && n.avP != null && n.avP > n.totalP + 1e-9) suspect.push(`${item}: available P ${n.avP} exceeds total P ${n.totalP}`);
    for (const k of NUTRIENT_KEYS) {
      if (k === "me") continue;
      const v = n[k];
      if (v != null && v > 100) suspect.push(`${item}: ${k} = ${v}, a percentage above 100`);
    }
    const unknown = Object.keys(n).filter((k) => !NUTRIENT_KEYS.includes(k));
    if (unknown.length) suspect.push(`${item}: keys niko has no home for — ${unknown.join(", ")}`);
  }
  if (suspect.length) {
    console.log("  These do not stand up, and nothing is written while they are here:");
    for (const s of suspect) console.log(`    ✗ ${s}`);
    throw new Error(`${suspect.length} suspect value(s)`);
  }
  console.log("  every value checks out: no energy above pure fat, no percentage over 100, available P within total P\n");

  const existing = await db.select({ id: items.id, name: items.name }).from(items);
  const byNorm = new Map(existing.map((i) => [norm(i.name), i]));

  const missing = Object.keys(FROM_ROW).filter((n) => !byNorm.has(norm(n)));
  const toCreate = missing.filter((n) => ALSO_CREATE.includes(n));
  const absent = missing.filter((n) => !ALSO_CREATE.includes(n));
  if (absent.length) {
    console.log(`  ! not in the item master and not on the create list: ${absent.join(", ")}`);
    console.log("    run import-formulas-2026-09.ts first — it makes the recipe's ingredients\n");
  }

  const rows: Array<{ item: string; id: string; n: Record<string, number>; cost: number | null }> = [];
  for (const [name, row] of Object.entries(FROM_ROW)) {
    const hit = byNorm.get(norm(name));
    if (!hit && !ALSO_CREATE.includes(name)) continue;
    rows.push({ item: name, id: hit?.id ?? "", n: byRow.get(row)!.nutrients, cost: byRow.get(row)!.costPerKg });
  }

  console.log(`  ${"material".padEnd(32)}${"values".padStart(7)}${"ME".padStart(8)}${"CP".padStart(7)}${"Ca".padStart(7)}${"avP".padStart(7)}`);
  for (const r of rows) {
    const f = (k: string) => (r.n[k] == null ? "     -" : String(r.n[k]).padStart(6));
    console.log(`  ${r.item.slice(0, 31).padEnd(32)}${String(Object.keys(r.n).length).padStart(7)}${f("me").padStart(8)}${f("cp")}${f("ca")}${f("avP")}`);
  }

  console.log(`\n  in a recipe but still without a profile:`);
  for (const [n, why] of Object.entries(UNRESOLVED)) console.log(`    ${n.padEnd(28)} ${why}`);

  const na = data.materials.filter((m) => Object.values(FROM_ROW).includes(m.row) && m.notRecordedInNiko.sodium != null).length;
  console.log(`\n  ${na} of these carry sodium and chloride on the sheet; niko has no nutrient key for either, so they are not written.`);

  if (!write) {
    console.log("\n  Dry run — nothing written. Re-run with --write.\n");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  let written = 0;
  await db.transaction(async (tx) => {
    let feedAcct: string | null = null;
    let stockAcct: string | null = null;
    if (toCreate.length) {
      const one = async (...names: string[]) => {
        for (const n of names) {
          const [a] = await tx.select({ id: accounts.id }).from(accounts).where(sql`lower(${accounts.name}) = ${n.toLowerCase()}`);
          if (a) return a.id;
        }
        return null;
      };
      feedAcct = await one("Feed & Additives");
      stockAcct = await one("Feed Stock", "Inventories");
    }
    for (const name of toCreate) {
      const [row] = await tx.insert(items).values({
        name, unit: "kg", category: "feed", isFeedIngredient: true,
        isPurchased: true, purchaseAccountId: feedAcct, isSold: false,
        trackInventory: true, inventoryAccountId: stockAcct, isActive: true,
      } as typeof items.$inferInsert).returning({ id: items.id });
      byNorm.set(norm(name), { id: row!.id, name });
      console.log(`  + created ${name}`);
    }

    for (const r of rows) {
      const id = r.id || byNorm.get(norm(r.item))!.id;
      // The item is a feed ingredient by the fact that it has an analysis.
      await tx.update(items).set({ isFeedIngredient: true }).where(eq(items.id, id));
      for (const [nutrient, value] of Object.entries(r.n)) {
        await tx.insert(itemNutrients).values({
          itemId: id, nutrient, value: String(value),
          source: "book", notes: "Nutritionist's RM sheet, 18 Sep 2026", updatedBy: admin?.id ?? null,
        }).onConflictDoUpdate({
          target: [itemNutrients.itemId, itemNutrients.nutrient],
          set: { value: String(value), source: "book", notes: "Nutritionist's RM sheet, 18 Sep 2026", updatedAt: new Date() },
        });
        written++;
      }
    }
  });
  console.log(`\n  Written: ${written} nutrient value(s) across ${rows.length} material(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
