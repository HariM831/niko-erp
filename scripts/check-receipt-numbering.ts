/**
 * Checks that deleting a goods receipt hands its number back to the series.
 *
 * The easy case — delete the newest, counter steps back — is visible in the
 * UI. These are the ones that are not: several deleted at once, and a hole in
 * the middle, where naively decrementing would re-issue a number that still
 * exists and the unique index would then reject a real receipt at the gate.
 *
 * Creates and deletes its own receipts; nothing survives the run.
 *
 * Run: npx tsx scripts/check-receipt-numbering.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { documentSeries, locations, numberSeries, officeReceipts } from "@shared/schema";
import { db } from "../server/db";
import { nextDocumentNumber, resyncDocumentNumber } from "../server/lib/numbering";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};

const ENTITY = "office_receipt";

async function nextNumberOf(): Promise<number> {
  const [defaultSeries] = await db
    .select({ id: numberSeries.id })
    .from(numberSeries)
    .where(eq(numberSeries.isDefault, true))
    .limit(1);
  const [row] = await db
    .select({ n: documentSeries.nextNumber })
    .from(documentSeries)
    .where(and(eq(documentSeries.entity, ENTITY), eq(documentSeries.seriesId, defaultSeries!.id)));
  return row!.n;
}

async function main() {
  const [site] = await db.select({ id: locations.id }).from(locations).limit(1);
  if (!site) throw new Error("No location to attach a receipt to");

  const startedAt = await nextNumberOf();
  console.log(`  series starts at ${startedAt}\n`);
  const created: Array<{ id: string; number: string }> = [];

  // Three receipts in a row.
  for (let i = 0; i < 3; i++) {
    const row = await db.transaction(async (tx) => {
      const number = await nextDocumentNumber(tx, ENTITY);
      const [r] = await tx
        .insert(officeReceipts)
        .values({ number, locationId: site.id, vehicleNumber: `SELFTEST${i}` })
        .returning({ id: officeReceipts.id, number: officeReceipts.number });
      return r!;
    });
    created.push(row);
  }
  check("three receipts claimed three numbers", (await nextNumberOf()) === startedAt + 3,
    `next=${await nextNumberOf()}`);

  // Deleting the middle one must NOT move the counter — the highest still exists.
  await db.transaction(async (tx) => {
    await tx.delete(officeReceipts).where(eq(officeReceipts.id, created[1]!.id));
    await resyncDocumentNumber(tx, ENTITY);
  });
  check("a hole in the middle leaves the counter alone", (await nextNumberOf()) === startedAt + 3,
    `next=${await nextNumberOf()}`);

  // Deleting the newest now collapses the counter past the hole as well: only
  // the first receipt is left, so the next number is the one after it.
  await db.transaction(async (tx) => {
    await tx.delete(officeReceipts).where(eq(officeReceipts.id, created[2]!.id));
    await resyncDocumentNumber(tx, ENTITY);
  });
  check("deleting the newest reclaims it and the hole below it",
    (await nextNumberOf()) === startedAt + 1, `next=${await nextNumberOf()}`);

  // Running it again changes nothing.
  await db.transaction(async (tx) => resyncDocumentNumber(tx, ENTITY));
  check("resync is idempotent", (await nextNumberOf()) === startedAt + 1, `next=${await nextNumberOf()}`);

  // Delete the rest in one go — the counter must land all the way back.
  await db.transaction(async (tx) => {
    await tx
      .delete(officeReceipts)
      .where(inArray(officeReceipts.id, created.map((c) => c.id)));
    await resyncDocumentNumber(tx, ENTITY);
  });
  check("a bulk delete winds the counter fully back", (await nextNumberOf()) === startedAt,
    `next=${await nextNumberOf()}`);

  const left = await db
    .select({ id: officeReceipts.id })
    .from(officeReceipts)
    .where(inArray(officeReceipts.id, created.map((c) => c.id)));
  check("no test receipts survive", left.length === 0, `${left.length} left`);

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed ? 1 : 0);
}

void main();
