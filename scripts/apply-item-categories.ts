/**
 * Restore the item categories somebody worked out by hand.
 *
 * Categorising ninety-odd items is judgement, not computation — cement is
 * construction, a diluent is vaccines, DORB is feed — and it was done once,
 * on the instance that ran before this one. A Zoho import brings names,
 * prices and accounts but has no opinion about what kind of thing an item is,
 * so every fresh load starts with the category unset and that work would be
 * done again from memory.
 *
 * fixtures/item-categories.tsv is that judgement, recovered from a backup of
 * the earlier database. Applying it is a lookup, not a re-derivation.
 *
 * Matching is on a normalised name, so case and punctuation differences do
 * not matter — "20Ml -Diluent Pigon" and "20ML -DILUENT PIGON" are the same
 * item to this script, which is exactly the sort of pair that made them
 * duplicates in the first place.
 *
 * An item that already carries a category is never overwritten: somebody
 * looking at the live system and deciding is worth more than a file. Where
 * the two disagree it says so and changes nothing.
 *
 *   npx tsx scripts/apply-item-categories.ts               # report
 *   npx tsx scripts/apply-item-categories.ts --write       # apply
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { items, type itemCategory } from "@shared/schema";
import { db, pool } from "../server/db";

type Category = (typeof itemCategory.enumValues)[number];

const FILE = "fixtures/item-categories.tsv";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function main() {
  const write = process.argv.includes("--write");

  const valid = new Set<string>(
    // Read from the enum rather than repeated here, so a category retired in
    // the schema stops being applied instead of failing at the insert.
    (await db.execute(`SELECT unnest(enum_range(NULL::item_category))::text AS v`)).rows.map(
      (r) => (r as { v: string }).v,
    ),
  );

  const rows = readFileSync(FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t") as [string, string]);

  const live = await db
    .select({ id: items.id, name: items.name, category: items.category })
    .from(items)
    .where(eq(items.isActive, true));
  const byNorm = new Map(live.map((i) => [norm(i.name), i]));

  const toSet: Array<{ id: string; name: string; category: Category }> = [];
  const disagree: string[] = [];
  const absent: string[] = [];
  const unknownCategory: string[] = [];
  let agreed = 0;

  for (const [name, category] of rows) {
    if (!valid.has(category)) {
      unknownCategory.push(`${name} → ${category}`);
      continue;
    }
    const item = byNorm.get(norm(name));
    if (!item) {
      absent.push(`${name} (${category})`);
      continue;
    }
    if (item.category === category) agreed++;
    else if (item.category) disagree.push(`${item.name}: live=${item.category} file=${category}`);
    else toSet.push({ id: item.id, name: item.name, category: category as Category });
  }

  const byCategory = new Map<string, number>();
  for (const t of toSet) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1);

  console.log(`${rows.length} categorised items in ${FILE}`);
  console.log(`  already agree        ${agreed}`);
  console.log(`  would set            ${toSet.length}`);
  console.log(`  disagree (untouched) ${disagree.length}`);
  console.log(`  no such item here    ${absent.length}`);
  if (unknownCategory.length) console.log(`  unknown category     ${unknownCategory.length}`);

  if (toSet.length) {
    console.log("\n  by category:");
    [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`    ${k.padEnd(16)} ${v}`));
  }
  if (disagree.length) {
    console.log("\n  disagreements — left as they are:");
    disagree.forEach((d) => console.log(`    ${d}`));
  }

  if (!write) {
    console.log("\nReport only — nothing written. Re-run with --write.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const t of toSet) {
      await tx
        .update(items)
        .set({ category: t.category, updatedAt: new Date() })
        .where(eq(items.id, t.id));
    }
  });
  console.log(`\nCategorised ${toSet.length} item(s).`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  await pool.end();
  process.exit(1);
});
