/**
 * Create the raw materials a formula needs and niko has never bought.
 *
 * import-feed-mill.ts deliberately will not do this: it reports an unmatched
 * material rather than inventing one, because the item master is office's and
 * a half-created item with no account is worse than a line in a report. That
 * is right as a default and wrong as a permanent answer — a recipe cannot
 * import while an ingredient does not exist, so the item has to be made
 * somewhere, deliberately, with its accounts chosen rather than defaulted.
 *
 * Scope is the formulas, not the export. Amino lists 155 materials; the four
 * recipes name 13. Creating the other hundred would fill the master with
 * things nobody buys through niko, each with no purchase history and an
 * account somebody guessed. `--all-profiled` widens it to every material
 * carrying an analysis, for when the nutritionist wants the full shelf.
 *
 * Accounts are not guessed. Feed inputs here are bought to 5007 Feed &
 * Additives and capitalise to 1072 Inventory — the convention every existing
 * feed item follows, and what the Zoho bills for these very materials were
 * coded to.
 *
 * Nutrient profiles are left to import-feed-mill.ts, which is the thing that
 * owns them; run it after this.
 *
 *   npx tsx scripts/create-feed-materials.ts                 # report
 *   npx tsx scripts/create-feed-materials.ts --write
 *   npx tsx scripts/create-feed-materials.ts --all-profiled --write
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { accounts, items } from "@shared/schema";
import { db, pool } from "../server/db";
import { normName } from "../server/services/item-names";

const FILE = "feed-mill-export.json";
const PURCHASE_CODE = "5007"; // Feed & Additives
const INVENTORY_CODE = "1072"; // Inventory

interface Material {
  name: string;
  costPerKg?: number;
  bagWeightKg?: number;
  nutrients?: Record<string, unknown>;
}
interface FeedExport {
  materials: Material[];
  formulas: Array<{ name: string; isActive: boolean; ingredients: Array<{ materialName: string }> }>;
}

async function main() {
  const write = process.argv.includes("--write");
  const allProfiled = process.argv.includes("--all-profiled");

  const data = JSON.parse(readFileSync(FILE, "utf8")) as FeedExport;

  const [purchase] = await db.select().from(accounts).where(eq(accounts.code, PURCHASE_CODE));
  const [inventory] = await db.select().from(accounts).where(eq(accounts.code, INVENTORY_CODE));
  if (!purchase) throw new Error(`No account ${PURCHASE_CODE} — nothing to buy these to`);
  if (!inventory) throw new Error(`No account ${INVENTORY_CODE} — nothing to capitalise them into`);

  // Aliases count as knowing the material: half of these resolve only through
  // one, which is the whole point of having recorded them.
  const live = await db.select({ name: items.name, aliases: items.aliases }).from(items);
  const known = new Set<string>();
  for (const i of live) {
    known.add(normName(i.name));
    for (const a of i.aliases ?? []) known.add(normName(a));
  }

  const neededByFormula = new Set(
    data.formulas.flatMap((f) => f.ingredients.map((i) => normName(i.materialName))),
  );

  const wanted = data.materials.filter((m) => {
    if (known.has(normName(m.name))) return false;
    const profiled = Object.keys(m.nutrients ?? {}).length > 0;
    return allProfiled ? profiled : neededByFormula.has(normName(m.name));
  });

  console.log(
    `${data.materials.length} materials in the export; ${neededByFormula.size} named by a formula.`,
  );
  console.log(
    `\nTo create (${wanted.length})${allProfiled ? " — every profiled material" : " — formula ingredients only"}:`,
  );
  for (const m of wanted) {
    console.log(
      `  ${m.name.padEnd(34)} ${Object.keys(m.nutrients ?? {}).length} nutrient(s)` +
        (m.costPerKg ? `  ₹${m.costPerKg}/kg` : "") +
        (m.bagWeightKg ? `  ${m.bagWeightKg}kg/bag` : ""),
    );
  }
  console.log(`\n  buying to    ${purchase.code} ${purchase.name}`);
  console.log(`  stocking in  ${inventory.code} ${inventory.name}`);

  if (!wanted.length) {
    console.log("\nNothing to create.");
    await pool.end();
    return;
  }
  if (!write) {
    console.log("\nReport only — nothing written. Re-run with --write.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const m of wanted) {
      await tx.insert(items).values({
        name: m.name,
        category: "feed",
        // An analysis is what makes something a feed ingredient rather than
        // merely a feed-shelf purchase — see import-feed-mill.ts.
        isFeedIngredient: Object.keys(m.nutrients ?? {}).length > 0,
        unit: "kg",
        purchaseAccountId: purchase.id,
        inventoryAccountId: inventory.id,
        trackInventory: true,
        isSold: false,
        ...(m.costPerKg ? { costPrice: String(m.costPerKg) } : {}),
        ...(m.bagWeightKg ? { unitBagWeightKg: String(m.bagWeightKg) } : {}),
      });
    }
  });
  console.log(`\nCreated ${wanted.length} item(s). Run import-feed-mill.ts to load their profiles and formulas.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  await pool.end();
  process.exit(1);
});
