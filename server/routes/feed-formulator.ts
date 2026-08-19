/**
 * The formulator endpoint — gathers what the solver needs and runs it.
 *
 * Everything comes from data already on file: nutrient profiles per material,
 * the live feed standard for the chosen stage, weighted-average cost from the
 * stock ledger with the item's cost price as fallback, and the milling
 * constants from preferences. The screen sends only the stage, which materials
 * to consider, and any inclusion limits — no figures travel from the client, so
 * a stale browser cannot solve against last week's prices.
 */
import { Router } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { feedStandardParams, feedStandards, itemNutrients, items, lifeStage } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { getPreferences } from "../services/preferences";
import { stockOnHand } from "../services/inventory";
import { solveLeastCost } from "../services/formulator";

export const feedFormulatorRouter = Router();

const pct = z.number().min(0).max(100);

const solveSchema = z.object({
  stage: z.enum(lifeStage.enumValues),
  /** Materials to consider. Empty means every feed ingredient with a price. */
  itemIds: z.array(z.string().uuid()).max(60).optional(),
  limits: z
    .record(z.string().uuid(), z.object({ min: pct.optional(), max: pct.optional() }))
    .optional(),
});

/**
 * What a life stage asks for, before anything is solved.
 *
 * The screen fills its requirements panel the moment a stage is picked, so a
 * person can see what they are aiming at — and, just as usefully, see that a
 * stage has no standard at all rather than discovering it when Solve refuses.
 */
feedFormulatorRouter.get(
  "/standard/:stage",
  requirePermission("feed_mill", "view"),
  async (req, res) => {
    const stage = req.params.stage as (typeof lifeStage.enumValues)[number];
    if (!lifeStage.enumValues.includes(stage)) {
      return res.status(404).json({ error: "No such life stage" });
    }
    const [standard] = await db
      .select({ id: feedStandards.id, version: feedStandards.version })
      .from(feedStandards)
      .where(and(eq(feedStandards.stage, stage), eq(feedStandards.isActive, true)));
    if (!standard) return res.json({ stage, version: null, params: [] });

    const params = await db
      .select()
      .from(feedStandardParams)
      .where(eq(feedStandardParams.standardId, standard.id))
      .orderBy(asc(feedStandardParams.sortOrder));

    res.json({
      stage,
      version: standard.version,
      params: params.map((p) => ({
        nutrient: p.nutrient,
        minValue: p.minValue == null ? null : Number(p.minValue),
        maxValue: p.maxValue == null ? null : Number(p.maxValue),
      })),
    });
  },
);

feedFormulatorRouter.post(
  "/solve",
  requirePermission("feed_mill", "formulate"),
  validateBody(solveSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof solveSchema>;

    const [standard] = await db
      .select({ id: feedStandards.id, version: feedStandards.version })
      .from(feedStandards)
      .where(and(eq(feedStandards.stage, body.stage), eq(feedStandards.isActive, true)));
    if (!standard) {
      return res.status(422).json({
        error: `No live feed standard for that stage — set one under Settings › Feed Mill first`,
      });
    }
    const params = await db
      .select()
      .from(feedStandardParams)
      .where(eq(feedStandardParams.standardId, standard.id))
      .orderBy(asc(feedStandardParams.sortOrder));

    const materialRows = await db
      .select({ id: items.id, name: items.name, costPrice: items.costPrice, tracked: items.trackInventory })
      .from(items)
      .where(
        body.itemIds?.length
          ? and(eq(items.isFeedIngredient, true), inArray(items.id, body.itemIds))
          : and(eq(items.isActive, true), eq(items.isFeedIngredient, true)),
      );

    const nutrientRows = materialRows.length
      ? await db
          .select()
          .from(itemNutrients)
          .where(inArray(itemNutrients.itemId, materialRows.map((m) => m.id)))
      : [];

    /**
     * Price each material the way production will cost it: weighted average
     * from the stock ledger where it holds a balance, the item's cost price
     * where it does not. A solve priced one way and a batch costed another
     * would promise a ₹/kg the ledger then refuses to deliver.
     */
    const levels = await stockOnHand(db);
    const byItem = new Map(levels.map((l) => [l.itemId, l]));
    const priceOf = (m: (typeof materialRows)[number]): number | null => {
      const held = byItem.get(m.id);
      if (held && Number(held.quantity) > 0 && Number(held.value) > 0) {
        return Number(held.value) / Number(held.quantity);
      }
      // Zero is unpriced, not free: a ₹0 material would flood every mix, so
      // the solver sits it out — and saying so beats dropping it silently.
      const cost = m.costPrice == null ? null : Number(m.costPrice);
      return cost != null && cost > 0 ? cost : null;
    };

    const prefs = await getPreferences(db);
    const result = solveLeastCost({
      ingredients: materialRows.map((m) => ({
        id: m.id,
        name: m.name,
        costPerKg: priceOf(m),
        nutrients: Object.fromEntries(
          nutrientRows.filter((n) => n.itemId === m.id).map((n) => [n.nutrient, Number(n.value)]),
        ),
        minPercent: body.limits?.[m.id]?.min ?? null,
        maxPercent: body.limits?.[m.id]?.max ?? null,
      })),
      standard: params.map((p) => ({
        nutrient: p.nutrient,
        minValue: p.minValue == null ? null : Number(p.minValue),
        maxValue: p.maxValue == null ? null : Number(p.maxValue),
      })),
      moistureRetention: Number(prefs.millMoistureRetention),
      overheadPerKg: Number(prefs.millOverheadPerKg),
    });

    res.json({
      ...result,
      standardVersion: standard.version,
      /**
       * The bounds the solve was held to, returned with it.
       *
       * The screen shows asked-against-got side by side, and reading the
       * "asked" from anywhere other than the solve that produced the "got"
       * is how the two quietly stop describing the same thing.
       */
      standard: params.map((p) => ({
        nutrient: p.nutrient,
        minValue: p.minValue == null ? null : Number(p.minValue),
        maxValue: p.maxValue == null ? null : Number(p.maxValue),
      })),
      prices: Object.fromEntries(materialRows.map((m) => [m.id, priceOf(m)])),
      unpriced: materialRows.filter((m) => priceOf(m) == null).map((m) => m.name),
    });
  },
);
