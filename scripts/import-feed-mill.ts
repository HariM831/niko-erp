/**
 * Imports Amino's real feed mill configuration from the JSON that
 * `scripts/export-feed-mill.ts` (in the Amino repo, run on Replit) produced.
 *
 * What it does, in order:
 *
 *   MATERIALS — matched to EGGSY items by name, then by alias, then by a
 *     normalised comparison. A match is marked `isFeedIngredient`, given the
 *     export's price where EGGSY has none, and its nutrient profile written
 *     (source "book"). An Amino material with no EGGSY item is REPORTED, never
 *     invented — the item master is procurement's, and a half-created item
 *     with no account is worse than a line in a report.
 *
 *   HOUSES — sheds become locations (type farm) where no location of that
 *     name exists.
 *
 *   FORMULAS — each active Amino formula becomes v1 here, its batch size the
 *     sum of its ingredient kg (that is what an Amino recipe weighs), dosage
 *     limits carried onto the lines. Its output item is created if missing:
 *     inventory-tracked, pointed at 1073 Feed Stock. A formula with any
 *     unmatched ingredient is skipped and reported — a recipe missing a line
 *     would produce wrong feed silently.
 *
 * DRY RUN by default. Nothing writes until --write is passed:
 *
 *   npx tsx scripts/import-feed-mill.ts feed-mill-export.json
 *   npx tsx scripts/import-feed-mill.ts feed-mill-export.json --write
 *
 * Idempotent: run twice, the second run finds everything in place and writes
 * nothing new. Existing EGGSY formulas of the same name are superseded, not
 * duplicated.
 */
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  formulaLines,
  formulas,
  itemNutrients,
  items,
  locations,
} from "@shared/schema";
import { NUTRIENT_KEYS } from "@shared/feed";
import { db } from "../server/db";

interface Export {
  exportedAt: string;
  materials: Array<{
    name: string;
    costPerKg: number | null;
    bagWeightKg: number | null;
    nutrients: Record<string, number>;
  }>;
  formulas: Array<{
    name: string;
    isActive: boolean;
    ingredients: Array<{ materialName: string; quantityKg: number }>;
    dosageLimits: Record<string, { min: string; max: string }>;
  }>;
  sheds: Array<{ name: string; type: string; farmName: string | null }>;
}

