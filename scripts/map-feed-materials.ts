/**
 * Teach niko the wordings Amino uses for feed materials, so the feed-mill
 * import can find them.
 *
 * The importer matches an Amino material to a niko item by name, then by
 * alias, and reports anything it cannot place rather than inventing an item.
 * That is the right instinct — a half-created item with no account is worse
 * than a line in a report — but it leaves the same nine materials unplaceable
 * on every run, because the two systems simply spell them differently:
 * "MixiBlend P" here is "Mixiblend Layer Premix 4Kg" there.
 *
 * This records those equivalences once, confirmed by the people who buy the
 * material, so `import-feed-mill.ts` resolves them from then on. It creates
 * exactly one item — the groundnut cake, which genuinely exists nowhere in
 * niko — and does so explicitly rather than as a side effect of an import.
 *
 * Dry by default; --write to apply. Safe to re-run: learnAlias ignores a
 * wording it already knows, and the item is created only if absent.
 */
import { eq } from "drizzle-orm";
import { items } from "@shared/schema";
import { db, pool } from "../server/db";
import { learnAlias } from "../server/services/item-names";

/** Amino's wording → the niko item it means. Confirmed by the buyer, not guessed. */
const ALIASES: Array<[amino: string, nikoItem: string]> = [
  ["MixiBlend P", "Mixiblend Layer Premix 4Kg"],
  ["MCP (Mono-Calcium Phosphate)", "VENKYS MONOCALCIUM PHOSPHATE"],
  ["L-Lysine HCl", "L-LYSINE"],
  ["L-Threonine", "L-THREONINE 25KG"],
  ["Lime Stone Grit", "Lime Stone Grits"],
  ["Soda Bicarb", "SODIUM BICARBONATE 50KG"],
  ["Trace mineral", "TRACEMIN CLASSIC CL-30KG"],
  ["Layvit", "LAYVIT CLASSIC PREMIX 5KG"],
  ["Salt", "Salt Loose Bag"],
  // Same 50%-protein soya under both spellings; Hypro Soya is the survivor.
  ["Soyabean Doc Hi-Pro", "Hypro Soya"],
];

/**
 * The one material niko has never had. Groundnut de-oiled cake is bought and
 * mixed, but was only ever an item in Amino — Zoho's master has no groundnut
 * line at all, which is why it cannot be aliased to anything.
 */
const CREATE = {
  name: "Groundnut De-Oiled Cake (GNDOC)",
  alias: "DOGN",
};

async function main() {
  const write = process.argv.includes("--write");

  const all = await db.select({ id: items.id, name: items.name, aliases: items.aliases }).from(items);
  const byName = new Map(all.map((i) => [i.name.toLowerCase(), i]));

  const planned: string[] = [];
  const missing: string[] = [];
  for (const [amino, target] of ALIASES) {
    const item = byName.get(target.toLowerCase());
    if (!item) {
      missing.push(`${target}  (wanted for "${amino}")`);
      continue;
    }
    const known = (item.aliases ?? []).some((a) => a.toLowerCase() === amino.toLowerCase());
    planned.push(`  ${amino.padEnd(30)} -> ${target}${known ? "   (already known)" : ""}`);
  }

  console.log("Aliases:");
  planned.forEach((p) => console.log(p));
  if (missing.length) {
    console.log("\nNo such niko item — nothing was changed:");
    missing.forEach((m) => console.log(`  ${m}`));
    throw new Error("Refusing to run with an unresolved target; fix the mapping first.");
  }

  const exists = byName.has(CREATE.name.toLowerCase());
  console.log(`\nItem to create: ${CREATE.name}${exists ? "   (already exists)" : ""}`);

  if (!write) {
    console.log("\nDry run — nothing written. Re-run with --write.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    let created = 0;
    if (!exists) {
      // Deliberately minimal: a name and the feed classification. Accounts and
      // stock tracking are enable-raw-material-stock.ts's job, and guessing
      // them here is how an item ends up posting to the wrong place.
      const [row] = await tx
        .insert(items)
        .values({
          name: CREATE.name,
          category: "feed",
          isFeedIngredient: true,
          isSold: false,
        })
        .returning({ id: items.id });
      await learnAlias(tx, row!.id, CREATE.alias);
      created = 1;
    }

    let learned = 0;
    for (const [amino, target] of ALIASES) {
      const item = byName.get(target.toLowerCase())!;
      if (await learnAlias(tx, item.id, amino)) learned++;
      // The alias is what the importer matches on; the flag is what puts the
      // material on the nutritionist's screens.
      await tx
        .update(items)
        .set({ isFeedIngredient: true, category: "feed", updatedAt: new Date() })
        .where(eq(items.id, item.id));
    }
    console.log(`\nLearned ${learned} new alias(es); created ${created} item(s).`);
  });

  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  await pool.end();
  process.exit(1);
});
