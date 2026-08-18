/**
 * Deduction rules — when money comes off a vendor's bill, and how much.
 *
 * Kept apart from quality specs on purpose. A spec answers "do we take it";
 * a rule answers "what do we pay for it", and the two rarely share a number —
 * maize is refused above 16% moisture but charged for above 14%.
 *
 * Superseding rather than editing, like a spec: a rule change is policy, and
 * the policy that was live last March is part of explaining last March's
 * payments. A version is never rewritten.
 *
 * Gated on `procurement.manage_rules`, which is deliberately not `settle`.
 * Settling applies the rules to one truck; this writes the rules that apply to
 * every truck.
 */
import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  contacts,
  deductionBasis,
  deductionRules,
  deductionScope,
  items,
  specDirection,
  users,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { computeDeductions, describeRule } from "../services/qc";

export const deductionRulesRouter = Router();

const decimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "Enter a number");
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "Enter an amount");

const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  parameter: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,29}$/, "Use lowercase letters, digits and underscores"),
  direction: z.enum(specDirection.enumValues),
  scope: z.enum(deductionScope.enumValues),
  basis: z.enum(deductionBasis.enumValues),
  itemId: z.string().uuid().nullish(),
  vendorId: z.string().uuid().nullish(),
  threshold: decimal.nullish(),
  ratePerPoint: decimal.nullish(),
  flatAmount: money.nullish(),
  minAmount: money.nullish(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type RuleBody = z.infer<typeof ruleSchema>;

/**
 * A basis ignores the fields it does not read, so a missing one is silent — a
 * per_point_per_kg rule with no rate deducts zero from every load for ever and
 * looks perfectly configured while doing it.
 */
function missingField(body: RuleBody): string | null {
  if (body.basis === "per_point_per_kg" && body.ratePerPoint == null) {
    return "A per-point rule needs a rate per point";
  }
  if (body.basis === "flat" && body.flatAmount == null) {
    return "A flat rule needs an amount";
  }
  if (body.basis === "shortfall_value" && body.scope !== "vehicle" && body.parameter === "shortage") {
    return "A shortage allowance belongs to the truck, not to one material — set the scope to per truck";
  }
  return null;
}

/** Rows the screen shows: the rule, who it narrows to, and what it says in English. */
async function listRules(includeRetired: boolean) {
  /**
   * What each version has actually charged.
   *
   * The figure that makes retiring a version a decision rather than a shrug: a
   * rule that has taken ₹40,000 off four vendors is not one to change casually.
   *
   * The subquery alias is rule_usage, not the obvious "both": BOTH is a
   * reserved word in Postgres (TRIM(BOTH ...)) and an unquoted alias of that
   * name is a syntax error, which took this whole endpoint out with a 500.
   *
   * Both tables, because deductions live on the BILL now — a negative line
   * against the goods — while vendor credit lines still carry a rule where one
   * was raised by hand. Void documents are excluded on either side: a reversed
   * deduction charged nobody. Bill amounts are negated because a deduction is
   * stored as the negative line it is.
   */
  const charged = await db.execute(sql`
    SELECT rule_id, rule_version, sum(lines)::int AS lines, sum(total)::text AS total FROM (
      SELECT l.rule_id, l.rule_version, count(*) AS lines, sum(-l.amount) AS total
      FROM bill_lines l
      JOIN bills b ON b.id = l.bill_id
      WHERE l.rule_id IS NOT NULL AND b.status <> 'void'
      GROUP BY 1, 2
      UNION ALL
      SELECT l.rule_id, l.rule_version, count(*) AS lines, sum(l.amount) AS total
      FROM vendor_credit_lines l
      JOIN vendor_credits c ON c.id = l.vendor_credit_id
      WHERE l.rule_id IS NOT NULL AND c.status <> 'void'
      GROUP BY 1, 2
    ) AS rule_usage
    GROUP BY 1, 2
  `);
  const usage = new Map(
    (charged.rows as Array<{ rule_id: string; rule_version: number; lines: number; total: string }>).map(
      (r) => [`${r.rule_id}:${r.rule_version}`, { lines: r.lines, total: r.total }],
    ),
  );

  const rows = await db
    .select({
      ...getTableColumns(deductionRules),
      itemName: items.name,
      vendorName: contacts.displayName,
      createdByName: users.name,
    })
    .from(deductionRules)
    .leftJoin(items, eq(items.id, deductionRules.itemId))
    .leftJoin(contacts, eq(contacts.id, deductionRules.vendorId))
    .leftJoin(users, eq(users.id, deductionRules.createdBy))
    .where(includeRetired ? undefined : eq(deductionRules.isActive, true))
    .orderBy(asc(deductionRules.parameter), desc(deductionRules.version));

  return rows.map((r) => ({
    ...r,
    describes: describeRule(r as Parameters<typeof describeRule>[0]),
    charged: usage.get(`${r.id}:${r.version}`) ?? { lines: 0, total: "0" },
    /**
     * How narrowly this rule is aimed. The same number `computeDeductions`
     * ranks by, surfaced so the screen can say which rule wins where two
     * overlap rather than leaving it to be discovered on a credit note.
     */
    specificity: (r.itemId ? 2 : 0) + (r.vendorId ? 1 : 0),
  }));
}

deductionRulesRouter.get("/", requirePermission("procurement", "view"), async (req, res) => {
  res.json(await listRules(req.query.includeRetired === "true"));
});

/**
 * What a draft rule would actually charge.
 *
 * Runs the real `computeDeductions` against a sample line rather than
 * re-implementing the arithmetic on the screen, so the preview cannot drift
 * from what settlement will do. The rule is never saved.
 */
deductionRulesRouter.post(
  "/preview",
  requirePermission("procurement", "view"),
  validateBody(
    ruleSchema.partial({ name: true, effectiveFrom: true }).extend({
      reading: z.number(),
      netKg: z.number().positive(),
      ratePerKg: z.number().positive(),
    }),
  ),
  async (req, res) => {
    const b = req.body as RuleBody & { reading: number; netKg: number; ratePerKg: number };
    const draft = {
      id: "preview",
      name: b.name ?? "Draft",
      parameter: b.parameter,
      direction: b.direction,
      scope: b.scope,
      itemId: null,
      vendorId: null,
      threshold: b.threshold ?? null,
      basis: b.basis,
      ratePerPoint: b.ratePerPoint ?? null,
      flatAmount: b.flatAmount ?? null,
      minAmount: b.minAmount ?? null,
      version: 1,
      effectiveFrom: b.effectiveFrom ?? "2026-01-01",
      isActive: true,
      createdBy: null,
      createdAt: new Date(),
    } as typeof deductionRules.$inferSelect;

    const [out] = computeDeductions([draft], {
      itemId: null,
      vendorId: null,
      readings: { [b.parameter]: b.reading },
      netKg: b.netKg,
      ratePerKg: b.ratePerKg,
    });
    res.json({
      amount: out?.amount ?? 0,
      basis: out?.basis ?? null,
      // Distinguishes "the arithmetic came to zero" from "the reading is inside
      // the threshold, so this rule does not fire at all".
      fired: !!out,
      describes: describeRule(draft),
    });
  },
);

deductionRulesRouter.post(
  "/",
  requirePermission("procurement", "manage_rules"),
  validateBody(ruleSchema),
  async (req, res) => {
    const body = req.body as RuleBody;
    const problem = missingField(body);
    if (problem) return res.status(422).json({ error: problem });

    try {
      const [row] = await db
        .insert(deductionRules)
        .values({ ...body, version: 1, createdBy: req.session.user!.id })
        .returning();
      res.status(201).json(row);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return res.status(409).json({ error: clash(body) });
      throw e;
    }
  },
);

/** The message the live-rule index earns. */
function clash(body: RuleBody): string {
  const where = body.itemId
    ? body.vendorId
      ? "that material and vendor"
      : "that material"
    : body.vendorId
      ? "that vendor"
      : "every material and vendor";
  return `A live rule already reads ${body.parameter} for ${where}. Supersede that one instead — two would leave the charge depending on which the database returned first.`;
}

/**
 * Supersede: raise the next version and retire the one it replaces, inside one
 * transaction so the live-rule index is never briefly satisfied by both.
 */
deductionRulesRouter.post(
  "/:id",
  requirePermission("procurement", "manage_rules"),
  validateBody(ruleSchema),
  async (req, res) => {
    const body = req.body as RuleBody;
    const problem = missingField(body);
    if (problem) return res.status(422).json({ error: problem });

    const current = await db.query.deductionRules.findFirst({
      where: eq(deductionRules.id, req.params.id!),
    });
    if (!current) return res.status(404).json({ error: "Rule not found" });
    if (!current.isActive) {
      return res.status(422).json({ error: "That version is already retired — supersede the live one" });
    }

    try {
      const row = await db.transaction(async (tx) => {
        await tx
          .update(deductionRules)
          .set({ isActive: false })
          .where(eq(deductionRules.id, current.id));
        const [created] = await tx
          .insert(deductionRules)
          .values({
            ...body,
            version: current.version + 1,
            createdBy: req.session.user!.id,
          })
          .returning();
        return created!;
      });
      res.status(201).json(row);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return res.status(409).json({ error: clash(body) });
      throw e;
    }
  },
);

/**
 * Retire without a successor — this reading stops costing anything. Past
 * credit notes are untouched: each carries its own arithmetic in writing.
 */
deductionRulesRouter.delete(
  "/:id",
  requirePermission("procurement", "manage_rules"),
  async (req, res) => {
    const [row] = await db
      .update(deductionRules)
      .set({ isActive: false })
      .where(and(eq(deductionRules.id, req.params.id!), eq(deductionRules.isActive, true)))
      .returning({ id: deductionRules.id });
    if (!row) return res.status(404).json({ error: "No live rule with that id" });
    res.json({ ok: true });
  },
);

/**
 * The parameters a rule may read: every one any live QC spec measures, plus the
 * two the flow produces without a lab. Offered rather than free-typed, because
 * a rule whose parameter matches nothing is silent — it never fires and never
 * says why.
 */
deductionRulesRouter.get(
  "/parameters",
  requirePermission("procurement", "view"),
  async (_req, res) => {
    const rows = await db.execute(sql`
      SELECT DISTINCT p.parameter, coalesce(p.label, p.parameter) AS label
      FROM qc_spec_params p
      JOIN qc_specs s ON s.id = p.spec_id
      WHERE s.is_active
      ORDER BY 1
    `);
    res.json([
      { parameter: "shortage", label: "Weight shortage (kg)", source: "weighbridge" },
      { parameter: "damage", label: "Damage (%)", source: "unloading" },
      ...(rows.rows as Array<{ parameter: string; label: string }>).map((r) => ({
        ...r,
        source: "quality spec",
      })),
    ]);
  },
);

/** Materials and vendors a rule can be narrowed to. */
deductionRulesRouter.get("/targets", requirePermission("procurement", "view"), async (_req, res) => {
  const [materials, vendors] = await Promise.all([
    db
      .select({ id: items.id, name: items.name })
      .from(items)
      .where(and(eq(items.isActive, true), eq(items.isPurchased, true)))
      .orderBy(asc(items.name)),
    db
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .where(and(eq(contacts.isActive, true), or(eq(contacts.type, "vendor"), eq(contacts.type, "both"))))
      .orderBy(asc(contacts.displayName)),
  ]);
  res.json({ materials, vendors });
});
