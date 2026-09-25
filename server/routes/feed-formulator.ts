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
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { feedStandardParams, feedStandards, formulas, itemNutrients, items, lifeStage } from "@shared/schema";
import { db } from "../db";
import { holds, requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { getPreferences } from "../services/preferences";
import { materialPrices } from "../services/feed-prices";
import { istDate } from "../services/day-resolution";
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
      .select({ id: feedStandards.id, version: feedStandards.version, referenceIntakeG: feedStandards.referenceIntakeG })
      .from(feedStandards)
      .where(and(eq(feedStandards.stage, stage), eq(feedStandards.isActive, true)));
    if (!standard) return res.json({ stage, version: null, referenceIntakeG: null, params: [] });

    const params = await db
      .select()
      .from(feedStandardParams)
      .where(eq(feedStandardParams.standardId, standard.id))
      .orderBy(asc(feedStandardParams.sortOrder));

    res.json({
      stage,
      version: standard.version,
      referenceIntakeG: standard.referenceIntakeG == null ? null : Number(standard.referenceIntakeG),
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
 * for each material its name, nutrient profile and price — from its last
 * purchase, the same rule as the formula comparison, so a mix costs the same on
 * both screens.
 *
 * `include` names materials to load even when they are not marked feed
 * ingredients — the analysis of a recipe that holds a pigment, and a solve with
 * that pigment locked in.
 */
async function loadInputs(stage: (typeof lifeStage.enumValues)[number], itemIds: string[] | undefined, include: string[] = []) {
  const [standard] = await db
    .select({ id: feedStandards.id, version: feedStandards.version, referenceIntakeG: feedStandards.referenceIntakeG })
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
    .select({ id: items.id, name: items.name, costPrice: items.costPrice, isFeedIngredient: items.isFeedIngredient, fixedDose: items.fixedDose })
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

  // Priced by the rule every feed screen uses (services/feed-prices.ts): the
  // last load's delivered cost, then its bill rate, then the typed price, per
  // kilo for a material bought by the pack. No honest figure is unpriced,
  // never zero — a ₹0 material would flood every mix.
  const priceMap = await materialPrices(db, materialRows.map((m) => m.id));
  const priceOf = (m: (typeof materialRows)[number]): number | null => {
    const p = priceMap.get(m.id);
    return p && p.ratePerKg > 0 ? p.ratePerKg : null;
  };
  const nutrientsOf = (id: string) =>
    Object.fromEntries(nutrientRows.filter((n) => n.itemId === id).map((n) => [n.nutrient, Number(n.value)]));

  const bounds = params.map((p) => ({
    nutrient: p.nutrient,
    minValue: p.minValue == null ? null : Number(p.minValue),
    maxValue: p.maxValue == null ? null : Number(p.maxValue),
  }));
  const prefs = await getPreferences(db);
  return { standard, bounds, materialRows, priceOf, priceMap, nutrientsOf, prefs };
}

const easeSchema = z
  .record(z.string().max(40), z.object({ min: z.number().nullable().optional(), max: z.number().nullable().optional() }))
  .optional();

const solveBody = solveSchema.extend({
  ease: easeSchema,
  /** g/bird/day the sheds on this feed actually eat; scales the standard from its reference intake. */
  intakeG: z.number().min(20).max(300).optional(),
});

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
    /**
     * A layer standard is a daily need written as a concentration at one
     * intake. Sheds eating less need it denser, more need it thinner: every
     * figure — energy included, which Hy-Line prints per bird per day — is
     * scaled by reference intake over actual. The guide's own table by intake
     * follows this to its rounding. Easing, if any, applies after.
     */
    const ref = standard.referenceIntakeG == null ? null : Number(standard.referenceIntakeG);
    const factor = ref != null && body.intakeG ? ref / body.intakeG : 1;
    const sc = (v: number | null) => (v == null ? null : Math.round(v * factor * 1000) / 1000);
    const scaled = factor === 1 ? bounds : bounds.map((b) => ({ nutrient: b.nutrient, minValue: sc(b.minValue), maxValue: sc(b.maxValue) }));

    const eased: Array<{ nutrient: string; from: { min: number | null; max: number | null }; to: { min: number | null; max: number | null } }> = [];
    const heldTo = scaled.map((b) => {
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

    /**
     * When a solve fails, the first thing to rule out is a material that
     * would have met the shortfall but sat out for want of a price. Easing a
     * bound to what the rest can reach is the wrong fix for that — Layer 1
     * "reaching" 0.36% calcium with the limestone unpriced — so each clashing
     * nutrient names the unpriced materials richer in it than the standard asks.
     */
    const dropped = materialRows.filter((m) => priceOf(m) == null && !locked.includes(m.id));
    const clashKeys = new Set(
      (result.feasible ? [] : result.blockers ?? []).flatMap((b) => (b.kind === "inclusion" ? [] : [b.key, ...(b.with ?? []).map((w) => w.key)])),
    );
    const leftOutRich = [...clashKeys]
      .map((k) => {
        const floor = heldTo.find((b) => b.nutrient === k)?.minValue;
        return {
          nutrient: k,
          materials: dropped
            .filter((m) => floor != null && (nutrientsOf(m.id)[k] ?? 0) > floor)
            .map((m) => ({ name: m.name, value: nutrientsOf(m.id)[k]! })),
        };
      })
      .filter((x) => x.materials.length > 0);

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
      leftOutRich,
      intake: ref != null && body.intakeG ? { referenceIntakeG: ref, intakeG: body.intakeG, factor: Math.round(factor * 10000) / 10000 } : null,
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
    const { standard, bounds, materialRows, priceOf, priceMap, nutrientsOf, prefs } = await loadInputs(body.stage, body.itemIds, body.itemIds);
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
          ...(costs ? { priceBasis: priceMap.get(m.id)?.basis ?? "never bought", pricedOn: priceMap.get(m.id)?.pricedOn ?? null } : {}),
          measured: Object.keys(n).length,
          contributes: bound.some((k) => (n[k] ?? 0) !== 0),
          fixedDose: m.fixedDose,
        };
      }),
    });
  },
);

