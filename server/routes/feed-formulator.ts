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
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { feedStandardParams, feedStandards, itemNutrients, items, lifeStage } from "@shared/schema";
import { db } from "../db";
import { holds, requirePermission } from "../lib/rbac";
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

const fixedAt = (l: { min?: number; max?: number } | undefined) =>
  l != null && l.min != null && l.max != null && l.min === l.max;

/**
 * What both the solve and the analysis read: the live standard for a stage, and
 * for each material its name, nutrient profile and price — priced the way
 * production will cost it: weighted average from the stock ledger where it holds
 * a balance, the item's cost price where it does not. A solve priced one way and
 * a batch costed another would promise a ₹/kg the ledger then refuses to deliver.
 *
 * `include` names materials to load even when they are not marked feed
 * ingredients — the analysis of a recipe that holds a pigment, and a solve with
 * that pigment locked in.
 */
async function loadInputs(stage: (typeof lifeStage.enumValues)[number], itemIds: string[] | undefined, include: string[] = []) {
  const [standard] = await db
    .select({ id: feedStandards.id, version: feedStandards.version })
    .from(feedStandards)
    .where(and(eq(feedStandards.stage, stage), eq(feedStandards.isActive, true)));
  const params = standard
    ? await db
        .select()
        .from(feedStandardParams)
        .where(eq(feedStandardParams.standardId, standard.id))
        .orderBy(asc(feedStandardParams.sortOrder))
    : [];

  const materialRows = await db
    .select({ id: items.id, name: items.name, costPrice: items.costPrice, isFeedIngredient: items.isFeedIngredient })
    .from(items)
    .where(
      itemIds?.length
        ? and(
            inArray(items.id, itemIds),
            include.length ? or(eq(items.isFeedIngredient, true), inArray(items.id, include)) : eq(items.isFeedIngredient, true),
          )
        : and(eq(items.isActive, true), eq(items.isFeedIngredient, true)),
    );

  const nutrientRows = materialRows.length
    ? await db
        .select()
        .from(itemNutrients)
        .where(inArray(itemNutrients.itemId, materialRows.map((m) => m.id)))
    : [];

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
  const nutrientsOf = (id: string) =>
    Object.fromEntries(nutrientRows.filter((n) => n.itemId === id).map((n) => [n.nutrient, Number(n.value)]));

  const bounds = params.map((p) => ({
    nutrient: p.nutrient,
    minValue: p.minValue == null ? null : Number(p.minValue),
    maxValue: p.maxValue == null ? null : Number(p.maxValue),
  }));
  const prefs = await getPreferences(db);
  return { standard, bounds, materialRows, priceOf, nutrientsOf, prefs };
}

const easeSchema = z
  .record(z.string().max(40), z.object({ min: z.number().nullable().optional(), max: z.number().nullable().optional() }))
  .optional();

const solveBody = solveSchema.extend({ ease: easeSchema });

