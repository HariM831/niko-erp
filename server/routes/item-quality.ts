/**
 * Quality specs, kept with the item they judge.
 *
 * A spec is master data about a material — the same kind of fact as its unit or
 * its purchase account — so it lives in Items rather than in Settings, and is
 * gated by the Items permissions. What it is NOT is a setting you edit: saving
 * supersedes, creating a new version and retiring the old one, because a receipt
 * judged last March has to stay readable under March's limits. Nothing here
 * updates a spec in place.
 *
 * Deduction rules are shown alongside but not edited here. They answer a
 * different question — reject is a quality call, deduct is a commercial one —
 * and they are not scoped to a single item, so an item screen is the wrong place
 * to change one. They appear read-only so nobody has to guess what a band costs.
 */
import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { QC_PARAMETER_KEYS } from "@shared/feed";
import {
  contacts,
  deductionRules,
  items,
  procurementReceiptLines,
  qcSpecParams,
  qcSpecs,
  specDirection,
  users,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { describeRule } from "../services/qc";

/**
 * Mounted at /api/quality-specs rather than under /api/items/:id, so no path
 * here can ever be shadowed by the item router's own `/:id`.
 */
export const qualitySpecsRouter = Router();

/** A reading, not money — four decimals, and negatives are allowed. */
const decimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "Enter a number");
const optDecimal = decimal.nullish();

const paramSchema = z.object({
  /**
   * Machine name, from the closed QC vocabulary. Matched against a lab reading
   * and against a deduction rule's parameter — which only works if both sides
   * spell it the same way, so it is chosen, never typed.
   */
  parameter: z.enum(QC_PARAMETER_KEYS as [string, ...string[]], {
    errorMap: () => ({ message: "Choose a quality parameter from the list" }),
  }),
  label: z.string().max(60).nullish(),
  /** "%", "ppb", "mg/kg" — how the reading is expressed, printed on the PO. */
  unit: z.string().max(12).nullish(),
  direction: z.enum(specDirection.enumValues),
  target: optDecimal,
  warnAt: optDecimal,
  rejectAt: optDecimal,
});

const specSchema = z.object({
  sampleCount: z.number().int().min(1).max(50),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).nullish(),
  params: z.array(paramSchema).min(1).max(20),
});

const n = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));

/**
 * The bands have to run in one direction, and which direction depends on the
 * parameter. Moisture climbs — target 12, warn 14, reject 16. Protein falls —
 * target 9, warn 8, reject 7. A spec whose bands cross is not stricter or looser,
 * it is unjudgeable: `judgeLine` would reject a reading it had already passed.
 */
export function bandProblem(p: z.infer<typeof paramSchema>): string | null {
  const name = p.label || p.parameter;
  const seq = [n(p.target), n(p.warnAt), n(p.rejectAt)].filter((v): v is number => v != null);
  if (n(p.warnAt) == null && n(p.rejectAt) == null) {
    return `${name} has neither a warning nor a reject limit, so it would never judge anything`;
  }
  for (let i = 1; i < seq.length; i++) {
    const ok = p.direction === "max" ? seq[i]! >= seq[i - 1]! : seq[i]! <= seq[i - 1]!;
    if (!ok) {
      return p.direction === "max"
        ? `${name} fails above its limit, so target ≤ warn ≤ reject`
        : `${name} fails below its limit, so target ≥ warn ≥ reject`;
    }
  }
  return null;
}

/** Everything the Quality Specs screen shows for one material. */
async function specPayload(itemId: string) {
  const [item] = await db
    .select({ id: items.id, name: items.name, unit: items.unit, isActive: items.isActive })
    .from(items)
    .where(eq(items.id, itemId));
  if (!item) return null;

  const versions = await db
    .select({
      id: qcSpecs.id,
      version: qcSpecs.version,
      sampleCount: qcSpecs.sampleCount,
      effectiveFrom: qcSpecs.effectiveFrom,
      isActive: qcSpecs.isActive,
      notes: qcSpecs.notes,
      createdAt: qcSpecs.createdAt,
      createdByName: users.name,
    })
    .from(qcSpecs)
    .leftJoin(users, eq(users.id, qcSpecs.createdBy))
    .where(eq(qcSpecs.itemId, itemId))
    .orderBy(desc(qcSpecs.version));

  const specIds = versions.map((v) => v.id);
  const [allParams, judged, rules] = await Promise.all([
    specIds.length
      ? db.select().from(qcSpecParams).where(inArray(qcSpecParams.specId, specIds)).orderBy(asc(qcSpecParams.sortOrder))
      : [],
    // How much history a version carries. Retiring one that judged nothing is
    // free; retiring one that judged forty loads is a decision.
    specIds.length
      ? db
          .select({ specId: procurementReceiptLines.qcSpecId, lines: sql<number>`count(*)::int` })
          .from(procurementReceiptLines)
          .where(inArray(procurementReceiptLines.qcSpecId, specIds))
          .groupBy(procurementReceiptLines.qcSpecId)
      : [],
    db
      .select({ ...getTableColumns(deductionRules), vendorName: contacts.displayName })
      .from(deductionRules)
      .leftJoin(contacts, eq(contacts.id, deductionRules.vendorId))
      .where(
        and(
          eq(deductionRules.isActive, true),
          or(eq(deductionRules.itemId, itemId), isNull(deductionRules.itemId)),
        ),
      ),
  ]);

  const judgedBySpec = new Map(judged.map((j) => [j.specId, j.lines]));
  const paramsOf = (specId: string) =>
    allParams
      .filter((p) => p.specId === specId)
      .map((p) => ({
        parameter: p.parameter,
        label: p.label,
        unit: p.unit,
        direction: p.direction,
        target: p.target,
        warnAt: p.warnAt,
        rejectAt: p.rejectAt,
      }));

  const active = versions.find((v) => v.isActive) ?? null;
  return {
    item,
    spec: active,
    params: active ? paramsOf(active.id) : [],
    history: versions.map((v) => ({
      ...v,
      linesJudged: judgedBySpec.get(v.id) ?? 0,
      // Both limits, because a version that moved only its warning band would
      // otherwise be indistinguishable from the one it replaced.
      summary: paramsOf(v.id)
        .map((p) => {
          const lim = (x: string | null) => (x == null ? "—" : `${Number(x)}${p.unit ?? ""}`);
          return `${p.label || p.parameter} ${lim(p.warnAt)}/${lim(p.rejectAt)}`;
        })
        .join(" · "),
    })),
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      parameter: r.parameter,
      scope: r.scope,
      threshold: r.threshold,
      /** Null means every material — the rule is inherited, not set here. */
      itemId: r.itemId,
      vendorName: r.vendorName,
      describes: describeRule(r as Parameters<typeof describeRule>[0]),
    })),
  };
}

