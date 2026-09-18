/**
 * Put the carriage back on the load it carried, so a material costs what it
 * cost delivered.
 *
 * niko already has the machinery — `bill_lines.allocated_freight` and
 * `landed_unit_cost`, filled in whenever a bill is raised here, and shown on
 * the document screen. The Zoho years never used it: carriage was billed by
 * the transporter on his own bill, so 41.7 lakh of it sits in five expense
 * accounts with nothing saying which consignment it belonged to. Limestone from
 * Gaurika reads 2.31 a kilo against Sukesh's 7.35 and looks a third of the
 * price; add the 5.80 Shree Balaji charged to bring it, and it is 8.11 —
 * dearer than Sukesh, who delivers.
 *
 * What can be paired, and what honestly cannot:
 *
 *   INWARD, PER TONNE — the transporter billed the same weight that arrived,
 *   at a rate per kilo. The weight is the evidence: 42,180 kg of limestone on
 *   the 20th and 42,180 kg of "Lime Stone Grits (Transportation)" the same day
 *   is one lorry, not a coincidence. Paired.
 *
 *   OUTWARD — "Poultry Feed" to Maheswari Road Carriers, a flat 4,550 a trip.
 *   That is finished feed going out to the farms, not raw material coming in.
 *   It must never touch an ingredient's cost. Left alone.
 *
 *   UNLOADING LABOUR — Balin Boro, 4.00 a bag across whatever came in that
 *   week. It belongs to no single consignment and splitting it by guesswork
 *   would put somebody else's bags on this material. Left alone, and reported.
 *
 *   LUMP SUMS — a trip charge with no weight on it. Unattributable unless the
 *   description names its load, which mostly it does not. Left alone.
 *
 * A pair must agree on weight to within half a percent AND fall within ten
 * days, and the goods line must be a feed material. Anything ambiguous — two
 * candidate loads, no candidate at all — is reported rather than resolved.
 *
 *   npx tsx scripts/match-inward-freight.ts
 *   npx tsx scripts/match-inward-freight.ts --write
 */
import { eq, sql } from "drizzle-orm";
import { billLines } from "@shared/schema";
import { db, pool } from "../server/db";

const write = process.argv.includes("--write");

/** Weights must agree this closely to be one lorry. */
const WEIGHT_TOLERANCE = 0.005;
/** The transporter bills within about this long of the delivery. */
const DAYS = 10;
/** Below this a quantity is a trip count or a bag count, not a weight. */
const LOOKS_LIKE_WEIGHT = 100;

