/**
 * Feed standards — the nutrient window a mix has to land in, per life stage.
 *
 * Versioned and superseded rather than edited, exactly like a QC spec and for
 * the same reason: a formula solved last March was solved against March's
 * standard, and rewriting the standard would make that formula look like it
 * never met it. One live standard per stage, enforced by a partial unique index.
 *
 * Writing gated on `feed_mill.manage_formulas` — the standard is half of every
 * recipe, and whoever may change what a mix must hit may change what goes in it.
 */
import { Router } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { feedStandardParams, feedStandards, lifeStage, users } from "@shared/schema";
import { LIFE_STAGES, NUTRIENT_KEYS } from "@shared/feed";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const feedStandardsRouter = Router();

const decimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "Enter a number");

const bodySchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).nullish(),
  params: z
    .array(
      z.object({
        nutrient: z.string().refine((k) => NUTRIENT_KEYS.includes(k), "Unknown nutrient"),
        minValue: decimal.nullish(),
        maxValue: decimal.nullish(),
      }),
    )
    .min(1)
    .max(NUTRIENT_KEYS.length),
});

/**
 * A window whose floor is above its ceiling admits nothing, and a row with
 * neither bound constrains nothing — both are mistakes worth refusing at save
 * rather than discovering as an infeasible solve with no explanation.
 */
function windowProblem(p: { nutrient: string; minValue?: string | null; maxValue?: string | null }): string | null {
  const lo = p.minValue == null || p.minValue === "" ? null : Number(p.minValue);
  const hi = p.maxValue == null || p.maxValue === "" ? null : Number(p.maxValue);
  if (lo == null && hi == null) return `${p.nutrient} has neither a minimum nor a maximum`;
  if (lo != null && hi != null && lo > hi) {
    return `${p.nutrient}: the minimum ${lo} is above the maximum ${hi} — no mix can land in that window`;
  }
  return null;
}

/** Every stage, its live standard, and the history behind it. */
feedStandardsRouter.get("/", requirePermission("feed_mill", "view"), async (_req, res) => {
  const versions = await db
    .select({
      id: feedStandards.id,
      stage: feedStandards.stage,
      version: feedStandards.version,
      effectiveFrom: feedStandards.effectiveFrom,
      isActive: feedStandards.isActive,
      notes: feedStandards.notes,
      createdByName: users.name,
    })
    .from(feedStandards)
    .leftJoin(users, eq(users.id, feedStandards.createdBy))
    .orderBy(asc(feedStandards.stage), desc(feedStandards.version));

  const params = versions.length
    ? await db
        .select()
        .from(feedStandardParams)
        .where(inArray(feedStandardParams.standardId, versions.map((v) => v.id)))
        .orderBy(asc(feedStandardParams.sortOrder))
    : [];

  res.json(
    LIFE_STAGES.map((stage) => {
      const history = versions.filter((v) => v.stage === stage);
      const active = history.find((v) => v.isActive) ?? null;
      return {
        stage,
        active: active && {
          ...active,
          params: params
            .filter((p) => p.standardId === active.id)
            .map((p) => ({ nutrient: p.nutrient, minValue: p.minValue, maxValue: p.maxValue })),
        },
        history: history.map((h) => ({
          version: h.version,
          effectiveFrom: h.effectiveFrom,
          isActive: h.isActive,
          createdByName: h.createdByName,
          paramCount: params.filter((p) => p.standardId === h.id).length,
        })),
      };
    }),
  );
});

/** Supersede: the next version rises, the live one stands down, one transaction. */
feedStandardsRouter.post(
  "/:stage",
  requirePermission("feed_mill", "manage_formulas"),
  validateBody(bodySchema),
  async (req, res) => {
    const stage = req.params.stage as (typeof lifeStage.enumValues)[number];
    if (!lifeStage.enumValues.includes(stage)) {
      return res.status(404).json({ error: "Unknown life stage" });
    }
    const body = req.body as z.infer<typeof bodySchema>;

    const seen = new Set<string>();
    for (const p of body.params) {
      if (seen.has(p.nutrient)) return res.status(422).json({ error: `${p.nutrient} appears twice` });
      seen.add(p.nutrient);
      const problem = windowProblem(p);
      if (problem) return res.status(422).json({ error: problem });
    }

    try {
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ next: sql<number>`coalesce(max(${feedStandards.version}), 0) + 1` })
          .from(feedStandards)
          .where(eq(feedStandards.stage, stage));
        await tx
          .update(feedStandards)
          .set({ isActive: false })
          .where(and(eq(feedStandards.stage, stage), eq(feedStandards.isActive, true)));
        const [std] = await tx
          .insert(feedStandards)
          .values({
            stage,
            version: row!.next,
            effectiveFrom: body.effectiveFrom,
            notes: body.notes ?? null,
            createdBy: req.session.user!.id,
          })
          .returning();
        await tx.insert(feedStandardParams).values(
          body.params.map((p, i) => ({
            standardId: std!.id,
            nutrient: p.nutrient,
            minValue: p.minValue ?? null,
            maxValue: p.maxValue ?? null,
            sortOrder: i,
          })),
        );
        return std!;
      });
      res.status(201).json({ savedVersion: created.version });
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

/** Retire without a successor — the stage stops being judged. */
feedStandardsRouter.delete(
  "/:stage",
  requirePermission("feed_mill", "manage_formulas"),
  async (req, res) => {
    const [row] = await db
      .update(feedStandards)
      .set({ isActive: false })
      .where(
        and(
          eq(feedStandards.stage, req.params.stage as (typeof lifeStage.enumValues)[number]),
          eq(feedStandards.isActive, true),
        ),
      )
      .returning({ id: feedStandards.id });
    if (!row) return res.status(404).json({ error: "No live standard for that stage" });
    res.json({ ok: true });
  },
);