const [, , file, writeFlag] = process.argv;
if (!file) {
  console.error("Usage: npx tsx scripts/import-feed-mill.ts <export.json> [--write]");
  process.exit(1);
}
const WRITE = writeFlag === "--write";
const data = JSON.parse(readFileSync(file, "utf-8")) as Export;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function main() {
  console.log(`\nAmino export of ${data.exportedAt} — ${WRITE ? "WRITING" : "dry run, nothing will change"}\n`);

  const allItems = await db.select().from(items);
  const byNorm = new Map(allItems.map((i) => [norm(i.name), i]));
  const byAlias = new Map(
    allItems.flatMap((i) => (i.aliases ?? []).map((a) => [norm(a), i] as const)),
  );
  const findItem = (name: string) => byNorm.get(norm(name)) ?? byAlias.get(norm(name));

  // ── Materials ──
  const unmatched: string[] = [];
  let profiled = 0;
  for (const m of data.materials) {
    const item = findItem(m.name);
    if (!item) {
      unmatched.push(m.name);
      continue;
    }
    const values = Object.entries(m.nutrients).filter(([k]) => NUTRIENT_KEYS.includes(k));
    console.log(
      `  material ${m.name.padEnd(34)} → ${item.name.padEnd(34)} ${values.length} nutrient(s)` +
        (m.costPerKg && !Number(item.costPrice) ? ` price ₹${m.costPerKg}` : ""),
    );
    profiled++;
    if (!WRITE) continue;
    await db.transaction(async (tx) => {
      await tx
        .update(items)
        .set({
          isFeedIngredient: true,
          // The export's price fills a blank; a price EGGSY already has wins,
          // because EGGSY's came through procurement and is newer.
          ...(m.costPerKg && !Number(item.costPrice) ? { costPrice: String(m.costPerKg) } : {}),
          ...(m.bagWeightKg && item.unitBagWeightKg == null
            ? { unitBagWeightKg: String(m.bagWeightKg) }
            : {}),
        })
        .where(eq(items.id, item.id));
      for (const [nutrient, value] of values) {
        await tx
          .insert(itemNutrients)
          .values({ itemId: item.id, nutrient, value: String(value), source: "book" })
          .onConflictDoNothing();
      }
    });
  }

  // ── Houses ──
  const locs = await db.select().from(locations);
  const locByNorm = new Set(locs.map((l) => norm(l.name)));
  let housesMade = 0;
  for (const s of data.sheds) {
    if (locByNorm.has(norm(s.name))) continue;
    console.log(`  house    ${s.name}${s.farmName ? ` (${s.farmName})` : ""} → new location`);
    housesMade++;
    if (!WRITE) continue;
    await db.insert(locations).values({
      code: s.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase() || `H${housesMade}`,
      name: s.name,
      type: "farm",
    });
  }

  // ── Formulas ──
  const [feedStock] = await db.select().from(accounts).where(eq(accounts.code, "1073"));
  if (!feedStock) throw new Error("Account 1073 Feed Stock is missing");
  let formulasMade = 0;
  const skipped: string[] = [];

  for (const f of data.formulas.filter((x) => x.isActive)) {
    const lines = f.ingredients.map((i) => ({ ...i, item: findItem(i.materialName) }));
    const missing = lines.filter((l) => !l.item);
    if (missing.length) {
      skipped.push(`${f.name} (missing: ${missing.map((m) => m.materialName).join(", ")})`);
      continue;
    }
    const batchKg = lines.reduce((s, l) => s + l.quantityKg, 0);
    console.log(`  formula  ${f.name.padEnd(30)} ${lines.length} ingredients · ${batchKg.toLocaleString("en-IN")} kg/batch`);
    formulasMade++;
    if (!WRITE) continue;

    await db.transaction(async (tx) => {
      // The finished feed item, created tracked if the name is new.
      let output = findItem(f.name);
      if (!output) {
        const [made] = await tx
          .insert(items)
          .values({
            name: f.name,
            unit: "kg",
            isSold: false,
            isPurchased: false,
            trackInventory: true,
            inventoryAccountId: feedStock.id,
          })
          .returning();
        output = made!;
        byNorm.set(norm(f.name), output);
      } else if (!output.trackInventory) {
        await tx
          .update(items)
          .set({ trackInventory: true, inventoryAccountId: output.inventoryAccountId ?? feedStock.id })
          .where(eq(items.id, output.id));
      }

      const [row] = await tx
        .select({ next: sql<number>`coalesce(max(${formulas.version}), 0) + 1` })
        .from(formulas)
        .where(eq(formulas.name, f.name));
      await tx
        .update(formulas)
        .set({ isActive: false })
        .where(and(eq(formulas.name, f.name), eq(formulas.isActive, true)));
      const [created] = await tx
        .insert(formulas)
        .values({
          name: f.name,
          version: row!.next,
          outputItemId: output.id,
          batchSizeKg: batchKg.toFixed(3),
          effectiveFrom: new Date().toISOString().slice(0, 10),
          notes: `Imported from Amino feed mill (export of ${data.exportedAt.slice(0, 10)})`,
        })
        .returning();
      await tx.insert(formulaLines).values(
        lines.map((l, i) => {
          const lim = f.dosageLimits[l.materialName];
          return {
            formulaId: created!.id,
            itemId: l.item!.id,
            quantityKg: l.quantityKg.toFixed(3),
            minPercent: lim?.min?.trim() ? lim.min : null,
            maxPercent: lim?.max?.trim() ? lim.max : null,
            sortOrder: i,
          };
        }),
      );
    });
  }

  console.log(`\n  ${profiled} material(s) matched, ${housesMade} house(s) new, ${formulasMade} formula(s) ready`);
  if (unmatched.length) {
    console.log(`\n  NO EGGSY ITEM for these Amino materials — add them or an alias, then re-run:`);
    for (const u of unmatched) console.log(`    - ${u}`);
  }
  if (skipped.length) {
    console.log(`\n  FORMULAS SKIPPED until their materials match:`);
    for (const s of skipped) console.log(`    - ${s}`);
  }
  if (!WRITE) console.log(`\n  Dry run only. Re-run with --write to apply.`);
  process.exit(0);
}

void main();
