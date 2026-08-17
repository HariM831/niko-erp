/**
 * Formulas — the recipes the mill produces to.
 *
 * A formula names its OUTPUT ITEM, and that is the decision the whole module
 * stands on: finished feed is inventory-tracked like anything else, so
 * production is a stock movement and finished stock in kilos falls out of
 * `stockOnHand` with no machinery of its own. Amino's formulas were not items,
 * and nobody could ask how many kilos of Layer Mash were in the mill.
 *
 * Ingredient lines are real rows with a foreign key to `items` — not jsonb — so
 * "which formulas use maize" is a join, and a material cannot be renamed or
 * retired underneath a recipe without the database noticing.
 *
 * Versioned and superseded like a spec: a production order records the exact
 * formula version it was made to, and that version is never rewritten.
 */
import { Router } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { formulaLines, formulas, items, lifeStage, productionOrders, users } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const feedFormulasRouter = Router();

const qtyStr = z.string().regex(/^\d+(\.\d{1,3})?$/, "Enter a quantity");
const pctStr = z.string().regex(/^\d+(\.\d{1,3})?$/, "Enter a percentage");

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  outputItemId: z.string().uuid(),
  stage: z.enum(lifeStage.enumValues).nullish(),
  batchSizeKg: qtyStr,
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).nullish(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantityKg: qtyStr,
        minPercent: pctStr.nullish(),
        maxPercent: pctStr.nullish(),
      }),
    )
    .min(1)
    .max(60),
});

type Body = z.infer<typeof bodySchema>;

/**
 * The checks that make a formula producible rather than merely stored.
 *
 * The line total must equal the batch size — the recipe IS the batch, and a
 * mismatch means someone edited one side and not the other. Within ±0.5 kg,
 * because premix quantities carry three decimals and exact equality on decimal
 * strings is a trap.
 */
async function formulaProblem(body: Body): Promise<string | null> {
  const seen = new Set<string>();
  for (const l of body.lines) {
    if (seen.has(l.itemId)) return "An ingredient appears twice";
    seen.add(l.itemId);
    const lo = l.minPercent == null ? null : Number(l.minPercent);
    const hi = l.maxPercent == null ? null : Number(l.maxPercent);
    if (lo != null && hi != null && lo > hi) return "An inclusion minimum is above its maximum";
  }

  const lineTotal = body.lines.reduce((s, l) => s + Number(l.quantityKg), 0);
  if (Math.abs(lineTotal - Number(body.batchSizeKg)) > 0.5) {
    return `The lines add to ${lineTotal.toFixed(3)} kg but the batch size says ${Number(body.batchSizeKg)} kg — a batch is its recipe, so the two must agree`;
  }

  const rows = await db
    .select({ id: items.id, name: items.name, isFeedIngredient: items.isFeedIngredient, trackInventory: items.trackInventory })
    .from(items)
    .where(inArray(items.id, [...body.lines.map((l) => l.itemId), body.outputItemId]));
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const l of body.lines) {
    const item = byId.get(l.itemId);
    if (!item) return "An ingredient no longer exists";
    if (!item.isFeedIngredient) {
      return `${item.name} is not marked as a feed ingredient — mark it on the Nutrient Profiles screen first`;
    }
  }

  const output = byId.get(body.outputItemId);
  if (!output) return "The output item no longer exists";
  if (!output.trackInventory) {
    return `${output.name} does not track inventory — production could not receive it into stock. Enable tracking on the item first`;
  }
  if (output.isFeedIngredient) {
    return `${output.name} is marked as a feed ingredient — a formula cannot output one of its own raw materials`;
  }
  return null;
}

