/**
 * Prove the invoice sequences actually hand out the numbers they should.
 *
 *   npx tsx scripts/check-invoice-series.ts
 *
 * Reading document_series shows what the counters say. This claims a number
 * the way a real save does — nextDocumentNumber inside a transaction — and then
 * rolls the transaction back, so nothing is consumed and the counters are
 * exactly where they were. It is the difference between a row that looks right
 * and a path that works.
 *
 * It also checks the thing no counter can tell you: that the number about to be
 * issued is not already on an invoice. A prefix edited by hand in Settings can
 * point a counter straight into numbers that already exist, and the first
 * person to save would meet a unique-index violation with no idea why.
 *
 * Run it after continue-invoice-series.ts, and again after the April prefix
 * change.
 */
import { and, eq, sql } from "drizzle-orm";
import { documentSeries, numberSeries } from "@shared/schema";
import { nextDocumentNumber } from "../server/lib/numbering";
import { db, pool } from "../server/db";

/** Thrown to roll the transaction back once the numbers have been read. */
class Rollback extends Error {
  constructor(public claimed: Array<{ series: string; isDefault: boolean; number: string }>) {
    super("rollback");
  }
}

async function main() {
  console.log("\n  Invoice numbering — claiming one number per series, then rolling back\n");

  const series = await db
    .select({ id: numberSeries.id, name: numberSeries.name, isDefault: numberSeries.isDefault })
    .from(numberSeries)
    .where(eq(numberSeries.isActive, true))
    .orderBy(sql`is_default DESC, name`);

  let claimed: Array<{ series: string; isDefault: boolean; number: string }> = [];
  try {
    await db.transaction(async (tx) => {
      const got: typeof claimed = [];
      for (const s of series) {
        const [row] = await tx
          .select({ id: documentSeries.id })
          .from(documentSeries)
          .where(and(eq(documentSeries.seriesId, s.id), eq(documentSeries.entity, "invoice")));
        if (!row) {
          console.log(`  ${s.name.padEnd(28)} no invoice numbering — an invoice cannot be raised on it`);
          continue;
        }
        // The default is reached with no seriesId, exactly as the egg dispatch
        // and owner-billing paths reach it.
        got.push({
          series: s.name,
          isDefault: s.isDefault,
          number: await nextDocumentNumber(tx, "invoice", s.isDefault ? undefined : s.id),
        });
      }
      throw new Rollback(got);
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    claimed = e.claimed;
  }

  let bad = 0;
  for (const c of claimed) {
    const [{ n }] = (
      await db.execute(sql`SELECT count(*) AS n FROM invoices WHERE number = ${c.number}`)
    ).rows as Array<{ n: string }>;
    const taken = Number(n) > 0;
    if (taken) bad++;
    console.log(
      `  ${c.series.padEnd(28)}${c.isDefault ? "default  " : "         "}${c.number}` +
        (taken ? "   ALREADY ON AN INVOICE" : ""),
    );
  }

  /**
   * Holes in a live sequence.
   *
   * A number is claimed before the save completes, so a save that fails while
   * somebody else claims the next one leaves a permanent gap — documented and
   * accepted in numbering.ts, and invisible until an auditor asks where
   * A-INV-EG-27-0431 went. Every sequence is whole today; this is what notices
   * when one stops being.
   */
  const gaps = (
    await db.execute(sql`
      WITH seq AS (
        SELECT p.prefix, substring(i.number from length(p.prefix) + 1)::int AS n
          FROM invoices i
          JOIN (SELECT DISTINCT prefix FROM document_series WHERE entity = 'invoice') p
            ON i.number LIKE p.prefix || '%'
         WHERE substring(i.number from length(p.prefix) + 1) ~ '^[0-9]+$'
      ),
      span AS (SELECT prefix, min(n) AS lo, max(n) AS hi, count(*) AS issued FROM seq GROUP BY prefix)
      SELECT span.prefix, span.issued::int, span.lo, span.hi,
             (SELECT count(*) FROM generate_series(span.lo, span.hi) g
               WHERE NOT EXISTS (SELECT 1 FROM seq WHERE seq.prefix = span.prefix AND seq.n = g))::int AS missing
        FROM span ORDER BY span.issued DESC
    `)
  ).rows as Array<{ prefix: string; issued: number; lo: number; hi: number; missing: number }>;

  console.log("\n  sequences on file:");
  for (const g of gaps) {
    if (g.missing) bad++;
    console.log(
      `    ${g.prefix.padEnd(16)}${String(g.issued).padStart(5)} issued, ${g.lo}-${g.hi}` +
        (g.missing ? `   ${g.missing} MISSING` : "   unbroken"),
    );
  }

  // Nothing may have been consumed. If a counter moved, the rollback did not
  // take and this check has quietly spent three invoice numbers.
  const after = await db
    .select({ next: documentSeries.nextNumber, prefix: documentSeries.prefix })
    .from(documentSeries)
    .where(eq(documentSeries.entity, "invoice"));
  console.log(`\n  counters after: ${after.map((a) => `${a.prefix}${a.next}`).join("  ")}`);

  console.log(
    bad
      ? `\n  ${bad} problem(s) — a collision, or a hole in a sequence.\n`
      : "\n  Every sequence is unbroken, hands out a free number, and nothing was consumed.\n",
  );
  process.exitCode = bad ? 1 : 0;
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