feedFormulatorRouter.post(
  "/solve",
  requirePermission("feed_mill", "formulate"),
  validateBody(solveBody),
  async (req, res) => {
    const body = req.body as z.infer<typeof solveBody>;
    // A lock is a decision to include the material at that amount, so it is
    // solved even when it has no price or is not marked a feed ingredient.
    const locked = Object.entries(body.limits ?? {}).filter(([, l]) => fixedAt(l)).map(([id]) => id);
    const { standard, bounds, materialRows, priceOf, nutrientsOf, prefs } = await loadInputs(body.stage, body.itemIds, locked);
    if (!standard) {
      return res.status(422).json({
        error: `No live feed standard for that stage — set one under Settings › Feed Mill first`,
      });
    }

    /**
     * Easing is for this solve only — "what would the mix be if energy were
     * 2,697" — and never touches the standard. The bounds the solve was held
     * to go back with it, with what moved listed, so the screen and the save
     * dialog can both say the mix does not meet the standard as written.
     */
    const eased: Array<{ nutrient: string; from: { min: number | null; max: number | null }; to: { min: number | null; max: number | null } }> = [];
    const heldTo = bounds.map((b) => {
      const e = body.ease?.[b.nutrient];
      if (!e) return b;
      const to = {
        minValue: e.min !== undefined ? e.min : b.minValue,
        maxValue: e.max !== undefined ? e.max : b.maxValue,
      };
      if (to.minValue !== b.minValue || to.maxValue !== b.maxValue) {
        eased.push({ nutrient: b.nutrient, from: { min: b.minValue, max: b.maxValue }, to: { min: to.minValue, max: to.maxValue } });
      }
      return { nutrient: b.nutrient, ...to };
    });

    const result = solveLeastCost({
      ingredients: materialRows.map((m) => ({
        id: m.id,
        name: m.name,
        costPerKg: priceOf(m),
        nutrients: nutrientsOf(m.id),
        minPercent: body.limits?.[m.id]?.min ?? null,
        maxPercent: body.limits?.[m.id]?.max ?? null,
      })),
      standard: heldTo,
      moistureRetention: Number(prefs.millMoistureRetention),
      overheadPerKg: Number(prefs.millOverheadPerKg),
    });

    // The solve runs on prices either way — it is a least-cost mix — but what
    // things cost is shown only to those who hold feed_mill.costs.
    const costs = holds(req.session.user?.permissions, "feed_mill", "costs");
    const { rawCostPerKg, costPerKg, shadowPrices, ...mix } = result;
    res.json({
      ...mix,
      ...(costs ? { rawCostPerKg, costPerKg, shadowPrices } : {}),
      costs,
      standardVersion: standard.version,
      /**
       * The bounds the solve was held to, returned with it.
       *
       * The screen shows asked-against-got side by side, and reading the
       * "asked" from anywhere other than the solve that produced the "got"
       * is how the two quietly stop describing the same thing.
       */
      standard: heldTo,
      eased,
      ...(costs ? { prices: Object.fromEntries(materialRows.map((m) => [m.id, priceOf(m)])) } : {}),
      unpriced: materialRows.filter((m) => priceOf(m) == null).map((m) => m.name),
    });
  },
);

const analyseBody = z.object({
  stage: z.enum(lifeStage.enumValues),
  itemIds: z.array(z.string().uuid()).max(60),
  /** Percent of the mix per material; anything left out counts as 0. */
  mix: z.record(z.string().uuid(), pct).default({}),
});

/**
 * A given mix, read against a stage's standard — the live recipe before any
 * solve, and a solved mix as somebody edits it. Same prices and nutrient
 * profiles as the solve, so a figure on the screen never disagrees with one the
 * solver would produce. Also says, for every material in the pool, what would
 * change a solve before it runs: no price, no analysis, not a feed ingredient,
 * or contributing nothing the standard asks for (the additives a least-cost
 * solve would otherwise drop).
 */
feedFormulatorRouter.post(
  "/analyse",
  requirePermission("feed_mill", "view"),
  validateBody(analyseBody),
  async (req, res) => {
    const body = req.body as z.infer<typeof analyseBody>;
    const { standard, bounds, materialRows, priceOf, nutrientsOf, prefs } = await loadInputs(body.stage, body.itemIds, body.itemIds);
    const bound = bounds.filter((b) => b.minValue != null || b.maxValue != null).map((b) => b.nutrient);

    const nutritionAnalysis: Record<string, number> = {};
    for (const b of bounds) {
      let total = 0;
      for (const m of materialRows) total += ((body.mix[m.id] ?? 0) * (nutrientsOf(m.id)[b.nutrient] ?? 0)) / 100;
      nutritionAnalysis[b.nutrient] = Math.round(total * 1000) / 1000;
    }
    const raw = materialRows.reduce((a, m) => a + ((body.mix[m.id] ?? 0) / 100) * (priceOf(m) ?? 0), 0);
    const costs = holds(req.session.user?.permissions, "feed_mill", "costs");
    res.json({
      standardVersion: standard?.version ?? null,
      nutritionAnalysis,
      costs,
      ...(costs
        ? {
            rawCostPerKg: Math.round(raw * 10000) / 10000,
            costPerKg: Math.round((raw / Number(prefs.millMoistureRetention) + Number(prefs.millOverheadPerKg)) * 10000) / 10000,
            prices: Object.fromEntries(materialRows.map((m) => [m.id, priceOf(m)])),
          }
        : {}),
      materials: materialRows.map((m) => {
        const n = nutrientsOf(m.id);
        return {
          id: m.id,
          name: m.name,
          feedIngredient: m.isFeedIngredient,
          priced: priceOf(m) != null,
          measured: Object.keys(n).length,
          contributes: bound.some((k) => (n[k] ?? 0) !== 0),
        };
      }),
    });
  },
);
