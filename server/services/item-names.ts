/**
 * The item master's answer to a world that never spells a material the same
 * way twice.
 *
 * Three duties, one normaliser:
 *
 *   LEARN — when a receipt line resolves a bill's wording to an item and that
 *   wording is new, it becomes an alias then and there. The next truck from
 *   the same vendor matches at the gate with nobody retyping anything.
 *
 *   GUARD — an item may not be created under a name that already belongs to
 *   another item's name or aliases. This is the check that would have kept
 *   "De-Oiled Rice Bran (DORB - 16)" and "DORB" from becoming two items.
 *
 *   MERGE — when a duplicate slipped through anyway, fold it into the
 *   survivor: recipes repointed, missing analysis copied, every name kept as
 *   an alias, the duplicate retired. Posted documents are never touched —
 *   history stays where it was posted, and only the future consolidates.
 */
import { and, eq, sql } from "drizzle-orm";
import { formulaLines, formulas, itemNutrients, items } from "@shared/schema";
import type { Db, Tx } from "../db";
import { PostingError } from "./posting";

/** The same normalisation resolveItem matches with — one definition of "same name". */
export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const MAX_ALIASES = 12;

/**
 * Record a bill's wording as an alias of the item it resolved to.
 *
 * Silent no-op when the wording already matches the item, is empty or too
 * long, or the alias list is full — a learning step must never be the reason
 * a truck cannot come in. Returns true when something was actually learned.
 */
export async function learnAlias(tx: Tx, itemId: string, wording: string): Promise<boolean> {
  const clean = wording.trim();
  if (!clean || clean.length > 80) return false;
  const [item] = await tx
    .select({ name: items.name, aliases: items.aliases })
    .from(items)
    .where(eq(items.id, itemId));
  if (!item) return false;

  const target = normName(clean);
  if (!target || normName(item.name) === target) return false;
  const known = (item.aliases ?? []).map(normName);
  if (known.includes(target)) return false;
  if ((item.aliases ?? []).length >= MAX_ALIASES) return false;

  await tx
    .update(items)
    .set({ aliases: sql`array_append(coalesce(${items.aliases}, '{}'), ${clean})`, updatedAt: new Date() })
    .where(eq(items.id, itemId));
  return true;
}

/**
 * The item, if any, that already owns this name.
 *
 * Two tiers, because "same" has two strengths. EXACT — the name equals an
 * existing name or alias once case, spaces and punctuation are stripped — is
 * a duplicate, full stop. CONTAINS — one name sits inside the other, the way
 * "De-oiled rice bran" sits inside "De-Oiled Rice Bran (DORB - 16)" — is how
 * the master actually grew twins, but it can also be legitimate ("Maize
 * Gluten" is not "Maize"), so a containment hit refuses unless the person
 * confirms it really is a different material.
 */
export async function findNameHolder(
  tx: Db | Tx,
  name: string,
  excludeItemId?: string,
): Promise<{ id: string; name: string; viaAlias: boolean; match: "exact" | "contains" } | null> {
  const target = normName(name);
  if (!target) return null;
  const all = await tx
    .select({ id: items.id, name: items.name, aliases: items.aliases })
    .from(items);
  for (const it of all) {
    if (it.id === excludeItemId) continue;
    if (normName(it.name) === target) return { id: it.id, name: it.name, viaAlias: false, match: "exact" };
  }
  for (const it of all) {
    if (it.id === excludeItemId) continue;
    if ((it.aliases ?? []).some((a) => normName(a) === target)) {
      return { id: it.id, name: it.name, viaAlias: true, match: "exact" };
    }
  }
  // Longest holder first, so the closest existing name is the one named back.
  const sorted = [...all].sort((a, b) => normName(b.name).length - normName(a.name).length);
  for (const it of sorted) {
    if (it.id === excludeItemId) continue;
    const candidates = [it.name, ...(it.aliases ?? [])].map(normName);
    if (
      target.length >= 4 &&
      candidates.some((c) => c.length >= 4 && (c.includes(target) || target.includes(c)))
    ) {
      return { id: it.id, name: it.name, viaAlias: false, match: "contains" };
    }
  }
  return null;
}