qualitySpecsRouter.get("/:id", requirePermission("items", "view"), async (req, res) => {
  const payload = await specPayload(req.params.id!);
  if (!payload) return res.status(404).json({ error: "Item not found" });
  res.json(payload);
});

/**
 * Supersede. Always a new version, never an edit — see the file header.
 */
qualitySpecsRouter.post(
  "/:id",
  requirePermission("items", "edit"),
  validateBody(specSchema),
  async (req, res) => {
    const itemId = req.params.id!;
    const body = req.body as z.infer<typeof specSchema>;

    const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
    if (!item) return res.status(404).json({ error: "Item not found" });
    // A quality spec judges a raw material at the bench. Nothing else arrives
    // by the tonne with a moisture reading, so nothing else gets one.
    if (item.category !== "feed") {
      return res
        .status(422)
        .json({ error: `${item.name} is not a feed material — quality specs are for feed items` });
    }

    const seen = new Set<string>();
    for (const p of body.params) {
      if (seen.has(p.parameter)) {
        return res.status(422).json({ error: `${p.parameter} appears twice` });
      }
      seen.add(p.parameter);
      const problem = bandProblem(p);
      if (problem) return res.status(422).json({ error: problem });
    }

    try {
      const spec = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ next: sql<number>`coalesce(max(${qcSpecs.version}), 0) + 1` })
          .from(qcSpecs)
          .where(eq(qcSpecs.itemId, itemId));

        // The partial unique index allows one live spec per item, so the old one
        // has to stand down inside the same transaction that raises its successor.
        await tx
          .update(qcSpecs)
          .set({ isActive: false })
          .where(and(eq(qcSpecs.itemId, itemId), eq(qcSpecs.isActive, true)));

        const [created] = await tx
          .insert(qcSpecs)
          .values({
            itemId,
            version: row!.next,
            sampleCount: body.sampleCount,
            effectiveFrom: body.effectiveFrom,
            notes: body.notes ?? null,
            createdBy: req.session.user!.id,
          })
          .returning();

        await tx.insert(qcSpecParams).values(
          body.params.map((p, i) => ({
            specId: created!.id,
            parameter: p.parameter,
            label: p.label || null,
            unit: p.unit || null,
            direction: p.direction,
            target: p.target ?? null,
            warnAt: p.warnAt ?? null,
            rejectAt: p.rejectAt ?? null,
            sortOrder: i,
          })),
        );
        return created!;
      });

      const payload = await specPayload(itemId);
      res.status(201).json({ ...payload, savedVersion: spec.version });
    } catch (e) {
      // Two people saving at once both computed the same next version; the
      // index caught the loser. Nothing is broken — one of them has to reload.
      if ((e as { code?: string }).code === "23505") {
        return res
          .status(409)
          .json({ error: "Someone else saved a version just now. Reload and try again." });
      }
      throw e;
    }
  },
);

/**
 * Retire the live spec without raising a successor — the material stops being
 * judged. Past verdicts keep pointing at the version that made them, so this
 * removes nothing; QC simply reports `no_spec` from here on.
 */
qualitySpecsRouter.delete("/:id", requirePermission("items", "edit"), async (req, res) => {
  const [row] = await db
    .update(qcSpecs)
    .set({ isActive: false })
    .where(and(eq(qcSpecs.itemId, req.params.id!), eq(qcSpecs.isActive, true)))
    .returning({ id: qcSpecs.id });
  if (!row) return res.status(404).json({ error: "This item has no active spec" });
  res.json(await specPayload(req.params.id!));
});

/** The Quality Specs list — every purchasable FEED material, with or without a spec. */
qualitySpecsRouter.get("/", requirePermission("items", "view"), async (_req, res) => {
  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      unit: items.unit,
      specId: qcSpecs.id,
      version: qcSpecs.version,
      effectiveFrom: qcSpecs.effectiveFrom,
      paramCount: sql<number>`(select count(*)::int from qc_spec_params p where p.spec_id = ${qcSpecs.id})`,
    })
    .from(items)
    .leftJoin(qcSpecs, and(eq(qcSpecs.itemId, items.id), eq(qcSpecs.isActive, true)))
    // Feed only: a vaccine or a length of pipe is not sampled on a weighbridge.
    .where(and(eq(items.isActive, true), eq(items.isPurchased, true), eq(items.category, "feed")))
    // Specced materials first. The org buys ninety-odd things and inspects a
    // handful of them; the handful is what this screen is for.
    .orderBy(sql`${qcSpecs.id} is null`, asc(items.name));
  res.json(rows);
});
