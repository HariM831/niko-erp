/**
 * Cutover step: carry on the invoice numbering the business already uses.
 *
 *   npx tsx scripts/continue-invoice-series.ts            # say what would change
 *   npx tsx scripts/continue-invoice-series.ts --apply    # change it
 *
 * Run AFTER the Zoho load and after advance-number-series.ts.
 *
 * The Zoho loader keeps an invoice's own number, so 802 invoices arrived as
 * A-INV-EG-27-0001 to 0802 with nothing behind them: the invoice counter is
 * untouched, and advance-number-series cannot help because "A-INV-EG-27-0802"
 * is not "INV-" plus digits and it will not parse a counter out of a number
 * some other system minted. Left alone, the next invoice raised here would be
 * INV-00002 and a sequence the farm has run all year would simply stop.
 *
 * Three sequences are live in 2026-27, and they are a business split rather
 * than a numbering convenience — EG eggs, FD feed, BD birds.
 *
 *   EGGS  is the default series. Egg dispatch invoices and owner billing call
 *   nextDocumentNumber without naming a series (server/services/egg-sales.ts
 *   and owner-billing.ts), so they take whichever is default. Eggs are 802 of
 *   the 818 invoices on file; making the default series carry the EG prefix is
 *   what keeps that path correct without touching the code.
 *
 *   FEED and BIRDS are separate series, chosen on the invoice form. They are
 *   given a numbering row for invoices ONLY. Picking one for a bill or an
 *   expense then fails with "No numbering is configured" — which is the right
 *   answer, because these series exist to continue an invoice sequence and
 *   nothing else. The alternative, a full set of tagged counters, would let a
 *   mis-picked series quietly open a second bill sequence in the books.
 *
 * THE YEAR IS IN THE PREFIX AND DOES NOT ROLL OVER. "A-INV-EG-27-" is a literal
 * string; nothing in niko computes a financial year. In April the prefix has to
 * be changed to -28- and the counter set back to 1, here or in Settings.
 *
 * Counters are read from the invoices actually on file, never hardcoded, so
 * this lands correctly whatever the production load turns out to hold. Safe to
 * re-run: a counter already at or past where it should be is left alone.
 */
import { and, eq, sql } from "drizzle-orm";
import { documentSeries, numberSeries } from "@shared/schema";
import { db, pool } from "../server/db";

const APPLY = process.argv.includes("--apply");

/** The sequences the farm runs, and which series carries each. */
const SEQUENCES = [
  { prefix: "A-INV-EG-27-", padding: 4, what: "eggs", series: null },
  { prefix: "A-INV-FD-27-", padding: 4, what: "feed", series: "Feed" },
  { prefix: "A-INV-BD-27-", padding: 4, what: "birds", series: "Birds" },
] as const;

/** The highest number already issued under a prefix, and how wide it was written. */
async function highest(prefix: string) {
  const from = sql`${prefix.length + 1}::int`;
  const r = await db.execute(sql`
    SELECT coalesce(max(substring(number from ${from})::bigint), 0) AS seq,
           coalesce(max(length(substring(number from ${from}))), 0) AS width,
           count(*) AS n
      FROM invoices
     WHERE number LIKE ${`${prefix}%`}
       AND substring(number from ${from}) ~ '^[0-9]+$'
  `);
  const row = r.rows[0] as { seq: string; width: string; n: string };
  return { seq: Number(row.seq), width: Number(row.width), n: Number(row.n) };
}

