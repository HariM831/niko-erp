/**
 * What a kilo of a feed material costs — one rule for every feed screen.
 *
 * The formula comparison priced materials from their last purchase; the
 * formulator priced them from the stock ledger and the item's typed price, so
 * the two disagreed on the same recipe and the solver sat out anything never
 * typed — Soybean Meal and Lime Stone Grits on staging, both bought within the
 * month. The rule now lives here and both read it.
 *
 * In order of what it is worth: the delivered cost of the last load, then
 * what that load cost before carriage, and only then the standing price
 * somebody typed on the item. Those typed figures had gone stale unnoticed:
 * maize said 22.00 against a last bill of 25.30, methionine 283 against 492,
 * and limestone and one of the soyas said nothing at all.
 *
 * A material bought by the pack is divided by what the pack weighs — the
 * premix is 679 a four-kilo pack, so 169.75 a kilo. Read straight it would
 * cost four times the entire mix. Where the pack weight is not recorded there
 * is no honest conversion, so it gets no rate rather than a wrong one.
 */
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db";

export type PriceBasis = "delivered" | "last bill" | "standing price" | "never bought" | "not per kg";

export interface MaterialPrice {
  /** ₹ per kg; 0 when there is no honest figure (see `basis`). */
  ratePerKg: number;
  basis: PriceBasis;
  /** The bill date behind a delivered or last-bill rate. */
  pricedOn: string | null;
  /** Kilos in the pack, for a material bought by the pack. */
  packKg: number | null;
}

export async function materialPrices(conn: Db | Tx, itemIds: string[]): Promise<Map<string, MaterialPrice>> {
  if (!itemIds.length) return new Map();
  const rows = (
    await conn.execute(sql`
      SELECT i.id                         AS "itemId",
             i.unit                       AS "unit",
             i.unit_bag_weight_kg::float8 AS "packKg",
             i.cost_price::float8         AS "standing",
             last.rate::float8            AS "lastRate",
             last.landed::float8          AS "landed",
             last.bill_date::text         AS "pricedOn"
        FROM items i
        -- The most recent time this material was actually bought. Delivered
        -- cost where the carriage has been matched to the load, the bill rate
        -- where it has not.
        LEFT JOIN LATERAL (
          SELECT bl.rate,
                 NULLIF(bl.landed_unit_cost, 0) AS landed,
                 b.bill_date
            FROM bill_lines bl
            JOIN bills b ON b.id = bl.bill_id
           WHERE bl.item_id = i.id
             AND b.status <> 'void'
             AND bl.quantity > 0
             AND bl.rate > 0
           ORDER BY b.bill_date DESC, bl.id DESC
           LIMIT 1
        ) last ON true
       WHERE i.id IN (${sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `)
  ).rows as Array<{
    itemId: string;
    unit: string;
    packKg: number | null;
    standing: number | null;
    lastRate: number | null;
    landed: number | null;
    pricedOn: string | null;
  }>;

  const out = new Map<string, MaterialPrice>();
  for (const l of rows) {
    const perPack = l.unit !== "kg";
    const packKg = l.packKg ?? 0;
    if (perPack && packKg <= 0) {
      out.set(l.itemId, { ratePerKg: 0, basis: "not per kg", pricedOn: null, packKg: null });
      continue;
    }
    const toKg = (v: number) => (perPack ? v / packKg : v);
    const pack = perPack ? packKg : null;
    if (l.landed != null) out.set(l.itemId, { ratePerKg: toKg(l.landed), basis: "delivered", pricedOn: l.pricedOn, packKg: pack });
    else if (l.lastRate != null) out.set(l.itemId, { ratePerKg: toKg(l.lastRate), basis: "last bill", pricedOn: l.pricedOn, packKg: pack });
    else if (l.standing) out.set(l.itemId, { ratePerKg: toKg(l.standing), basis: "standing price", pricedOn: null, packKg: pack });
    else out.set(l.itemId, { ratePerKg: 0, basis: "never bought", pricedOn: null, packKg: pack });
  }
  return out;
}