/**
 * What the birds on a formula actually eat.
 *
 * Which sheds eat it comes from the feed transfers: every shed that received
 * the formula's feed in the seven days up to its latest transfer. Each shed's
 * intake is its feed over its average birds across its own last seven days
 * on file; the formula's is the same across all of them together, so a big
 * shed counts for more than a small one. The layer standards are written for
 * one intake (Hy-Line's typical), and the solve scales them to this.
 */
feedFormulatorRouter.get("/intake", requirePermission("feed_mill", "view"), async (req, res) => {
  const name = typeof req.query.formula === "string" ? req.query.formula : "";
  if (!name) return res.status(400).json({ error: "Name a formula" });
  const [f] = await db
    .select({ itemId: formulas.outputItemId })
    .from(formulas)
    .where(and(eq(formulas.name, name), eq(formulas.isActive, true)))
    .limit(1);
  if (!f) return res.json({ formula: name, houses: [], intakeG: null, transfers: null });

  const sheds = (
    await db.execute(sql`
      WITH last AS (
        SELECT max(transfer_date) AS d FROM feed_transfers
         WHERE item_id = ${f.itemId} AND status::text <> 'void' AND to_house_id IS NOT NULL
      )
      SELECT t.to_house_id AS "houseId", h.code AS "code", sum(t.quantity_kg)::float8 AS "kg",
             min(t.transfer_date)::text AS "from", max(t.transfer_date)::text AS "to"
        FROM feed_transfers t
        JOIN last ON true
        JOIN houses h ON h.id = t.to_house_id
       WHERE t.item_id = ${f.itemId} AND t.status::text <> 'void'
         AND t.transfer_date > last.d - 7 AND t.transfer_date <= last.d
       GROUP BY 1, 2
       ORDER BY 2
    `)
  ).rows as Array<{ houseId: string; code: string; kg: number; from: string; to: string }>;
  if (!sheds.length) return res.json({ formula: name, houses: [], intakeG: null, transfers: null });

  const today = istDate();
  const days = (
    await db.execute(sql`
      SELECT house_id AS "houseId", day::text AS "day", sum(feed_kg)::float8 AS "feedKg",
             sum((opening_birds + closing_birds) / 2.0)::float8 AS "birds"
        FROM flock_day
       WHERE house_id IN (${sql.join(sheds.map((s) => sql`${s.houseId}::uuid`), sql`, `)})
         AND feed_kg IS NOT NULL AND feed_kg > 0 AND day <= ${today}
       GROUP BY 1, 2
       ORDER BY 1, 2 DESC
    `)
  ).rows as Array<{ houseId: string; day: string; feedKg: number; birds: number }>;

  let feed = 0;
  let birdDays = 0;
  const houses = sheds.map((s) => {
    const own = days.filter((d) => d.houseId === s.houseId).slice(0, 7);
    const kgFed = own.reduce((a, d) => a + d.feedKg, 0);
    const birds = own.reduce((a, d) => a + d.birds, 0);
    feed += kgFed;
    birdDays += birds;
    return {
      houseId: s.houseId,
      code: s.code,
      receivedKg: Math.round(s.kg),
      days: own.length,
      from: own.at(-1)?.day ?? null,
      to: own[0]?.day ?? null,
      birds: own.length ? Math.round(birds / own.length) : null,
      intakeG: birds > 0 ? Math.round((kgFed * 1000 * 10) / birds) / 10 : null,
    };
  });
  res.json({
    formula: name,
    transfers: {
      from: sheds.reduce((m, s) => (s.from < m ? s.from : m), sheds[0]!.from),
      to: sheds.reduce((m, s) => (s.to > m ? s.to : m), sheds[0]!.to),
    },
    houses,
    intakeG: birdDays > 0 ? Math.round((feed * 1000 * 10) / birdDays) / 10 : null,
  });
});