async function main() {
  console.log(`\n  Invoice numbering — ${APPLY ? "WRITING" : "dry run"}\n`);

  const [def] = await db
    .select({ id: numberSeries.id, name: numberSeries.name })
    .from(numberSeries)
    .where(eq(numberSeries.isDefault, true));
  if (!def) throw new Error("no default number series — nothing to hang the egg sequence on");

  // What the current invoice numbering would hand out next, so the report can
  // say plainly what is being left behind.
  const [current] = await db
    .select({ prefix: documentSeries.prefix, next: documentSeries.nextNumber, padding: documentSeries.padding })
    .from(documentSeries)
    .where(and(eq(documentSeries.seriesId, def.id), eq(documentSeries.entity, "invoice")));
  if (!current) throw new Error(`the default series "${def.name}" has no invoice numbering row`);

  const plan: Array<{ what: string; seriesName: string; seriesId: string | null; prefix: string; next: number; padding: number; from: string }> = [];
  let abandoned = 0;

  for (const s of SEQUENCES) {
    const h = await highest(s.prefix);
    if (!h.n) {
      console.log(`  ${s.what.padEnd(6)} no invoice on file under ${s.prefix} — skipped`);
      continue;
    }
    const padding = Math.max(h.width, s.padding);
    const next = h.seq + 1;

    if (s.series === null) {
      // The eggs sequence rides the default series.
      const already = current.prefix === s.prefix && current.next >= next;
      console.log(
        `  ${s.what.padEnd(6)} ${String(h.n).padStart(4)} invoices, highest ${s.prefix}${String(h.seq).padStart(padding, "0")}` +
          `  ->  ${def.name}` +
          (already ? "  (already continuing)" : ""),
      );
      if (already) continue;
      if (current.prefix !== s.prefix) {
        const [{ n }] = (await db.execute(sql`
          SELECT count(*) AS n FROM invoices WHERE number LIKE ${`${current.prefix}%`}
        `)).rows as Array<{ n: string }>;
        abandoned = Number(n);
      }
      plan.push({ what: s.what, seriesName: def.name, seriesId: def.id, prefix: s.prefix, next, padding, from: `${current.prefix} at ${current.next}` });
      continue;
    }

    const [existing] = await db
      .select({ id: numberSeries.id })
      .from(numberSeries)
      .where(eq(numberSeries.name, s.series));
    const row = existing
      ? (
          await db
            .select({ prefix: documentSeries.prefix, next: documentSeries.nextNumber })
            .from(documentSeries)
            .where(and(eq(documentSeries.seriesId, existing.id), eq(documentSeries.entity, "invoice")))
        )[0]
      : undefined;
    const already = row?.prefix === s.prefix && row.next >= next;
    console.log(
      `  ${s.what.padEnd(6)} ${String(h.n).padStart(4)} invoices, highest ${s.prefix}${String(h.seq).padStart(padding, "0")}` +
        `  ->  ${s.series}${existing ? "" : " (new series)"}` +
        (already ? "  (already continuing)" : ""),
    );
    if (already) continue;
    plan.push({ what: s.what, seriesName: s.series, seriesId: existing?.id ?? null, prefix: s.prefix, next, padding, from: existing ? `${row?.prefix} at ${row?.next}` : "nothing" });
  }

  if (!plan.length) {
    console.log("\n  Every sequence is already being continued. Nothing to do.\n");
    await pool.end();
    return;
  }

  console.log("\n  Would set:\n");
  for (const p of plan) {
    console.log(`    ${p.seriesName.padEnd(28)} invoice  ${p.prefix}  next ${p.next}, padding ${p.padding}    (was ${p.from})`);
  }
  if (abandoned) {
    console.log(
      `\n  ${abandoned} invoice(s) already carry the ${current.prefix} numbering the default series` +
        ` is leaving behind. They keep their numbers; nothing is renumbered.`,
    );
  }
  console.log(
    `\n  Reminder: the financial year sits in the prefix as a literal "-27-".` +
      `\n  In April it has to become -28- and every counter go back to 1.`,
  );

  if (!APPLY) {
    console.log("\n  Dry run — nothing written. Re-run with --apply.\n");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const p of plan) {
      let seriesId = p.seriesId;
      if (!seriesId) {
        const [made] = await tx.insert(numberSeries).values({ name: p.seriesName }).returning({ id: numberSeries.id });
        seriesId = made!.id;
      }
      // Invoices only, deliberately — see the header. onConflictDoUpdate so a
      // re-run corrects the row rather than tripping the (series, entity) index.
      await tx
        .insert(documentSeries)
        .values({ seriesId, entity: "invoice", prefix: p.prefix, nextNumber: p.next, padding: p.padding })
        .onConflictDoUpdate({
          target: [documentSeries.seriesId, documentSeries.entity],
          set: { prefix: p.prefix, nextNumber: p.next, padding: p.padding },
        });
      console.log(`  ${p.seriesName.padEnd(28)} ${p.prefix}${String(p.next).padStart(p.padding, "0")} next`);
    }
  });

  console.log(`\n  Done: ${plan.length} sequence(s) continuing.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
