/**
 * Cutover step: move every counter past what the import already used.
 *
 *   npx tsx scripts/advance-number-series.ts             # say what would change
 *   npx tsx scripts/advance-number-series.ts --commit    # change it
 *
 * The import wrote document numbers directly, so the counters behind them never
 * moved. Bills run to BILL-001906 while the bill counter still says 1, and the
 * first bill anyone creates would be handed BILL-000001 — a number already
 * taken, and `number` is unique, so it fails at the insert.
 *
 * Only numbers that this series could itself have produced count. A bill
 * carrying its supplier's own reference, or an invoice that kept Zoho's
 * "INV-2026-27/0280", can never collide with "INV-" plus digits, so it is
 * ignored rather than parsed into a counter it has nothing to do with.
 *
 * Padding is matched to what is already on the documents: the import wrote six
 * digits, so continuing at five would put BILL-01907 next to BILL-001906.
 *
 * Safe to re-run — a counter already ahead is left alone.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

/** Where each numbered entity keeps its number. */
const TABLES: Record<string, [table: string, column: string]> = {
  bill: ["bills", "number"],
  invoice: ["invoices", "number"],
  expense: ["expenses", "number"],
  credit_note: ["credit_notes", "number"],
  customer_payment: ["customer_payments", "number"],
  vendor_payment: ["vendor_payments", "number"],
  vendor_credit: ["vendor_credits", "number"],
  purchase_order: ["purchase_orders", "number"],
  journal_entry: ["journal_entries", "entry_number"],
  attachment: ["attachments", "filing_ref"],
  fixed_asset: ["fixed_assets", "number"],
  inventory_adjustment: ["inventory_adjustments", "number"],
};

interface Change {
  entity: string;
  series: string;
  prefix: string;
  from: number;
  to: number;
  padFrom: number;
  padTo: number;
  highest: string;
}

