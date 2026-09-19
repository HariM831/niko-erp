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

  // Nothing may have been consumed. If a counter moved, the rollback did not
  // take and this check has quietly spent three invoice numbers.
  const after = await db
    .select({ next: documentSeries.nextNumber, prefix: documentSeries.prefix })
    .from(documentSeries)
    .where(eq(documentSeries.entity, "invoice"));
  console.log(`\n  counters after: ${after.map((a) => `${a.prefix}${a.next}`).join("  ")}`);

  console.log(
    bad
      ? `\n  ${bad} sequence(s) would collide with an invoice already on file.\n`
      : "\n  Every sequence hands out a free number, and nothing was consumed.\n",
  );
  process.exitCode = bad ? 1 : 0;
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
