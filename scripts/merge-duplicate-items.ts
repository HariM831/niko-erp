/**
 * Fold four duplicate items into their survivors.
 *
 * All four came in with the Zoho item master and are duplicated there too:
 * two are the same words typed differently, two are the same product under a
 * different name — which is why a normalised comparison finds the first pair
 * and only the buyer finds the second.
 *
 * mergeItems does the careful part: it refuses a source that still holds
 * stock, that a formula produces, or that shares a formula with the target;
 * it carries every name the source answered to onto the survivor; and it
 * leaves posted documents pointing where they point. Nothing is deleted — the
 * source is retired, so an old bill still reads the way it was entered.
 *
 * Dry by default, and honestly dry: the merges really run, inside a
 * transaction that is then rolled back, so the report is what would happen
 * rather than what somebody predicted would happen.
 */
import { eq } from "drizzle-orm";
import { items } from "@shared/schema";
import { db, pool } from "../server/db";
import { mergeItems } from "../server/services/item-names";

/** [retired, survivor] — survivor is the richer or more-used record. */
const PAIRS: Array<[source: string, target: string, why: string]> = [
  ["20ML -DILUENT PIGON", "20Ml -Diluent Pigon", "same words, different case"],
  [
    "Layer Birds (Layer Commercial Bovans)",
    "Layer Birds (Layer Commercial Bovans).",
    "trailing full stop; the survivor carries 12 invoices to the other's 1",
  ],
  ["DORB", "De-Oiled Rice Bran (DORB - 16)", "abbreviation of the same bran"],
  ["Soyabean Doc Hi-Pro", "Hypro Soya", "one 50%-protein soya under two names"],
];

/** The survivor above keeps a stray full stop; drop it once the merge is done. */
const RENAME: Array<[from: string, to: string]> = [
  ["Layer Birds (Layer Commercial Bovans).", "Layer Birds (Layer Commercial Bovans)"],
];

class RollBack extends Error {}

async function main() {
  const write = process.argv.includes("--write");

  await db
    .transaction(async (tx) => {
      const all = await tx.select({ id: items.id, name: items.name }).from(items);
      // Keyed on the exact name, deliberately. One of these pairs differs only
      // by case, so a lower-cased key collapses the two into one entry and the
      // merge is asked to fold an item into itself.
      const byName = new Map(all.map((i) => [i.name, i]));

      for (const [sourceName, targetName, why] of PAIRS) {
        const source = byName.get(sourceName);
        const target = byName.get(targetName);
        if (!source || !target) {
          console.log(`  SKIP  ${sourceName} → ${targetName}  (${!source ? "source" : "target"} not found — already merged?)`);
          continue;
        }
        const r = await mergeItems(tx, source.id, target.id);
        console.log(
          `  ${sourceName}\n    → ${targetName}  (${why})\n` +
            `      formula lines moved ${r.formulaLinesMoved}, nutrients copied ${r.nutrientsCopied}, names carried ${r.aliasesCarried}`,
        );
      }

      for (const [from, to] of RENAME) {
        const item = byName.get(from);
        if (!item) continue;
        await tx.update(items).set({ name: to, updatedAt: new Date() }).where(eq(items.id, item.id));
        console.log(`  renamed "${from}" → "${to}"`);
      }

      if (!write) throw new RollBack();
    })
    .catch((e) => {
      if (!(e instanceof RollBack)) throw e;
      console.log("\nDry run — rolled back, nothing written. Re-run with --write.");
    });

  if (write) console.log("\nMerged.");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  await pool.end();
  process.exit(1);
});
