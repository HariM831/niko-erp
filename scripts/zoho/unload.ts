/**
 * Remove an imported document type so it can be loaded again.
 *
 * The loaders skip anything already in zoho_id_map, which makes a re-run cheap
 * but also makes it a no-op when the mapping itself was wrong. This is the way
 * back: it deletes the documents, the journals they posted and their id-map
 * rows together, in one transaction, so the books never sit half-unwound.
 *
 *   npx tsx scripts/zoho/unload.ts invoice --yes
 *
 * Only for migration work on books that are not yet live.
 */
import { eq, inArray } from "drizzle-orm";
import {
  invoiceLines,
  invoices,
  journalEntries,
  journalEntryLines,
  zohoIdMap,
} from "@shared/schema";
import { db, pool } from "../../server/db";

const ENTITIES = ["invoice"] as const;
type Entity = (typeof ENTITIES)[number];

async function main() {
  const entity = process.argv[2] as Entity | undefined;
  if (!entity || !ENTITIES.includes(entity)) {
    console.error(`Usage: unload.ts <${ENTITIES.join("|")}> --yes`);
    process.exitCode = 1;
    return;
  }
  if (!process.argv.includes("--yes")) {
    console.error(`This deletes every imported ${entity} and its postings. Re-run with --yes.`);
    process.exitCode = 1;
    return;
  }

  const mapped = await db
    .select({ eggsyId: zohoIdMap.eggsyId })
    .from(zohoIdMap)
    .where(eq(zohoIdMap.entity, entity));
  const ids = mapped.map((m) => m.eggsyId);
  if (!ids.length) {
    console.log(`No imported ${entity} rows.`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    // Journals first: the document holds a reference to its entry, so the
    // entry cannot go while the document still points at it.
    const entries = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(inArray(journalEntries.sourceId, ids));
    const entryIds = entries.map((e) => e.id);

    if (entity === "invoice") {
      await tx.update(invoices).set({ journalEntryId: null }).where(inArray(invoices.id, ids));
    }
    if (entryIds.length) {
      await tx.delete(journalEntryLines).where(inArray(journalEntryLines.entryId, entryIds));
      await tx.delete(journalEntries).where(inArray(journalEntries.id, entryIds));
    }
    if (entity === "invoice") {
      await tx.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, ids));
      await tx.delete(invoices).where(inArray(invoices.id, ids));
    }
    await tx.delete(zohoIdMap).where(eq(zohoIdMap.entity, entity));
    console.log(`Removed ${ids.length} ${entity}(s) and ${entryIds.length} journal entries.`);
  });

  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