async function main() {
  const commit = process.argv.includes("--commit");

  const series = (
    await db.execute(sql`
      SELECT ds.id, ds.entity, ds.prefix, ds.padding, ds.next_number, ns.name AS series
      FROM document_series ds JOIN number_series ns ON ns.id = ds.series_id
      ORDER BY ds.entity, ns.name`)
  ).rows as Array<{
    id: string;
    entity: string;
    prefix: string;
    padding: number;
    next_number: number;
    series: string;
  }>;

  const changes: Change[] = [];
  const alignments: Array<Change & { fromPrefix: string }> = [];
  const mismatches: string[] = [];
  const seenEntities = new Set<string>();

  for (const s of series) {
    const target = TABLES[s.entity];
    if (!target) continue;
    const [table, column] = target;

    // Numbers this series could have issued: its prefix, then digits, nothing else.
    let rows: Array<{ hi: string | null; width: number | null; used: number | null }>;
    try {
      rows = (
        await db.execute(
          sql.raw(`
            SELECT MAX((substring(${column} from ${s.prefix.length + 1}))::bigint) AS hi,
                   MAX(length(substring(${column} from ${s.prefix.length + 1}))) AS width,
                   COUNT(*) AS used
            FROM ${table}
            WHERE ${column} ~ '^${s.prefix.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[0-9]+$'`),
        )
      ).rows as never;
    } catch {
      continue; // table not present in this build
    }

    const hi = rows[0]?.hi == null ? null : Number(rows[0].hi);
    const width = rows[0]?.width == null ? s.padding : Number(rows[0].width);
    if (hi === null) continue;

    seenEntities.add(s.entity);
    if (hi + 1 > s.next_number || width > s.padding) {
      changes.push({
        entity: s.entity,
        series: s.series,
        prefix: s.prefix,
        from: s.next_number,
        to: Math.max(hi + 1, s.next_number),
        padFrom: s.padding,
        padTo: Math.max(width, s.padding),
        highest: `${s.prefix}${String(hi).padStart(width, "0")}`,
      });
    }
  }

  // Documents numbered under a prefix no series would ever produce.
  //
  // Two different cases hide here. The import gave vendor credits VC-000014
  // while their series issues VCN-, so the next one would break a run that has
  // an obvious continuation — that is worth aligning. Payments instead kept
  // Zoho's own "CP-2026-27/927", which is not a prefix and a counter at all and
  // cannot be continued; those simply start fresh on niko numbering, which is
  // what cutting over means.
  for (const [entity, [table, column]] of Object.entries(TABLES)) {
    if (seenEntities.has(entity)) continue;
    const forEntity = series.filter((s) => s.entity === entity);
    if (!forEntity.length) continue;
    let sample: { n: number; hi: string } | undefined;
    try {
      sample = (
        await db.execute(sql.raw(`SELECT COUNT(*) n, MAX(${column}) hi FROM ${table}`))
      ).rows[0] as never;
    } catch {
      continue;
    }
    if (!sample || Number(sample.n) === 0) continue;

    // Continuable only when every document shares one prefix-and-digits shape.
    const shapes = (
      await db.execute(
        sql.raw(`
          SELECT DISTINCT substring(${column} from '^([A-Za-z]+-)[0-9]+$') AS prefix
          FROM ${table}`),
      )
    ).rows as Array<{ prefix: string | null }>;
    const distinct = shapes.map((r) => r.prefix);
    const usedPrefix = distinct.length === 1 ? distinct[0] : null;

    if (usedPrefix) {
      const stats = (
        await db.execute(
          sql.raw(`
            SELECT MAX((substring(${column} from ${usedPrefix.length + 1}))::bigint) AS hi,
                   MAX(length(substring(${column} from ${usedPrefix.length + 1}))) AS width
            FROM ${table}`),
        )
      ).rows[0] as { hi: string; width: string };
      const target = forEntity.find((s) => s.series.toLowerCase().includes("default")) ?? forEntity[0]!;
      alignments.push({
        entity,
        series: target.series,
        fromPrefix: target.prefix,
        prefix: usedPrefix,
        from: target.next_number,
        to: Number(stats.hi) + 1,
        padFrom: target.padding,
        padTo: Number(stats.width),
        highest: `${usedPrefix}${String(stats.hi).padStart(Number(stats.width), "0")}`,
      });
    } else {
      mismatches.push(
        `${entity.padEnd(20)}${String(sample.n).padStart(6)} documents, highest ${sample.hi} — ` +
          `kept Zoho's numbering; new ones start at ${forEntity[0]!.prefix}${"1".padStart(forEntity[0]!.padding, "0")}`,
      );
    }
  }

  if (!changes.length) {
    console.log("Every counter is already past what the import used.");
  } else {
    console.log("Counters to advance:\n");
    console.log(
      `  ${"entity".padEnd(20)}${"series".padEnd(30)}${"highest used".padEnd(16)}${"next".padStart(8)}${"was".padStart(8)}`,
    );
    for (const c of changes) {
      const pad = c.padTo !== c.padFrom ? `  (padding ${c.padFrom} → ${c.padTo})` : "";
      console.log(
        `  ${c.entity.padEnd(20)}${c.series.padEnd(30)}${c.highest.padEnd(16)}${String(c.to).padStart(8)}${String(c.from).padStart(8)}${pad}`,
      );
    }
  }

  if (alignments.length) {
    console.log("\nSeries whose prefix the import did not use, with an obvious continuation:\n");
    for (const a of alignments) {
      console.log(
        `  ${a.entity.padEnd(20)}${a.series.padEnd(30)}${a.highest.padEnd(16)}` +
          `${a.fromPrefix} → ${a.prefix}, next ${a.to}`,
      );
    }
  }

  if (mismatches.length) {
    console.log("\nLeft alone — no counter to continue:\n");
    for (const m of mismatches) console.log(`  ${m}`);
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }
  if (!changes.length && !alignments.length) {
    await pool.end();
    return;
  }

  for (const c of changes) {
    await db.execute(sql`
      UPDATE document_series ds
      SET next_number = ${c.to}, padding = ${c.padTo}
      FROM number_series ns
      WHERE ns.id = ds.series_id
        AND ds.entity = ${c.entity}
        AND ds.prefix = ${c.prefix}
        AND ns.name = ${c.series}`);
  }
  for (const a of alignments) {
    await db.execute(sql`
      UPDATE document_series ds
      SET prefix = ${a.prefix}, next_number = ${a.to}, padding = ${a.padTo}
      FROM number_series ns
      WHERE ns.id = ds.series_id
        AND ds.entity = ${a.entity}
        AND ds.prefix = ${a.fromPrefix}
        AND ns.name = ${a.series}`);
  }
  console.log(
    `\nAdvanced ${changes.length} counter(s)` +
      (alignments.length ? `, aligned ${alignments.length} prefix(es)` : "") +
      ".",
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
