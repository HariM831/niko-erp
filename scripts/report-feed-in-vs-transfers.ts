/**
 * Feed the mill sent each house against what the house's silo saw arrive and
 * what the house says it ate. Read only.
 *
 *   npx tsx scripts/report-feed-in-vs-transfers.ts [--from=2026-10-01] [--to=2026-10-23]
 *
 * Written 24 Oct 2026 when booking 72 SCADA batches nobody had entered left
 * the mill holding 298 t of feed on paper — more than it can. If feed went to
 * the sheds without a transfer, the silos saw it: each tanker is a rise in the
 * silo weight, and tankersFor matches those rises to transfers the way the
 * daily autofill does (within 3%). L2 and L3's silos read 14–23% under on
 * every tanker (Oct 2026), so their rises will not match and their totals are
 * shown beside the transfers instead.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { tankersFor } from "../server/services/house-day-autofill";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const FROM = arg("from", "2026-10-01");
const TO = arg("to", "2026-10-23");
const t = (kg: number) => (kg / 1000).toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

async function main() {
  const houses = (
    await db.execute(sql`
      SELECT h.id::text, h.code,
             EXISTS (SELECT 1 FROM iot_house_sample s WHERE s.house_id = h.id AND s.at >= ${FROM}::date) AS iot,
             coalesce((SELECT sum(quantity_kg) FROM feed_transfers ft
                        WHERE ft.to_house_id = h.id AND ft.status <> 'void'
                          AND ft.transfer_date BETWEEN ${FROM}::date AND ${TO}::date), 0)::float8 AS sent,
             (SELECT count(*) FROM feed_transfers ft
               WHERE ft.to_house_id = h.id AND ft.status <> 'void'
                 AND ft.transfer_date BETWEEN ${FROM}::date AND ${TO}::date)::int AS n,
             coalesce((SELECT sum(pd.feed_consumed_kg) FROM placement_days pd
                        JOIN flock_placements fp ON fp.id = pd.placement_id
                       WHERE fp.house_id = h.id AND pd.day BETWEEN ${FROM}::date AND ${TO}::date), 0)::float8 AS eaten
        FROM houses h
       WHERE h.is_active
       ORDER BY h.display_order, h.code`)
  ).rows as Array<{ id: string; code: string; iot: boolean; sent: number; n: number; eaten: number }>;

  console.log(`\nFEED IN, ${FROM} to ${TO} (tonnes)\n`);
  console.log("house  transfers        silo saw   matched  silo-only (no transfer)   transfers silo missed   blind days   house ate");
  const totals = { sent: 0, rose: 0, eaten: 0, only: 0 };
  const detail: string[] = [];
  const siloByDay = new Map<string, Map<string, number>>(); // house → day → kg
  const ist = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  for (const h of houses) {
    if (!h.sent && !h.eaten && !h.iot) continue;
    let rose = 0;
    let matched = 0;
    let only = 0;
    let missed = 0;
    let blind = 0;
    if (h.iot) {
      const r = await tankersFor(h.id, FROM, TO);
      for (const k of r.tankers) {
        if (k.move.kg < 1_000) continue;
        rose += k.move.kg;
        const byDay = siloByDay.get(h.code) ?? new Map<string, number>();
        byDay.set(ist(k.move.start), (byDay.get(ist(k.move.start)) ?? 0) + k.move.kg);
        siloByDay.set(h.code, byDay);
        if (k.transfer) matched += k.move.kg;
        else {
          only += k.move.kg;
          detail.push(`  ${h.code}  ${k.move.start.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}  ${Math.round(k.move.kg).toLocaleString("en-IN")} kg`);
        }
      }
      missed = r.unseen.reduce((s, u) => s + u.quantityKg, 0);
      blind = [...r.blind].filter((d) => d >= FROM && d <= TO).length;
    }
    totals.sent += h.sent;
    totals.rose += rose;
    totals.eaten += h.eaten;
    totals.only += only;
    console.log(
      `${h.code.padEnd(6)} ${t(h.sent).padStart(7)} (${String(h.n).padStart(2)})   ` +
        (h.iot
          ? `${t(rose).padStart(7)}   ${t(matched).padStart(7)}   ${t(only).padStart(10)}                ${t(missed).padStart(10)}            ${String(blind).padStart(3)}`
          : "      — no silo readings —                                               ") +
        `      ${t(h.eaten).padStart(7)}`,
    );
  }
  console.log(`\nTOTAL  sent ${t(totals.sent)}  silo saw ${t(totals.rose)}  silo-only ${t(totals.only)}  houses ate ${t(totals.eaten)}`);

  const mill = (
    await db.execute(sql`
      SELECT i.name,
             coalesce(sum(t.quantity) FILTER (WHERE t.source_type = 'feed_mill' AND t.transaction_date BETWEEN ${FROM}::date AND ${TO}::date), 0)::float8 AS made,
             coalesce(-sum(t.quantity) FILTER (WHERE t.source_type = 'feed_transfer' AND t.transaction_date BETWEEN ${FROM}::date AND ${TO}::date), 0)::float8 AS sent,
             sum(t.quantity)::float8 AS on_hand
        FROM inventory_transactions t JOIN items i ON i.id = t.item_id
       WHERE i.id IN (SELECT output_item_id FROM formulas)
       GROUP BY i.name ORDER BY i.name`)
  ).rows as Array<{ name: string; made: number; sent: number; on_hand: number }>;
  console.log("\nMILL — made, sent, on hand now (tonnes)");
  for (const m of mill) console.log(`  ${m.name.padEnd(14)} made ${t(m.made).padStart(7)}  sent ${t(m.sent).padStart(7)}  on hand ${t(m.on_hand).padStart(7)}`);

  if (process.argv.includes("--daily")) {
    const made = new Map(
      ((await db.execute(sql`
        SELECT transaction_date::text AS d, sum(quantity)::float8 AS kg FROM inventory_transactions
         WHERE source_type = 'feed_mill' AND quantity > 0 AND transaction_date BETWEEN ${FROM}::date AND ${TO}::date
           AND item_id IN (SELECT output_item_id FROM formulas)
         GROUP BY 1`)).rows as Array<{ d: string; kg: number }>).map((r) => [r.d, r.kg]),
    );
    const perHouse = (
      await db.execute(sql`
        WITH days AS (SELECT generate_series(${FROM}::date, ${TO}::date, '1 day')::date AS d)
        SELECT days.d::text AS d, h.code,
               coalesce((SELECT sum(quantity_kg) FROM feed_transfers ft WHERE ft.to_house_id = h.id AND ft.status <> 'void' AND ft.transfer_date = days.d), 0)::float8 AS sent,
               (SELECT sum(pd.feed_consumed_kg) FROM placement_days pd JOIN flock_placements fp ON fp.id = pd.placement_id
                 WHERE fp.house_id = h.id AND pd.day = days.d)::float8 AS eaten
          FROM days CROSS JOIN houses h
         WHERE h.code IN ('L2', 'L3', 'L4', 'L5')
         ORDER BY 1, h.display_order`)
    ).rows as Array<{ d: string; code: string; sent: number; eaten: number | null }>;
    const days = [...new Set(perHouse.map((r) => r.d))];
    const table = (title: string, codes: string[], withMade: boolean) => {
      console.log(`
${title} (kg)
`);
      console.log(`day        ${withMade ? "  produced " : ""}  transferred   silo saw   house ate`);
      const tot = { made: 0, sent: 0, silo: 0, eaten: 0 };
      for (const d of days) {
        const rows = perHouse.filter((r) => r.d === d && codes.includes(r.code));
        const sent = rows.reduce((a, r) => a + r.sent, 0);
        const silo = codes.reduce((a, c) => a + (siloByDay.get(c)?.get(d) ?? 0), 0);
        const eatenRows = rows.filter((r) => r.eaten != null);
        const eaten = eatenRows.reduce((a, r) => a + r.eaten!, 0);
        const m = withMade ? (made.get(d) ?? 0) : 0;
        tot.made += m;
        tot.sent += sent;
        tot.silo += silo;
        tot.eaten += eaten;
        const k = (n: number) => Math.round(n).toLocaleString("en-IN").padStart(10);
        console.log(
          `${d}  ${withMade ? k(m) + " " : ""}  ${k(sent)}  ${k(silo)}  ${k(eaten)}${eatenRows.length < rows.length ? ` (${eatenRows.length}/${rows.length} houses)` : ""}`,
        );
      }
      const k = (n: number) => Math.round(n).toLocaleString("en-IN").padStart(10);
      console.log(`TOTAL       ${withMade ? k(tot.made) + " " : ""}  ${k(tot.sent)}  ${k(tot.silo)}  ${k(tot.eaten)}`);
    };
    table("ALL FOUR LAYING HOUSES (L2–L5), MILL PRODUCTION BESIDE", ["L2", "L3", "L4", "L5"], true);
    for (const c of ["L2", "L3", "L4", "L5"]) table(c, [c], false);
  }

  if (detail.length && !process.argv.includes("--daily")) {
    console.log("\nSILO RISES WITH NO TRANSFER (≥ 1 t)");
    for (const d of detail) console.log(d);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
