/**
 * Nutrient profiles — what a material is made of.
 *
 * Read by the formulator and by nothing else that matters, which is why the
 * figures carry a source: a least-cost mix is only as good as the analysis behind
 * it, and a book value standing in for a lab result is worth being able to see
 * before ₹9 lakh of maize is bought on its word.
 *
 * Nutrients are rows, so this route never names one. Adding a nutrient to
 * `shared/feed.ts` makes it appear here with no change on either side.
 */
import { Router } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { itemNutrients, items, nutrientSource } from "@shared/schema";
import { NUTRIENT_KEYS } from "@shared/feed";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const feedNutrientsRouter = Router();

const decimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "Enter a number");

const bodySchema = z.object({
  values: z
    .array(
      z.object({
        nutrient: z.string().refine((k) => NUTRIENT_KEYS.includes(k), "Unknown nutrient"),
        /** Null clears the reading — an unmeasured nutrient is not a zero. */
        value: decimal.nullable(),
        source: z.enum(nutrientSource.enumValues).optional(),
        testedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        notes: z.string().max(500).nullish(),
      }),
    )
    .min(1)
    .max(NUTRIENT_KEYS.length),
});

/** The profile for one material, plus how complete it is. */
async function profile(itemId: string) {
  const [item] = await db
    .select({ id: items.id, name: items.name, unit: items.unit, costPrice: items.costPrice })
    .from(items)
    .where(eq(items.id, itemId));
  if (!item) return null;
  const rows = await db
    .select()
    .from(itemNutrients)
    .where(eq(itemNutrients.itemId, itemId))
    .orderBy(asc(itemNutrients.nutrient));
  return { item, values: rows };
}

/**
 * Every purchasable material with how many nutrients it has on file.
 *
 * The count is the useful column: a material with no analysis cannot enter a
 * least-cost mix, and the list is where that becomes obvious.
 */
feedNutrientsRouter.get("/", requirePermission("feed_mill", "view"), async (_req, res) => {
  // A JOIN with GROUP BY rather than correlated subqueries: drizzle renders
  // bare column names inside sql`` subqueries, so `where item_id = items.id`
  // binds to the subquery's own table and every count reads zero. The same
  // trap is documented on stockOnHand in services/inventory.ts.
  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      unit: items.unit,
      costPrice: items.costPrice,
      trackInventory: items.trackInventory,
      measured: sql<number>`count(${itemNutrients.id})::int`,
      me: sql<string | null>`max(${itemNutrients.value}::text) FILTER (WHERE ${itemNutrients.nutrient} = 'me')`,
      cp: sql<string | null>`max(${itemNutrients.value}::text) FILTER (WHERE ${itemNutrients.nutrient} = 'cp')`,
    })
    .from(items)
    .leftJoin(itemNutrients, eq(itemNutrients.itemId, items.id))
    // Only what the mill mixes. Cement has no crude protein, and ninety
    // unmeasured items would bury the dozen that matter.
    .where(and(eq(items.isActive, true), eq(items.isFeedIngredient, true)))
    .groupBy(items.id)
    .orderBy(sql`count(${itemNutrients.id}) = 0`, asc(items.name));
  res.json(rows);
});

/**
 * Purchasable items NOT yet marked as feed ingredients — the picker's list.
 */
feedNutrientsRouter.get(
  "/candidates",
  requirePermission("feed_mill", "view"),
  async (_req, res) => {
    const rows = await db
      .select({ id: items.id, name: items.name, unit: items.unit })
      .from(items)
      .where(
        and(eq(items.isActive, true), eq(items.isPurchased, true), eq(items.isFeedIngredient, false)),
      )
      .orderBy(asc(items.name));
    res.json(rows);
  },
);

/** Mark or unmark a material as something the mill mixes. */
feedNutrientsRouter.post(
  "/:itemId/mark",
  requirePermission("feed_mill", "nutrients"),
  validateBody(z.object({ isFeedIngredient: z.boolean() })),
  async (req, res) => {
    const [row] = await db
      .update(items)
      .set({ isFeedIngredient: req.body.isFeedIngredient, updatedAt: new Date() })
      .where(eq(items.id, req.params.itemId!))
      .returning({ id: items.id, name: items.name });
    if (!row) return res.status(404).json({ error: "Item not found" });
    res.json(row);
  },
);

feedNutrientsRouter.get("/:itemId", requirePermission("feed_mill", "view"), async (req, res) => {
  const out = await profile(req.params.itemId!);
  if (!out) return res.status(404).json({ error: "Item not found" });
  res.json(out);
});

/**
 * Write a profile.
 *
 * Upsert per nutrient rather than replace-all, so a lab result for moisture does
 * not blank the amino acid panel somebody typed from a datasheet last month. A
 * null value DELETES that reading, which is the only way to say "we do not know"
 * — storing zero would tell the solver this material contains none of it, and it
 * would then be free to use as much as it liked.
 */
feedNutrientsRouter.put(
  "/:itemId",
  requirePermission("feed_mill", "nutrients"),
  validateBody(bodySchema),
  async (req, res) => {
    const itemId = req.params.itemId!;
    const body = req.body as z.infer<typeof bodySchema>;

    const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId));
    if (!item) return res.status(404).json({ error: "Item not found" });

    const clearing = body.values.filter((v) => v.value == null).map((v) => v.nutrient);
    const setting = body.values.filter((v) => v.value != null);

    await db.transaction(async (tx) => {
      if (clearing.length) {
        await tx
          .delete(itemNutrients)
          .where(and(eq(itemNutrients.itemId, itemId), inArray(itemNutrients.nutrient, clearing)));
      }
      for (const v of setting) {
        await tx
          .insert(itemNutrients)
          .values({
            itemId,
            nutrient: v.nutrient,
            value: v.value!,
            source: v.source ?? "book",
            testedAt: v.testedAt ?? null,
            notes: v.notes ?? null,
            updatedBy: req.session.user!.id,
          })
          .onConflictDoUpdate({
            target: [itemNutrients.itemId, itemNutrients.nutrient],
            set: {
              value: v.value!,
              source: v.source ?? "book",
              testedAt: v.testedAt ?? null,
              notes: v.notes ?? null,
              updatedBy: req.session.user!.id,
              updatedAt: new Date(),
            },
          });
      }
    });

    res.json(await profile(itemId));
  },
);
