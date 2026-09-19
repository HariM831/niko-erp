/**
 * Does voiding a document give its number back?
 *
 *   npx tsx scripts/check-void-numbering.ts
 *
 * The answer should be no, for every document type except office receipts, and
 * the reason matters: a number that has been quoted to a supplier must never
 * appear twice, even if the document carrying it was voided an hour later. A
 * void bill still says BILL-002097 on somebody's desk.
 *
 * Reading the void route tells you it only sets a status. This exercises the
 * one mechanism that could ever hand a number back — resyncDocumentNumber —
 * and shows it refusing for bills and working for receipts, so the refusal is
 * demonstrated rather than assumed.
 *
 * Nothing real is touched. The counters are exercised on a scratch series that
 * is deleted at the end, and every resync runs inside a transaction that is
 * rolled back, because resyncDocumentNumber works across every series for an
 * entity and must never be let near the real ones from a test.
 */
import { eq, sql } from "drizzle-orm";
import { documentSeries, numberSeries } from "@shared/schema";
import { nextDocumentNumber, resyncDocumentNumber } from "../server/lib/numbering";
import { db, pool } from "../server/db";

const SCRATCH = "zz-check-void-numbering";
/** Prefixes no real document uses, so a resync scanning by prefix finds none. */
const BILL_PREFIX = "ZZVOIDBILL-";
const RECEIPT_PREFIX = "ZZVOIDRCPT-";

class Rollback extends Error {}

async function counter(entity: string, seriesId: string) {
  const [row] = await db
    .select({ next: documentSeries.nextNumber })
    .from(documentSeries)
    .where(sql`${documentSeries.entity} = ${entity} AND ${documentSeries.seriesId} = ${seriesId}`);
  return row?.next ?? 0;
}

/** Run something and throw it away, whatever it did. */
async function rolledBack(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function main() {
  console.log("\n  Does a void give the number back?\n");

  // ── the real data, first ────────────────────────────────────────────────
  const facts = (
    await db.execute(sql`
      SELECT (SELECT count(*) FROM bills WHERE status = 'void') AS void_bills,
             (SELECT count(*) FROM invoices WHERE status = 'void') AS void_invoices,
             (SELECT count(*) - count(DISTINCT number) FROM bills) AS bill_dupes,
             (SELECT count(*) - count(DISTINCT number) FROM invoices) AS invoice_dupes
    `)
  ).rows[0] as Record<string, string>;
  console.log(
    `  on file: ${facts.void_bills} void bill(s), ${facts.void_invoices} void invoice(s), ` +
      `${facts.bill_dupes} duplicate bill number(s), ${facts.invoice_dupes} duplicate invoice number(s)`,
  );

  // ── a scratch series to exercise the counters on ────────────────────────
  await db.delete(numberSeries).where(eq(numberSeries.name, SCRATCH));
  const [scratch] = await db.insert(numberSeries).values({ name: SCRATCH }).returning({ id: numberSeries.id });
  const id = scratch!.id;
  let failures = 0;
  const check = (ok: boolean, said: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${said}`);
  };

  try {
    await db.insert(documentSeries).values([
      { seriesId: id, entity: "bill", prefix: BILL_PREFIX, padding: 5 },
      { seriesId: id, entity: "office_receipt", prefix: RECEIPT_PREFIX, padding: 5 },
    ]);

    // Three bills issued and committed, as three real saves would.
    const issued: string[] = [];
    for (let i = 0; i < 3; i++) {
      issued.push(await db.transaction((tx) => nextDocumentNumber(tx, "bill", id)));
    }
    console.log(`\n  issued ${issued.join(", ")}`);
    check((await counter("bill", id)) === 4, `the bill counter stands at 4 after three saves`);

    /**
     * A void is a status change, so the closest thing to "give it back" that
     * exists in the codebase is a resync. For bills it must do nothing at all.
     */
    await rolledBack(async (tx) => {
      await resyncDocumentNumber(tx, "bill");
      const [row] = await tx
        .select({ next: documentSeries.nextNumber })
        .from(documentSeries)
        .where(sql`${documentSeries.entity} = 'bill' AND ${documentSeries.seriesId} = ${id}`);
      check(row?.next === 4, `a resync leaves the bill counter at 4 — the number is held, not returned`);
    });

    // The contrast: receipts are the one type that does reclaim, so the check
    // above is a refusal rather than a mechanism that simply never works.
    for (let i = 0; i < 3; i++) {
      await db.transaction((tx) => nextDocumentNumber(tx, "office_receipt", id));
    }
    await rolledBack(async (tx) => {
      await resyncDocumentNumber(tx, "office_receipt");
      const [row] = await tx
        .select({ next: documentSeries.nextNumber })
        .from(documentSeries)
        .where(sql`${documentSeries.entity} = 'office_receipt' AND ${documentSeries.seriesId} = ${id}`);
      check(row?.next === 1, `the same resync winds receipts back to 1 — so it works, and declines bills on purpose`);
    });

    // A save that fails releases its number, which is a different thing from a
    // void: nothing was ever issued to anybody.
    const before = await counter("bill", id);
    await rolledBack(async (tx) => {
      await nextDocumentNumber(tx, "bill", id);
    });
    check((await counter("bill", id)) === before, `a save that rolls back releases its number (counter still ${before})`);
  } finally {
    await db.delete(numberSeries).where(eq(numberSeries.id, id));
  }

  // Nothing real may have moved.
  const real = await db.execute(sql`
    SELECT ns.name, ds.entity, ds.prefix, ds.next_number
      FROM document_series ds JOIN number_series ns ON ns.id = ds.series_id
     WHERE ds.entity IN ('bill', 'office_receipt') ORDER BY ns.name, ds.entity
  `);
  console.log("\n  real counters, untouched:");
  for (const r of real.rows as Array<Record<string, string>>) {
    console.log(`    ${String(r.name).padEnd(28)}${String(r.entity).padEnd(16)}${r.prefix}${r.next_number}`);
  }

  console.log(
    failures
      ? `\n  ${failures} check(s) failed.\n`
      : "\n  A voided bill keeps its number. Only office receipts ever reclaim one.\n",
  );
  process.exitCode = failures ? 1 : 0;
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
