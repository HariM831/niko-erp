/**
 * Checks the three duties of item-names: learn, guard, merge.
 *
 * The point of the mechanism is that nobody runs a script when a vendor spells
 * a material their own way: the gate LEARNS the wording as an alias, the
 * create-guard REFUSES a duplicate under any known name, and a MERGE folds an
 * escaped duplicate into its survivor without touching a posted document.
 *
 * Rolled back; nothing survives.
 *
 * Run: npx tsx scripts/check-item-names.ts
 */
import { eq, sql } from "drizzle-orm";
import { formulaLines, formulas, itemNutrients, items } from "@shared/schema";
import { db } from "../server/db";
import { findNameHolder, learnAlias, mergeItems, normName } from "../server/services/item-names";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
};

class Rollback extends Error {}

console.log("\n  ONE DEFINITION OF SAME\n");
check("case, spaces and punctuation do not make a new name", normName("GN De-Oiled-Cake 50%") === normName("gn deoiled cake 50"));

try {
  await db.transaction(async (tx) => {
    // Any expense account satisfies the purchase-account requirement.
    const acctRows = await tx.execute(sql`SELECT id FROM accounts WHERE type = 'expense' LIMIT 1`);
    const acct = acctRows.rows[0] as { id: string };

    const [dogn] = await tx
      .insert(items)
      .values({ name: "TEST DOGN", unit: "kg", isSold: false, purchaseAccountId: acct!.id, isFeedIngredient: true, category: "feed" })
      .returning();

    console.log("\n  THE GATE LEARNS\n");

    check("a new bill wording is learned as an alias", await learnAlias(tx, dogn!.id, "GN De-Oiled-Cake 50%"));
    check("learning it twice is a silent no-op", !(await learnAlias(tx, dogn!.id, "gn de-oiled cake 50%")), "same name, different spelling");
    check("the item's own name is never an alias", !(await learnAlias(tx, dogn!.id, "test dogn")));
    check("an empty wording learns nothing", !(await learnAlias(tx, dogn!.id, "   ")));

    console.log("\n  THE GUARD REFUSES\n");

    const byName = await findNameHolder(tx, "test dogn");
    check("a duplicate NAME is found, however spelled", byName?.id === dogn!.id, byName?.name ?? "—");
    const byAlias = await findNameHolder(tx, "GN DE-OILED CAKE 50");
    check("a duplicate via ALIAS is found and says so", byAlias?.id === dogn!.id && byAlias.viaAlias === true);
    check("an unknown name is free", (await findNameHolder(tx, "Sunflower DOC")) === null);

    // The tier that would have caught the real twins: a name INSIDE another.
    const contained = await findNameHolder(tx, "TEST DOGN EXTRA FINE");
    check(
      "a near-name is flagged as contains, not exact",
      contained?.id === dogn!.id && contained.match === "contains",
      "refusable, but a person may confirm it is different",
    );
    const exact = await findNameHolder(tx, "test-dogn");
    check("an exact hit still says exact", exact?.match === "exact");

    console.log("\n  THE MERGE FOLDS\n");

    const [twin] = await tx
      .insert(items)
      .values({ name: "TEST DOGN CAKE", unit: "kg", isSold: false, purchaseAccountId: acct!.id, isFeedIngredient: true, category: "feed" })
      .returning();
    await learnAlias(tx, twin!.id, "GN DOC");
    await tx.insert(itemNutrients).values([
      { itemId: twin!.id, nutrient: "cp", value: "45", source: "book" },
    ]);
    // The twin sits on a recipe of its own — the merge must carry the line.
    const [f] = await tx
      .insert(formulas)
      .values({ name: "TEST MIX", version: 1, outputItemId: dogn!.id, batchSizeKg: "100", effectiveFrom: "2026-01-01", isActive: false })
      .returning();
    await tx.insert(formulaLines).values({ formulaId: f!.id, itemId: twin!.id, quantityKg: "100" });

    const summary = await mergeItems(tx, twin!.id, dogn!.id);
    check("the recipe line moved to the survivor", summary.formulaLinesMoved === 1);
    check("missing analysis copied, existing untouched", summary.nutrientsCopied === 1);
    check("every name the twin answered to carried over", summary.aliasesCarried === 2, "its name and its alias");

    const [after] = await tx.select().from(items).where(eq(items.id, twin!.id));
    check("the twin is retired, not deleted", after!.isActive === false && after!.name === "TEST DOGN CAKE");
    const holder = await findNameHolder(tx, "TEST DOGN CAKE", twin!.id);
    check("the twin's name now resolves to the survivor", holder?.id === dogn!.id, "future bills land there");

    console.log("\n  THE MERGE KNOWS WHEN NOT TO\n");

    const refuse = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    check("an item cannot merge into itself", (await refuse(() => mergeItems(tx, dogn!.id, dogn!.id))) != null);

    const [out] = await tx
      .insert(items)
      .values({ name: "TEST OUTPUT", unit: "kg", isSold: false, trackInventory: false })
      .returning();
    await tx.update(formulas).set({ outputItemId: out!.id, isActive: true }).where(eq(formulas.id, f!.id));
    const msg = await refuse(() => mergeItems(tx, out!.id, dogn!.id));
    check("a formula's output cannot be merged away", msg?.includes("produces") === true, msg ?? "");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const strays = await db.select({ id: items.id }).from(items).where(eq(items.name, "TEST DOGN"));
check("nothing survives the run", strays.length === 0);

console.log(failed === 0 ? "\n  All item-name checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(0 + (failed ? 1 : 0));