/** Every formula: live version, lines, and how much has been produced to it. */
feedFormulasRouter.get("/", requirePermission("feed_mill", "view"), async (_req, res) => {
  const versions = await db
    .select({
      id: formulas.id,
      name: formulas.name,
      version: formulas.version,
      outputItemId: formulas.outputItemId,
      outputItemName: items.name,
      stage: formulas.stage,
      batchSizeKg: formulas.batchSizeKg,
      effectiveFrom: formulas.effectiveFrom,
      isActive: formulas.isActive,
      notes: formulas.notes,
      createdByName: users.name,
      /** Orders made to this exact version. What retiring it walks away from. */
      producedOrders: sql<number>`(
        SELECT count(*)::int FROM production_orders o
        WHERE o.formula_id = ${formulas.id} AND o.status = 'completed'
      )`,
    })
    .from(formulas)
    .leftJoin(items, eq(items.id, formulas.outputItemId))
    .leftJoin(users, eq(users.id, formulas.createdBy))
    .orderBy(asc(formulas.name), desc(formulas.version));

  const lines = versions.length
    ? await db
        .select({
          formulaId: formulaLines.formulaId,
          itemId: formulaLines.itemId,
          itemName: items.name,
          quantityKg: formulaLines.quantityKg,
          minPercent: formulaLines.minPercent,
          maxPercent: formulaLines.maxPercent,
          sortOrder: formulaLines.sortOrder,
        })
        .from(formulaLines)
        .innerJoin(items, eq(items.id, formulaLines.itemId))
        .where(inArray(formulaLines.formulaId, versions.map((v) => v.id)))
        .orderBy(asc(formulaLines.sortOrder))
    : [];

  const names = [...new Set(versions.map((v) => v.name))];
  res.json(
    names.map((name) => {
      const history = versions.filter((v) => v.name === name);
      const active = history.find((v) => v.isActive) ?? null;
      return {
        name,
        active: active && { ...active, lines: lines.filter((l) => l.formulaId === active.id) },
        history: history.map((h) => ({
          id: h.id,
          version: h.version,
          effectiveFrom: h.effectiveFrom,
          isActive: h.isActive,
          createdByName: h.createdByName,
          producedOrders: h.producedOrders,
          lineCount: lines.filter((l) => l.formulaId === h.id).length,
        })),
      };
    }),
  );
});

/**
 * Save a formula — always as the next version of its name. A new name starts at
 * v1; an existing one supersedes its live version in the same transaction.
 */
feedFormulasRouter.post(
  "/",
  requirePermission("feed_mill", "manage_formulas"),
  validateBody(bodySchema),
  async (req, res) => {
    const body = req.body as Body;
    const problem = await formulaProblem(body);
    if (problem) return res.status(422).json({ error: problem });

    try {
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ next: sql<number>`coalesce(max(${formulas.version}), 0) + 1` })
          .from(formulas)
          .where(eq(formulas.name, body.name));
        await tx
          .update(formulas)
          .set({ isActive: false })
          .where(and(eq(formulas.name, body.name), eq(formulas.isActive, true)));
        const [f] = await tx
          .insert(formulas)
          .values({
            name: body.name,
            version: row!.next,
            outputItemId: body.outputItemId,
            stage: body.stage ?? null,
            batchSizeKg: body.batchSizeKg,
            effectiveFrom: body.effectiveFrom,
            notes: body.notes ?? null,
            createdBy: req.session.user!.id,
          })
          .returning();
        await tx.insert(formulaLines).values(
          body.lines.map((l, i) => ({
            formulaId: f!.id,
            itemId: l.itemId,
            quantityKg: l.quantityKg,
            minPercent: l.minPercent ?? null,
            maxPercent: l.maxPercent ?? null,
            sortOrder: i,
          })),
        );
        return f!;
      });
      res.status(201).json({ id: created.id, savedVersion: created.version });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        return res
          .status(409)
          .json({ error: "Someone else saved a version just now. Reload and try again." });
      }
      throw e;
    }
  },
);

/** Retire a formula without a successor. Past orders keep their version. */
feedFormulasRouter.delete(
  "/:id",
  requirePermission("feed_mill", "manage_formulas"),
  async (req, res) => {
    // Refuse while an order is open against it: the floor is mid-mix.
    const [open] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(productionOrders)
      .where(and(eq(productionOrders.formulaId, req.params.id!), eq(productionOrders.status, "pending")));
    if ((open?.n ?? 0) > 0) {
      return res.status(422).json({
        error: `${open!.n} production order(s) are open against this formula — complete or void them first`,
      });
    }
    const [row] = await db
      .update(formulas)
      .set({ isActive: false })
      .where(and(eq(formulas.id, req.params.id!), eq(formulas.isActive, true)))
      .returning({ id: formulas.id });
    if (!row) return res.status(404).json({ error: "No live formula with that id" });
    res.json({ ok: true });
  },
);

/** Items a formula may output: tracked, not themselves ingredients. */
feedFormulasRouter.get("/output-items", requirePermission("feed_mill", "view"), async (_req, res) => {
  const rows = await db
    .select({ id: items.id, name: items.name, unit: items.unit, trackInventory: items.trackInventory })
    .from(items)
    .where(and(eq(items.isActive, true), eq(items.isFeedIngredient, false)))
    .orderBy(desc(items.trackInventory), asc(items.name));
  res.json(rows);
});
