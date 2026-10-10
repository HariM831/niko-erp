/**
 * What the entry form would offer, house by house, day by day — read only.
 *
 * For checking the autofill against the farm's register before trusting it:
 * prints each figure's status, value and note, and the day's tankers.
 *
 *   npx tsx scripts/show-house-day-autofill.ts 2026-10-03 2026-10-08 [L2 L4 …]
 */
import { and, eq, inArray } from "drizzle-orm";
import { houses } from "@shared/schema";
import { judgeStock } from "@shared/house-day";
import { db } from "../server/db";
import { addDays } from "../server/services/day-resolution";
import { sql } from "drizzle-orm";
import { autofillDay, panelMortality } from "../server/services/house-day-autofill";

async function main() {
  const [from, to, ...codes] = process.argv.slice(2);
  if (!from || !to) throw new Error("Give a first and last day, YYYY-MM-DD");
  const rows = await db
    .select({ id: houses.id, code: houses.code })
    .from(houses)
    .where(and(eq(houses.isActive, true), codes.length ? inArray(houses.code, codes) : undefined));
  for (const h of rows.sort((a, b) => a.code.localeCompare(b.code))) {
    console.log(`== ${h.code}`);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const a = await autofillDay(h.id, d);
      const fc = a.feedConsumedKg;
      const st = judgeStock(a.stock, fc.value);
      const w = a.waterKl;
      const show = (label: string, f: { status: string; value: number | null; note: string }) =>
        `${label} ${f.status === "filled" ? f.value : `[${f.status}]`}`;
      console.log(`${d}  ${show("fed", fc)}  ${show("stock", st)}  ${show("water", w)}`);
      if (fc.status !== "filled") console.log(`      fed: ${fc.note}`);
      if (st.status === "check") console.log(`      stock: ${st.note}`);
      const pl = await db.execute<{ id: string }>(sql`
        SELECT p.id FROM flock_placements p
         WHERE p.house_id = ${h.id} AND p.from_date <= ${d} AND (p.to_date IS NULL OR p.to_date >= ${d})
         ORDER BY (SELECT count(*) FROM placement_days x WHERE x.placement_id = p.id) DESC LIMIT 1`);
      if (pl.rows[0]) {
        const m = await panelMortality(pl.rows[0].id, h.id, d);
        console.log(`      mortality: ${"qty" in m ? m.qty : `held — ${m.held}`}`);
      }
      for (const t of a.tankers) {
        console.log(
          `      tanker ${new Date(t.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} +${t.kg} ${t.transfer ? `${t.transfer.number} (${t.transfer.transferDate})` : "NO TRANSFER"}`,
        );
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
