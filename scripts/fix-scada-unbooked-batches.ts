/**
 * Book the batches SCADA weighed that have no production entry.
 *
 *   npx tsx scripts/fix-scada-unbooked-batches.ts [--from=2026-10-01] [--to=2026-10-23]
 *   npx tsx scripts/fix-scada-unbooked-batches.ts --commit
 *
 * Stock is deducted only by production entries; SCADA batches are records
 * beside them. On 24 Oct 2026 the two were compared for 1–23 Oct and the mill
 * had made about 70 batches nobody entered — all of 6 Oct (46), seven Layer 2
 * on 14 Oct, and a batch or two on a dozen other days — so about 104 t of
 * ingredients were never taken out of stock and the feed never came in.
 *
 * For each day and recipe where SCADA counts more batches than were entered,
 * one production entry for the difference, dated that day, through the mill's
 * own produceOne:
 *
 *   counted   SCADA batches that weighed something; an aborted one (0 kg,
 *             9 and 15 Oct) is not a batch
 *   formula   the version entered that day for the recipe; with none, the
 *             latest entered on or before it, else the next one after — the
 *             recipe actually milled, which may since have been retired
 *   costed    at the average cost in stock now, as any late entry is
 *
 * A day with MORE entered than SCADA counts (Layer 3 on 15 and 22 Oct) is
 * only listed: that is an entry to look at, not a batch to book.
 *
 * Dry run by default: everything is posted and rolled back.
 */
import { eq, sql } from "drizzle-orm";
import { users } from "@shared/schema";
import { db, pool } from "../server/db";
import { produceOne } from "../server/routes/feed-production";

const COMMIT = process.argv.includes("--commit");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const FROM = arg("from", "2026-10-01");
const TO = arg("to", "2026-10-23");
const AS = arg("as", "admin");
const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

class Rollback extends Error {}

type Gap = { d: string; recipe: string; scada_n: number; booked_n: number; formula_id: string | null; formula: string | null };

async function main() {
  const [actor] = await db.select({ id: users.id }).from(users).where(eq(users.username, AS));
  if (!actor) throw new Error(`No user "${AS}"`);

  try {
    await db.transaction(async (tx) => {
      const gaps = (
        await tx.execute(sql`
          WITH s AS (
            SELECT (batched_at AT TIME ZONE 'Asia/Kolkata')::date AS d,
                   upper(regexp_replace(trim(recipe_name), '\\s+', ' ', 'g')) AS recipe, count(*)::int AS n
              FROM scada_batches
             WHERE (batched_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${FROM}::date AND ${TO}::date
               AND act_total_kg > 0
             GROUP BY 1, 2),
          p AS (
            SELECT o.order_date AS d, upper(f.name) AS recipe, sum(o.batch_count)::int AS n,
                   (array_agg(f.id ORDER BY o.created_at DESC))[1] AS formula_id
              FROM production_orders o JOIN formulas f ON f.id = o.formula_id
             WHERE o.status <> 'void' AND o.order_date BETWEEN ${FROM}::date AND ${TO}::date
             GROUP BY 1, 2),
          g AS (
            SELECT coalesce(s.d, p.d)::text AS d, coalesce(s.recipe, p.recipe) AS recipe,
                   coalesce(s.n, 0) AS scada_n, coalesce(p.n, 0) AS booked_n,
                   coalesce(p.formula_id,
                     (SELECT f.id FROM production_orders o JOIN formulas f ON f.id = o.formula_id
                       WHERE o.status <> 'void' AND upper(f.name) = s.recipe AND o.order_date <= s.d
                       ORDER BY o.order_date DESC, o.created_at DESC LIMIT 1),
                     (SELECT f.id FROM production_orders o JOIN formulas f ON f.id = o.formula_id
                       WHERE o.status <> 'void' AND upper(f.name) = s.recipe AND o.order_date > s.d
                       ORDER BY o.order_date, o.created_at LIMIT 1)) AS formula_id
              FROM s FULL JOIN p ON p.d = s.d AND p.recipe = s.recipe
             WHERE coalesce(s.n, 0) <> coalesce(p.n, 0))
          SELECT g.d, g.recipe, g.scada_n, g.booked_n, g.formula_id::text, f.name || ' v' || f.version AS formula
            FROM g LEFT JOIN formulas f ON f.id = g.formula_id
           ORDER BY g.d, g.recipe`)
      ).rows as Gap[];

      const over = gaps.filter((g) => g.booked_n > g.scada_n);
      const toBook = gaps.filter((g) => g.scada_n > g.booked_n);
      const unformulated = toBook.filter((g) => !g.formula_id);
      if (unformulated.length) {
        throw new Error(`No formula found for ${unformulated.map((g) => `${g.recipe} on ${g.d}`).join(", ")}`);
      }

      console.log(`\nBOOKED — ${toBook.length} entries\n`);
      let batches = 0;
      let inKg = 0;
      let outKg = 0;
      let value = 0;
      for (const g of toBook) {
        const n = g.scada_n - g.booked_n;
        const order = await produceOne(
          tx,
          { formulaId: g.formula_id!, batchCount: n, allowRetired: true },
          {
            orderDate: g.d,
            notes: `Booked from SCADA: ${g.scada_n} batches weighed, ${g.booked_n} entered (24 Oct 2026)`,
          },
          actor.id,
        );
        batches += n;
        inKg += Number(order.plannedOutputKg);
        outKg += Number(order.actualOutputKg);
        value += Number(order.inputValue) + Number(order.overheadValue);
        console.log(
          `  ${order.number}  ${g.d}  ${g.formula!.padEnd(11)}  ${String(n).padStart(2)} batches  ` +
            `${Number(order.plannedOutputKg).toLocaleString("en-IN")} kg in  ₹${Number(order.costPerKg).toFixed(4)}/kg  ₹${money(Number(order.inputValue))}`,
        );
      }

      const used = (
        await tx.execute(sql`
          SELECT i.name, round(sum(l.actual_kg)::numeric, 1)::float8 AS kg, round(sum(l.value)::numeric, 2)::float8 AS value
            FROM production_order_lines l
            JOIN production_orders o ON o.id = l.order_id
            JOIN items i ON i.id = l.item_id
           WHERE o.notes LIKE 'Booked from SCADA:%' AND o.created_at >= now() - interval '1 hour'
           GROUP BY i.name ORDER BY 2 DESC`)
      ).rows as Array<{ name: string; kg: number; value: number }>;
      console.log("\nDEDUCTED\n");
      for (const u of used) console.log(`  ${u.name.padEnd(32)} ${u.kg.toLocaleString("en-IN").padStart(10)} kg   ₹${money(u.value)}`);
      console.log(
        `\nTOTAL  ${batches} batches, ${inKg.toLocaleString("en-IN")} kg in, ${outKg.toLocaleString("en-IN")} kg feed out, ₹${money(value)} into feed stock`,
      );

      if (over.length) {
        console.log("\nMORE ENTERED THAN SCADA WEIGHED — not touched\n");
        for (const g of over) console.log(`  ${g.d}  ${g.recipe}  SCADA ${g.scada_n}, entered ${g.booked_n}`);
      }

      if (!COMMIT) throw new Rollback();
    });
    console.log("\nCommitted.");
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log("\nDry run — rolled back. Pass --commit to apply.");
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
