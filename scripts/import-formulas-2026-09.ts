/**
 * The five recipes the mill is actually running, from the sheet dated
 * 18 Sep 2026 ("All Formulas — Ingredient Breakdown").
 *
 * They supersede what came out of Amino in August: that export carried four
 * recipes, this sheet carries five — Layer 2 is new — and several inclusions
 * have moved. The quantities below are transcribed from that sheet and are
 * kilograms per batch, not percentages; each batch is about 1,500 kg and no
 * two weigh quite the same, which is why the batch size is the sum of the
 * lines rather than a round figure somebody assumed.
 *
 * Every formula is given its LIFE STAGE. That is what orders them on screen —
 * `life_stage` is a Postgres enum and an enum sorts by its declared order,
 * which is chick, developer, grower, prelayer, then the layer phases. Layer 3
 * will fall into place the day it exists, with nothing to change here.
 *
 * Accounts are resolved BY NAME, not by code. The scripts written in August
 * hard-code 5007 and 1072/1073, which are Zoho's numbers; production is still
 * on the seeded chart where the same accounts are 5001, 1230 and 1232. A name
 * survives a renumbering, and the Zoho load adopts by name too.
 *
 * DRY RUN by default; nothing is written until --write.
 *
 *   npx tsx scripts/import-formulas-2026-09.ts
 *   npx tsx scripts/import-formulas-2026-09.ts --write
 *
 * Idempotent: a second run finds everything in place. An existing active
 * formula of the same name is left alone and reported — superseding a live
 * recipe is a decision, not a side effect of re-running an import.
 */
import { and, eq, sql } from "drizzle-orm";
import { accounts, formulaLines, formulas, items, users } from "@shared/schema";
import { db, pool } from "../server/db";

const write = process.argv.includes("--write");

/** The sheet, as transcribed. kg per batch; a blank means the recipe omits it. */
const SHEET: Record<string, Record<string, number>> = {
  //                          Chick   Grower  Prelayer Layer 1 Layer 2
  "Cantaxanthin":            {                                  "Layer 1": 0.15, "Layer 2": 0.225 },
  "DCP (Di-Calcium Phosphate)": { Chick: 15, Grower: 10, Prelayer: 10, "Layer 1": 9, "Layer 2": 7 },
  "DDGS Rice":               { Chick: 75, Grower: 75, Prelayer: 75, "Layer 1": 75, "Layer 2": 75 },
  "De-Oiled Rice Bran (DORB - 16)": { Chick: 97, Grower: 225, Prelayer: 240, "Layer 1": 180, "Layer 2": 180 },
  "DL-Methionine":           { Prelayer: 1.5, "Layer 1": 1 },
  "DOGN":                    { Grower: 75, Prelayer: 45 },
  "Hypro Soya":              { Chick: 262, Grower: 105, Prelayer: 150 },
  "L-Lysine HCl":            { Grower: 1.5, Prelayer: 2 },
  "Lime Stone Grit":         { Chick: 30, Grower: 75, Prelayer: 90, "Layer 1": 150, "Layer 2": 180 },
  "Maize":                   { Chick: 1013, Grower: 920, Prelayer: 870, "Layer 1": 860, "Layer 2": 875 },
  "MixiBlend P":             { Chick: 6, Grower: 6, Prelayer: 8, "Layer 1": 6, "Layer 2": 6 },
  "Salt":                    { Chick: 4, Grower: 4, Prelayer: 5, "Layer 1": 5, "Layer 2": 5 },
  "Soda Bicarb":             { Chick: 1, Grower: 2, Prelayer: 2, "Layer 1": 2, "Layer 2": 2 },
  "Soybean Meal":            { "Layer 1": 210, "Layer 2": 170 },
};

/** The sheet's own totals, asserted against the sum of the lines. */
const STATED_TOTAL: Record<string, number> = {
  Chick: 1503, Grower: 1498.5, Prelayer: 1498.5, "Layer 1": 1498.15, "Layer 2": 1500.225,
};

/** In the order a bird lives them, which is the order the enum declares. */
const STAGE: Record<string, "chick_starter" | "grower" | "prelayer" | "layer_1" | "layer_2"> = {
  Chick: "chick_starter", Grower: "grower", Prelayer: "prelayer", "Layer 1": "layer_1", "Layer 2": "layer_2",
};
const RECIPES = ["Chick", "Grower", "Prelayer", "Layer 1", "Layer 2"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (n: number) => n.toFixed(2);

async function accountByName(...names: string[]) {
  for (const n of names) {
    const [a] = await db.select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts).where(sql`lower(${accounts.name}) = ${n.toLowerCase()}`);
    if (a) return a;
  }
  return null;
}