export interface MergeSummary {
  formulaLinesMoved: number;
  nutrientsCopied: number;
  aliasesCarried: number;
}

/**
 * Fold `sourceId` into `targetId` and retire the source.
 *
 * Refused, by name, when the merge would need a human decision first:
 * a formula that uses BOTH items (whose kilos win?), a source that is some
 * formula's output (the recipe must be re-pointed deliberately), or a source
 * still holding stock (adjust it off first — value cannot silently jump items).
 */
export async function mergeItems(tx: Tx, sourceId: string, targetId: string): Promise<MergeSummary> {
  if (sourceId === targetId) throw new PostingError("An item cannot be merged into itself");
  const [source] = await tx.select().from(items).where(eq(items.id, sourceId));
  const [target] = await tx.select().from(items).where(eq(items.id, targetId));
  if (!source || !target) throw new PostingError("Item not found");
  if (!target.isActive) throw new PostingError(`${target.name} is inactive — merge into a live item`);

  const [asOutput] = await tx
    .select({ name: formulas.name })
    .from(formulas)
    .where(and(eq(formulas.outputItemId, sourceId), eq(formulas.isActive, true)))
    .limit(1);
  if (asOutput) {
    throw new PostingError(
      `${source.name} is what formula "${asOutput.name}" produces — re-point the formula first`,
    );
  }

  const stock = await tx.execute(sql`
    SELECT coalesce(sum(quantity), 0)::numeric(14,3) AS qty
    FROM inventory_transactions WHERE item_id = ${sourceId}::uuid`);
  const held = Number((stock.rows[0] as { qty: string }).qty) + Number(source.openingStock ?? 0);
  if (Math.abs(held) > 0.0005) {
    throw new PostingError(
      `${source.name} still holds ${held.toLocaleString("en-IN")} in stock — adjust it off before merging`,
    );
  }

  // A formula using both items is a recipe decision, not a data operation.
  const both = await tx.execute(sql`
    SELECT f.name FROM formula_lines a
    JOIN formula_lines b ON b.formula_id = a.formula_id AND b.item_id = ${targetId}::uuid
    JOIN formulas f ON f.id = a.formula_id
    WHERE a.item_id = ${sourceId}::uuid
    LIMIT 1`);
  if (both.rows.length) {
    throw new PostingError(
      `Formula "${(both.rows[0] as { name: string }).name}" uses both items — combine its lines first`,
    );
  }

  const moved = await tx
    .update(formulaLines)
    .set({ itemId: targetId })
    .where(eq(formulaLines.itemId, sourceId))
    .returning({ id: formulaLines.id });

  // The target's own analysis wins; the source only fills gaps.
  const sourceNutrients = await tx
    .select()
    .from(itemNutrients)
    .where(eq(itemNutrients.itemId, sourceId));
  let nutrientsCopied = 0;
  for (const n of sourceNutrients) {
    const r = await tx
      .insert(itemNutrients)
      .values({ itemId: targetId, nutrient: n.nutrient, value: n.value, source: n.source, testedAt: n.testedAt })
      .onConflictDoNothing()
      .returning({ id: itemNutrients.id });
    nutrientsCopied += r.length;
  }

  // Every name the source answered to now answers for the target.
  const carry = [source.name, ...(source.aliases ?? [])];
  const known = new Set([normName(target.name), ...(target.aliases ?? []).map(normName)]);
  let aliasesCarried = 0;
  for (const a of carry) {
    if (known.has(normName(a))) continue;
    await tx
      .update(items)
      .set({ aliases: sql`array_append(coalesce(${items.aliases}, '{}'), ${a})` })
      .where(eq(items.id, targetId));
    known.add(normName(a));
    aliasesCarried++;
  }

  await tx
    .update(items)
    .set({ isActive: false, isFeedIngredient: false, updatedAt: new Date() })
    .where(eq(items.id, sourceId));

  return { formulaLinesMoved: moved.length, nutrientsCopied, aliasesCarried };
}
