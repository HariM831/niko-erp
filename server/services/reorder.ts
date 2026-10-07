/**
 * What the feed mill has to buy: every ingredient of the live formulas, how
 * long the stock lasts, and what to order for the coming month plus a safety
 * margin (the Reorder Report, 7 Oct 2026).
 *
 *   rate      the mill's average daily output over the look-back window
 *             (calendar days, so idle days count as zero)
 *   mix       each stage's share of that output, applied to the stage's
 *             CURRENT formula — a formula changed last week is planned on its
 *             new recipe, not on what the old one used
 *   use/day   Σ over stages: rate × share × kg per batch ÷ batch size, in the
 *             item's own stock unit — a premix counted in 4 kg packs is used
 *             by the pack, through its bag weight, as production takes it out
 *   on order  what is still to come on open purchase orders, by the Purchase
 *             Order Details rule: not cancelled, not billed or closed, and
 *             under 95% delivered
 *   to order  use/day × (horizon + safety) − on hand − on order, never below 0
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { stockOnHand, stockUnitsPerKg } from "./inventory";
import { addDays, istDate } from "./day-resolution";

export interface ReorderParams {
  horizonDays: number;
  safetyDays: number;
  lookbackDays: number;
}

export async function reorderReport(db: Db, p: ReorderParams) {
  const today = istDate();
  const from = addDays(today, -p.lookbackDays);
  const to = addDays(today, -1);

  const formulas = (
    await db.execute(sql`
      SELECT f.id, f.name, f.stage::text AS stage, f.version, f.batch_size_kg::float8 AS batch,
             l.item_id AS "itemId", l.quantity_kg::float8 AS qty, i.unit, i.unit_bag_weight_kg::text AS "unitBagWeightKg"
        FROM formulas f JOIN formula_lines l ON l.formula_id = f.id JOIN items i ON i.id = l.item_id
       WHERE f.is_active`)
  ).rows as Array<{ id: string; name: string; stage: string; version: number; batch: number; itemId: string; qty: number; unit: string | null; unitBagWeightKg: string | null }>;

  const made = (
    await db.execute(sql`
      SELECT f.stage::text AS stage, sum(p.actual_output_kg)::float8 AS kg
        FROM production_orders p JOIN formulas f ON f.id = p.formula_id
       WHERE p.order_date BETWEEN ${from}::date AND ${to}::date AND p.actual_output_kg IS NOT NULL
       GROUP BY 1`)
  ).rows as Array<{ stage: string; kg: number }>;
  const totalKg = made.reduce((n, r) => n + r.kg, 0);
  const ratePerDay = totalKg / p.lookbackDays;
  const share = new Map(made.map((r) => [r.stage, totalKg ? r.kg / totalKg : 0]));

  // kg of each ingredient per day, from the live formula of each stage made
  const usePerDay = new Map<string, number>();
  const formulaOfStage = new Map<string, { name: string; version: number }>();
  for (const f of formulas) {
    const s = share.get(f.stage) ?? 0;
    if (!s || !f.batch) continue;
    formulaOfStage.set(f.stage, { name: f.name, version: f.version });
    const perKg = stockUnitsPerKg(f) ?? 1; // a pack item with no bag weight is shown in kg rather than dropped
    usePerDay.set(f.itemId, (usePerDay.get(f.itemId) ?? 0) + ((ratePerDay * s * f.qty) / f.batch) * perKg);
  }

  const onOrder = new Map(
    (
      (
        await db.execute(sql`
          WITH po AS (
            SELECT o.id, o.number, o.status::text AS status,
                   sum(l.quantity)::float8 AS ordered, sum(coalesce(l.delivered_quantity, 0))::float8 AS received
              FROM purchase_orders o JOIN purchase_order_lines l ON l.purchase_order_id = o.id
             WHERE o.status NOT IN ('draft', 'cancelled', 'billed', 'closed')
             GROUP BY o.id)
          SELECT l.item_id AS "itemId",
                 sum(greatest(l.quantity - coalesce(l.delivered_quantity, 0), 0))::float8 AS qty,
                 string_agg(DISTINCT po.number, ', ') AS pos
            FROM po JOIN purchase_order_lines l ON l.purchase_order_id = po.id
           WHERE po.ordered > 0 AND po.received / po.ordered < 0.95 AND l.item_id IS NOT NULL
           GROUP BY 1`)
      ).rows as Array<{ itemId: string; qty: number; pos: string }>
    ).map((r) => [r.itemId, r]),
  );

  const ingredientIds = new Set(formulas.map((f) => f.itemId));
  const stock = (await stockOnHand(db)).filter((s) => ingredientIds.has(s.itemId));
  const window = p.horizonDays + p.safetyDays;
  const rows = stock
    .map((s) => {
      const use = usePerDay.get(s.itemId) ?? 0;
      const onHand = Math.max(Number(s.quantity), 0);
      const po = onOrder.get(s.itemId);
      const pending = po?.qty ?? 0;
      const need = use * window;
      const coverDays = use > 0 ? onHand / use : null;
      return {
        itemId: s.itemId,
        name: s.name,
        unit: s.unit,
        onHand,
        usePerDay: use,
        coverDays,
        runsOutOn: coverDays === null ? null : addDays(today, Math.floor(coverDays)),
        onOrder: pending,
        purchaseOrders: po?.pos ?? "",
        coverWithOrdersDays: use > 0 ? (onHand + pending) / use : null,
        need,
        toOrder: Math.max(need - onHand - pending, 0),
      };
    })
    .filter((r) => r.usePerDay > 0 || r.onOrder > 0)
    .sort((a, b) => (a.coverDays ?? Infinity) - (b.coverDays ?? Infinity));

  return {
    asOf: today,
    basis: {
      horizonDays: p.horizonDays,
      safetyDays: p.safetyDays,
      lookbackDays: p.lookbackDays,
      from,
      to,
      producedKg: totalKg,
      ratePerDay,
      mix: [...share.entries()]
        .filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([stage, s]) => ({ stage, share: s, formula: formulaOfStage.get(stage) ?? null })),
    },
    rows,
  };
}
