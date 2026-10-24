/**
 * How much feed each laying house really took, and what October's owner
 * billing would charge against what it should. Read only.
 *
 *   npx tsx scripts/report-feed-billing-estimate.ts [--from=2026-10-01] [--to=2026-10-23]
 *
 * Owner billing charges the LLPs the mill transfers into their houses, at the
 * rate stamped on each (services/owner-billing.ts). In October 2026 trucks
 * went out with no transfer — the houses ate 169 t more than they were sent —
 * so the draft would bill short. Production is fact; transfers miss trucks;
 * the silos see every truck but their load cells read off (L2, L3 low), and
 * "house ate" is the same load cells. So:
 *
 *   factor     each house's load cells against the mill: every transfer is
 *              paired with the silo rise(s) that arrived for it (a day before
 *              to the day after, 0.6–1.3× its weight), and the factor is the
 *              median rise ÷ transfer
 *   silo est   silo arrivals ÷ factor — misses tankers on days the controller
 *              was offline
 *   ate est    (house ate + silo stock now − silo stock before) ÷ factor —
 *              what went into the silo, by balance; blind days are typed or
 *              filled, so it misses nothing
 *   estimate   the ate estimate; the silo estimate beside it as a check
 *   mill       produced − estimated delivered = what the mill should hold
 *              beyond its opening stock — the number a physical count settles
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { tankersFor } from "../server/services/house-day-autofill";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const FROM = arg("from", "2026-10-01");
const TO = arg("to", "2026-10-23");
const startOf = (day: string) => new Date(`${day}T00:00:00+05:30`);
const addDays = (d: string, n: number) => new Date(startOf(d).getTime() + n * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const kg = (n: number) => Math.round(n).toLocaleString("en-IN");
const rs = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};

async function main() {
  const houses = (
    await db.execute(sql`
      SELECT h.id::text, h.code, c.display_name AS owner
        FROM houses h LEFT JOIN contacts c ON c.id = h.owner_id
       WHERE h.code IN ('L2', 'L3', 'L4', 'L5') ORDER BY h.display_order`)
  ).rows as Array<{ id: string; code: string; owner: string | null }>;

  const out: Array<{ code: string; owner: string; sent: number; value: number; factor: number; pairs: number; silo: number; siloEst: number; ate: number; stockMove: number; ateEst: number }> = [];
  for (const h of houses) {
    const transfers = (
      await db.execute(sql`
        SELECT transfer_date::text AS d, quantity_kg::float8 AS kg, value::float8 AS value
          FROM feed_transfers WHERE to_house_id = ${h.id}::uuid AND status <> 'void'
           AND transfer_date BETWEEN ${FROM}::date AND ${TO}::date ORDER BY transfer_date, number`)
    ).rows as Array<{ d: string; kg: number; value: number }>;
    const { tankers } = await tankersFor(h.id, FROM, TO);
    const rises = tankers.map((t) => t.move).filter((m) => m.kg >= 1_000).sort((a, b) => a.start.getTime() - b.start.getTime());

    // Pair each transfer with the rise, or two in a row, that best fits it.
    const used = new Set<number>();
    const ratios: number[] = [];
    for (const t of transfers) {
      const from = new Date(startOf(addDays(t.d, -1)).getTime() + 12 * 3_600_000);
      const to = new Date(startOf(addDays(t.d, 1)).getTime() + 12 * 3_600_000);
      let best: { idx: number[]; r: number } | null = null;
      for (let i = 0; i < rises.length; i++) {
        if (used.has(i) || rises[i]!.start < from || rises[i]!.start >= to) continue;
        for (const idx of [[i], [i, i + 1]]) {
          if (idx.some((j) => j >= rises.length || used.has(j) || rises[j]!.start >= to)) continue;
          const r = idx.reduce((s, j) => s + rises[j]!.kg, 0) / t.kg;
          if (r < 0.6 || r > 1.3) continue;
          if (!best || Math.abs(Math.log(r)) < Math.abs(Math.log(best.r))) best = { idx, r };
        }
      }
      if (best) {
        best.idx.forEach((j) => used.add(j));
        ratios.push(best.r);
      }
    }
    const factor = median(ratios);

    const [bal] = (
      await db.execute(sql`
        SELECT coalesce(sum(pd.feed_consumed_kg) FILTER (WHERE pd.day BETWEEN ${FROM}::date AND ${TO}::date), 0)::float8 AS ate,
               (SELECT sum(p2.feed_closing_kg) FROM placement_days p2 JOIN flock_placements f2 ON f2.id = p2.placement_id
                 WHERE f2.house_id = ${h.id}::uuid AND p2.day = ${addDays(FROM, -1)}::date)::float8 AS open,
               (SELECT sum(p2.feed_closing_kg) FROM placement_days p2 JOIN flock_placements f2 ON f2.id = p2.placement_id
                 WHERE f2.house_id = ${h.id}::uuid AND p2.day = ${TO}::date)::float8 AS close
          FROM placement_days pd JOIN flock_placements fp ON fp.id = pd.placement_id
         WHERE fp.house_id = ${h.id}::uuid`)
    ).rows as Array<{ ate: number; open: number | null; close: number | null }>;
    const stockMove = bal!.open != null && bal!.close != null ? bal!.close - bal!.open : 0;
    const silo = rises.reduce((s, m) => s + m.kg, 0);
    out.push({
      code: h.code,
      owner: h.owner ?? "(no owner)",
      sent: transfers.reduce((s, t) => s + t.kg, 0),
      value: transfers.reduce((s, t) => s + t.value, 0),
      factor,
      pairs: ratios.length,
      silo,
      siloEst: silo / factor,
      ate: bal!.ate,
      stockMove,
      ateEst: (bal!.ate + stockMove) / factor,
    });
  }

  console.log(`\nFEED INTO THE LAYING HOUSES, ${FROM} to ${TO} (kg)\n`);
  console.log("house  load cells       transferred    silo saw → est    ate + Δstock → est     estimate    missing");
  for (const o of out) {
    console.log(
      `${o.code.padEnd(5)}  ×${o.factor.toFixed(3)} (${String(o.pairs).padStart(2)} pairs)  ${kg(o.sent).padStart(10)}  ` +
        `${kg(o.silo).padStart(9)} → ${kg(o.siloEst).padStart(9)}  ${kg(o.ate + o.stockMove).padStart(9)} → ${kg(o.ateEst).padStart(9)}  ` +
        `${kg(o.ateEst).padStart(10)}  ${kg(o.ateEst - o.sent).padStart(9)}`,
    );
  }
  const sum = (f: (o: (typeof out)[number]) => number) => out.reduce((s, o) => s + f(o), 0);
  console.log(
    `ALL                          ${kg(sum((o) => o.sent)).padStart(10)}  ${kg(sum((o) => o.silo)).padStart(9)} → ${kg(sum((o) => o.siloEst)).padStart(9)}  ` +
      `${kg(sum((o) => o.ate + o.stockMove)).padStart(9)} → ${kg(sum((o) => o.ateEst)).padStart(9)}  ${kg(sum((o) => o.ateEst)).padStart(10)}  ${kg(sum((o) => o.ateEst - o.sent)).padStart(9)}`,
  );

  const [mill] = (
    await db.execute(sql`
      SELECT coalesce(sum(quantity) FILTER (WHERE source_type = 'feed_mill' AND quantity > 0 AND transaction_date BETWEEN ${FROM}::date AND ${TO}::date), 0)::float8 AS made,
             coalesce(sum(quantity) FILTER (WHERE transaction_date < ${FROM}::date), 0)::float8 AS opening
        FROM inventory_transactions WHERE item_id IN (SELECT output_item_id FROM formulas)`)
  ).rows as Array<{ made: number; opening: number }>;
  const est = sum((o) => o.ateEst);
  console.log(`\nMILL  opening book ${kg(mill!.opening)}  + produced ${kg(mill!.made)}  − estimated delivered ${kg(est)}  = should hold ${kg(mill!.opening + mill!.made - est)} on ${TO}`);

  console.log("\nOWNER BILLING — feed, as transfers stand vs the estimate\n");
  const owners = [...new Set(out.map((o) => o.owner))];
  for (const w of owners) {
    const mine = out.filter((o) => o.owner === w);
    const sent = mine.reduce((s, o) => s + o.sent, 0);
    const value = mine.reduce((s, o) => s + o.value, 0);
    const estKg = mine.reduce((s, o) => s + o.ateEst, 0);
    // The missing kilos at each house's own average transfer rate, as billing prices feed.
    const estValue = mine.reduce((s, o) => s + (o.sent ? o.value + (o.ateEst - o.sent) * (o.value / o.sent) : 0), 0);
    console.log(`${w}  (${mine.map((o) => o.code).join(", ")})`);
    console.log(`  transfers now   ${kg(sent).padStart(10)} kg   ${rs(value)}`);
    console.log(`  estimate        ${kg(estKg).padStart(10)} kg   ${rs(estValue)}`);
    console.log(`  short           ${kg(estKg - sent).padStart(10)} kg   ${rs(estValue - value)}\n`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