async function main() {
  console.log(`\n  Formulas from the sheet of 18 Sep 2026 — ${write ? "WRITING" : "dry run"}\n`);

  // Arithmetic first: a transcription error must not reach the mill.
  let bad = 0;
  for (const r of RECIPES) {
    const sum = Object.values(SHEET).reduce((s, by) => s + (by[r] ?? 0), 0);
    const stated = STATED_TOTAL[r]!;
    const ok = Math.abs(sum - stated) < 0.0005;
    if (!ok) bad++;
    console.log(`  ${r.padEnd(10)} ${Object.values(SHEET).filter((by) => by[r]).length} lines, ${sum.toFixed(3)} kg` +
      (ok ? `  = the sheet's ${stated}` : `  ✗ the sheet says ${stated}`));
  }
  if (bad) throw new Error(`${bad} recipe(s) do not add up to the sheet — transcription is wrong, nothing written`);

  const purchase = await accountByName("Feed & Additives");
  const stock = await accountByName("Feed Stock", "Inventories");
  if (!purchase || !stock) throw new Error("No 'Feed & Additives' or feed stock account in this chart");
  console.log(`\n  raw materials buy to ${purchase.code} ${purchase.name}; finished feed sits in ${stock.code} ${stock.name}`);

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);

  const existing = await db.select({ id: items.id, name: items.name }).from(items);
  const byNorm = new Map(existing.map((i) => [norm(i.name), i]));

  const wantMaterials = Object.keys(SHEET);
  const newMaterials = wantMaterials.filter((m) => !byNorm.has(norm(m)));
  const newOutputs = RECIPES.map((r) => `${r} Feed`).filter((o) => !byNorm.has(norm(o)));
  console.log(`\n  ${wantMaterials.length} materials: ${wantMaterials.length - newMaterials.length} already on file, ${newMaterials.length} to create`);
  for (const m of newMaterials) console.log(`      + ${m}`);
  console.log(`  ${RECIPES.length} output items: ${RECIPES.length - newOutputs.length} on file, ${newOutputs.length} to create`);

  const live = await db.select({ name: formulas.name }).from(formulas).where(eq(formulas.isActive, true));
  const liveNames = new Set(live.map((f) => f.name));
  const clashes = RECIPES.filter((r) => liveNames.has(r));
  if (clashes.length) {
    console.log(`\n  ! already live, left untouched: ${clashes.join(", ")}`);
    console.log("    superseding a running recipe is a decision — say so and I will version them up");
  }
  const toMake = RECIPES.filter((r) => !liveNames.has(r));

  if (!write) {
    console.log(`\n  would create ${toMake.length} formula(s): ${toMake.join(", ")}`);
    console.log("\n  Dry run — nothing written. Re-run with --write.\n");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    const idOf = new Map(byNorm);
    const ensure = async (name: string, kind: "material" | "output") => {
      const hit = idOf.get(norm(name));
      if (hit) return hit.id;
      const [row] = await tx.insert(items).values({
        name,
        unit: "kg",
        category: "feed",
        isFeedIngredient: kind === "material",
        isPurchased: kind === "material",
        purchaseAccountId: kind === "material" ? purchase.id : null,
        isSold: false,
        salesAccountId: null,
        trackInventory: true,
        inventoryAccountId: stock.id,
        isActive: true,
      } as typeof items.$inferInsert).returning({ id: items.id, name: items.name });
      idOf.set(norm(name), row!);
      return row!.id;
    };

    for (const name of wantMaterials) await ensure(name, "material");

    for (const r of toMake) {
      const outputId = await ensure(`${r} Feed`, "output");
      const lines = wantMaterials
        .map((m) => ({ m, kg: SHEET[m]![r] ?? 0 }))
        .filter((l) => l.kg > 0);
      const batch = lines.reduce((s, l) => s + l.kg, 0);
      const [f] = await tx.insert(formulas).values({
        name: r,
        outputItemId: outputId,
        stage: STAGE[r],
        batchSizeKg: batch.toFixed(3),
        version: 1,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        isActive: true,
        notes: "Transcribed from the mill's sheet of 18 Sep 2026",
        createdBy: admin?.id ?? null,
      }).returning({ id: formulas.id });

      let order = 0;
      for (const l of lines) {
        await tx.insert(formulaLines).values({
          formulaId: f!.id,
          itemId: idOf.get(norm(l.m))!.id,
          quantityKg: l.kg.toFixed(3),
          sortOrder: order++,
        });
      }
      console.log(`  ${r.padEnd(10)} ${lines.length} lines, ${batch.toFixed(3)} kg → ${r} Feed`);
    }
  });

  console.log(`\n  Written: ${toMake.length} formula(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