interface Line {
  id: string;
  bill: string;
  date: string;
  vendor: string;
  account: string;
  item: string | null;
  itemId: string | null;
  qty: number;
  rate: number;
  amount: number;
  description: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const isOutward = (l: Line) =>
  /poultry\s*feed|outward|finished/i.test(l.description) && !/raw|material/i.test(l.description);
const isUnloadingLabour = (l: Line) => /unload|labour/i.test(l.description) || /loading/i.test(l.account);

async function main() {
  console.log(`\n  Matching inward carriage to the loads it carried — ${write ? "WRITING" : "dry run"}\n`);

  const rows = await db.execute(sql`
    SELECT bl.id, b.number AS bill, b.bill_date::text AS date, c.display_name AS vendor,
           a.name AS account, i.name AS item, bl.item_id AS "itemId",
           bl.quantity::float8 AS qty, bl.rate::float8 AS rate,
           (bl.quantity * bl.rate)::float8 AS amount,
           coalesce(nullif(trim(bl.description), ''), '') AS description,
           (a.name ILIKE '%transport%' OR a.name ILIKE '%freight%' OR a.name ILIKE '%loading%') AS is_freight,
           coalesce(i.is_feed_ingredient, false) AS is_feed
      FROM bill_lines bl
      JOIN bills b ON b.id = bl.bill_id
      JOIN contacts c ON c.id = b.vendor_id
      LEFT JOIN accounts a ON a.id = bl.account_id
      LEFT JOIN items i ON i.id = bl.item_id
     WHERE b.status <> 'void'
  `);
  const all = rows.rows as Array<Line & { is_freight: boolean; is_feed: boolean }>;
  const freight = all.filter((l) => l.is_freight);
  const goods = all.filter((l) => !l.is_freight && l.is_feed && l.qty >= LOOKS_LIKE_WEIGHT);
  console.log(`  ${freight.length} carriage line(s) against ${goods.length} feed consignment(s)\n`);

  const days = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
  const matched: Array<{ f: Line; g: Line }> = [];
  const skipped: Array<{ f: Line; why: string }> = [];

  for (const f of freight) {
    if (isOutward(f)) { skipped.push({ f, why: "outward — finished feed leaving, not material arriving" }); continue; }
    if (isUnloadingLabour(f)) { skipped.push({ f, why: "unloading labour, charged per bag across the week's intake" }); continue; }
    if (f.qty < LOOKS_LIKE_WEIGHT) { skipped.push({ f, why: "a lump sum with no weight to match on" }); continue; }

    const near = goods.filter(
      (g) => days(g.date, f.date) <= DAYS && Math.abs(g.qty - f.qty) / f.qty <= WEIGHT_TOLERANCE,
    );
    // Already carrying freight from an earlier run: leave it, do not stack.
    const fresh = near.filter((g) => !matched.some((m) => m.g.id === g.id));
    if (!fresh.length) { skipped.push({ f, why: `no consignment of ${Math.round(f.qty).toLocaleString("en-IN")} kg within ${DAYS} days` }); continue; }
    let pick = fresh;
    if (pick.length > 1) {
      // Two loads of near enough the same weight. The transporter usually
      // writes what he carried — "Lime Stone Grits (Transportation)" — so if
      // the note names one of the candidates' materials, that is the one.
      const named = pick.filter((g) => g.item && norm(f.description).includes(norm(g.item)));
      if (named.length === 1) pick = named;
    }
    if (pick.length > 1) {
      const names = [...new Set(pick.map((g) => g.item))].join(", ");
      skipped.push({ f, why: `${pick.length} loads of that weight nearby (${names}) — cannot tell which` });
      continue;
    }
    matched.push({ f, g: pick[0]! });
  }

  matched.sort((a, b) => a.g.date.localeCompare(b.g.date));
  console.log(`  PAIRED — ${matched.length}\n`);
  console.log(`  ${"load".padEnd(13)}${"date".padEnd(12)}${"material".padEnd(28)}${"kg".padStart(9)}${"goods".padStart(8)}${"carriage".padStart(10)}${"delivered".padStart(11)}`);
  let freightTotal = 0;
  for (const { f, g } of matched) {
    const landed = (g.amount + f.amount) / g.qty;
    freightTotal += f.amount;
    console.log(
      `  ${g.bill.padEnd(13)}${g.date.padEnd(12)}${(g.item ?? "").slice(0, 27).padEnd(28)}` +
        `${Math.round(g.qty).toLocaleString("en-IN").padStart(9)}${g.rate.toFixed(2).padStart(8)}` +
        `${(f.amount / g.qty).toFixed(2).padStart(10)}${landed.toFixed(2).padStart(11)}`,
    );
  }
  console.log(`\n  ${(freightTotal / 100000).toFixed(1)} lakh of carriage placed on the loads it belongs to`);

  const byReason = new Map<string, { n: number; value: number }>();
  for (const s of skipped) {
    const k = s.why.replace(/\d[\d,]*/g, "N");
    const e = byReason.get(k) ?? { n: 0, value: 0 };
    e.n++; e.value += s.f.amount;
    byReason.set(k, e);
  }
  console.log(`\n  LEFT ALONE — ${skipped.length}\n`);
  for (const [why, e] of [...byReason.entries()].sort((a, b) => b[1].value - a[1].value)) {
    console.log(`  ${String(e.n).padStart(3)}  ${(e.value / 100000).toFixed(1).padStart(5)} lakh  ${why}`);
  }

  if (!write) {
    console.log("\n  Dry run — nothing written. Re-run with --write.\n");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const { f, g } of matched) {
      // Only the costing columns. The freight is expensed on the transporter's
      // own bill and stays there; writing it onto this bill's freight_amount
      // would claim a journal entry this bill does not own, and read as if the
      // supplier had charged it.
      await tx
        .update(billLines)
        .set({
          allocatedFreight: f.amount.toFixed(2),
          landedUnitCost: ((g.amount + f.amount) / g.qty).toFixed(2),
        })
        .where(eq(billLines.id, g.id));
    }
  });
  console.log(`\n  Written: carriage and delivered cost on ${matched.length} consignment(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
