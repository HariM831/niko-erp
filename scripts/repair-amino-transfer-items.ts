/**
 * Put the Amino feed transfers on the feed they carried.
 *
 * import-from-amino.ts looked for feed items in the "poultry_feed" category.
 * The mill's feeds had been filed under "feed" (raw material) instead, so it
 * found none and fell back to whatever item the table returned first —
 * "Eggs (farm)". Every imported
 * transfer (AMN-FT-…) was written against it: 599 lorries of Layer 1, Grower
 * and the rest, recorded as eggs. The owner-billing feed invoice groups by that
 * item and the Houses board names the formula from it, so both would say eggs.
 *
 * The import did keep what Amino called the feed, in the note: "Amino Layer 1".
 * That name is a formula's name, and a formula says which item it makes
 * (formulas.output_item_id), so the right item is looked up, not guessed from
 * spelling. A note naming no formula, or a formula whose versions disagree on
 * the item, is reported and left alone.
 *
 * Only imported transfers still on the wrong item and not yet posted to the
 * ledger are touched: a posted transfer is a document, and correcting it is a
 * reversal, not an update.
 *
 *   npx tsx scripts/repair-amino-transfer-items.ts           # report only
 *   npx tsx scripts/repair-amino-transfer-items.ts --apply   # and repair
 */
import { and, eq, inArray, isNull, like, notInArray } from "drizzle-orm";
import { feedTransfers, formulas, items } from "@shared/schema";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");

/**
 * Amino's formula names that niko files under another. Amino called the
 * developer recipe "Chick"; chick feed proper is bought in and no formula makes
 * it (confirmed 26 Sep 2026), so an "Amino Chick" lorry carried developer feed.
 */
const RENAMED: Record<string, string> = { chick: "developer" };

async function main() {
  // Formula name -> the one item its versions make.
  const made = await db
    .select({ name: formulas.name, itemId: formulas.outputItemId, itemName: items.name })
    .from(formulas)
    .innerJoin(items, eq(items.id, formulas.outputItemId));
  const byFormula = new Map<string, Set<string>>();
  const itemNames = new Map<string, string>();
  for (const f of made) {
    const key = f.name.trim().toLowerCase();
    byFormula.set(key, (byFormula.get(key) ?? new Set()).add(f.itemId));
    itemNames.set(f.itemId, f.itemName);
  }
  const outputs = [...itemNames.keys()];

  // Wrong is "on an item no formula makes" — not "outside the feed category".
  // That includes Chick Feed: it is bought in, so no mill lorry carries it.
  const wrong = await db
    .select({
      id: feedTransfers.id,
      number: feedTransfers.number,
      notes: feedTransfers.notes,
      itemName: items.name,
      posted: feedTransfers.journalEntryId,
    })
    .from(feedTransfers)
    .innerJoin(items, eq(items.id, feedTransfers.itemId))
    .where(
      and(
        like(feedTransfers.number, "AMN-FT-%"),
        outputs.length ? notInArray(feedTransfers.itemId, outputs) : undefined,
      ),
    );
  const onItems = new Map<string, number>();
  for (const t of wrong) onItems.set(t.itemName, (onItems.get(t.itemName) ?? 0) + 1);
  console.log(`${wrong.length} imported transfer(s) on an item no formula makes`);
  for (const [name, n] of onItems) console.log(`  on ${name}: ${n}`);
  if (!wrong.length) return;

  const plan = new Map<string, { itemName: string; ids: string[] }>();
  const problems: string[] = [];
  let posted = 0;
  for (const t of wrong) {
    if (t.posted) {
      posted++;
      continue;
    }
    const formula = /^Amino\s+(.+)$/.exec(t.notes?.trim() ?? "")?.[1]?.trim();
    const key = formula?.toLowerCase();
    const targets = key ? byFormula.get(RENAMED[key] ?? key) : undefined;
    if (!formula || !targets) {
      problems.push(`${t.number}: note "${t.notes ?? ""}" names no formula`);
      continue;
    }
    if (targets.size !== 1) {
      problems.push(`${t.number}: formula "${formula}" makes ${targets.size} different items`);
      continue;
    }
    const itemId = [...targets][0]!;
    const entry = plan.get(itemId) ?? { itemName: itemNames.get(itemId)!, ids: [] };
    entry.ids.push(t.id);
    plan.set(itemId, entry);
  }

  for (const [, p] of plan) console.log(`  → ${p.itemName}: ${p.ids.length}`);
  if (posted) console.log(`  ${posted} posted to the ledger — left alone, a reversal is needed`);
  for (const p of problems.slice(0, 20)) console.log(`  ! ${p}`);
  if (problems.length > 20) console.log(`  ! …and ${problems.length - 20} more`);

  if (!APPLY) {
    console.log("\nReport only. Run with --apply to repair.");
    return;
  }
  await db.transaction(async (tx) => {
    for (const [itemId, p] of plan) {
      await tx
        .update(feedTransfers)
        .set({ itemId })
        .where(and(inArray(feedTransfers.id, p.ids), isNull(feedTransfers.journalEntryId)));
    }
  });
  const moved = [...plan.values()].reduce((n, p) => n + p.ids.length, 0);
  console.log(`\nRepaired ${moved} transfer(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
