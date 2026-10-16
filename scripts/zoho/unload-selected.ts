/**
 * Unload named documents, so the loader can put them back from Zoho.
 *
 *   npx tsx scripts/zoho/unload-selected.ts invoice numbers.txt
 *   npx tsx scripts/zoho/unload-selected.ts customer_payment numbers.txt --yes
 *
 * unload.ts takes a whole entity — every imported invoice, every imported
 * receipt — and says plainly that it is for books which are not yet live.
 * Production is live now, and two jobs need a handful of documents rebuilt
 * rather than all of them:
 *
 *   SEVEN INVOICES hold a different amount here from the one Zoho has for the
 *   same invoice, same customer, same day. A-INV-EG-27-0177 and 0211 have
 *   their amounts transposed between them; 0702 is exactly double here. The
 *   amount cannot be corrected in place without rewriting the lines and
 *   re-posting the journal, which is the loader's job, done properly, already.
 *
 *   FOUR HUNDRED AND FIFTEEN RECEIPTS are allocated across invoices differently
 *   from Zoho, which the user settled on 16 Oct 2026: Zoho wins. The cash and
 *   the customer balance already agree; only which invoice each rupee settles
 *   differs. An application carries a ledger posting of its own, so moving one
 *   means re-posting the receipt, not editing a row.
 *
 * An invoice is NOT unloaded while a receipt is applied to it. Deleting the
 * application would leave the receipt's journal claiming to have settled
 * something that no longer exists, and the receipt's unapplied balance wrong.
 * The script names the receipts to unload first and stops.
 *
 * Nothing is written without --yes, and the document numbers are niko's, not
 * Zoho's, because those are what a person can check on screen.
 */
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import {
  customerPayments, invoiceLines, invoices, journalEntries, journalEntryLines,
  paymentApplications, zohoIdMap,
} from "@shared/schema";
import { db, pool } from "../../server/db";

const ENTITIES = ["invoice", "customer_payment"] as const;
type Entity = (typeof ENTITIES)[number];

async function main() {
  const args = process.argv.slice(2);
  const entity = args[0] as Entity | undefined;
  const file = args[1];
  const yes = args.includes("--yes");
  if (!entity || !ENTITIES.includes(entity) || !file || file.startsWith("--")) {
    console.error(`Usage: unload-selected.ts <${ENTITIES.join("|")}> <file of niko numbers> [--yes]`);
    process.exitCode = 1;
    return;
  }
  const numbers = [...new Set(
    readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
  )];
  console.log(`\n  ${numbers.length} ${entity}(s) from ${file} — ${yes ? "REMOVING" : "dry run"}\n`);

  const table = entity === "invoice" ? invoices : customerPayments;
  const rows = await db
    .select({ id: table.id, number: table.number })
    .from(table)
    .where(inArray(table.number, numbers));
  const found = new Set(rows.map((r) => r.number));
  const missing = numbers.filter((n) => !found.has(n));
  if (missing.length) {
    console.log(`  not in the database (${missing.length}): ${missing.slice(0, 8).join(", ")}`);
    throw new Error("every named document must exist; nothing removed");
  }
  const ids = rows.map((r) => r.id);

  // Only documents that came from Zoho may be unloaded: one without a mapping
  // was raised here, and the loader has nothing to put back in its place.
  const mapped = new Set(
    (await db
      .select({ eggsyId: zohoIdMap.eggsyId })
      .from(zohoIdMap)
      .where(and(eq(zohoIdMap.entity, entity), inArray(zohoIdMap.eggsyId, ids)))
    ).map((m) => m.eggsyId),
  );
  const home = rows.filter((r) => !mapped.has(r.id));
  if (home.length) {
    console.log(`  raised in niko, not imported — nothing to reload them from:`);
    for (const r of home.slice(0, 10)) console.log(`    ${r.number}`);
    throw new Error("refusing; remove those from the list");
  }

  if (entity === "invoice") {
    const held = await db
      .select({ invoice: invoices.number, payment: customerPayments.number,
                amount: paymentApplications.amountApplied })
      .from(paymentApplications)
      .innerJoin(invoices, eq(invoices.id, paymentApplications.invoiceId))
      .innerJoin(customerPayments, eq(customerPayments.id, paymentApplications.paymentId))
      .where(inArray(paymentApplications.invoiceId, ids));
    if (held.length) {
      console.log(`  ${held.length} receipt application(s) point at these invoices. Unload the receipts first:\n`);
      for (const h of held) {
        console.log(`    ${h.invoice}  <-  ${h.payment}  ${Number(h.amount).toLocaleString("en-IN")}`);
      }
      console.log(`\n    npx tsx scripts/zoho/unload-selected.ts customer_payment <those receipts> --yes`);
      throw new Error("refusing while a receipt is applied");
    }
  }

  const entries = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(inArray(journalEntries.sourceId, ids));
  console.log(`  ${rows.length} document(s), ${entries.length} journal entr(ies) to remove`);
  for (const r of rows.slice(0, 10)) console.log(`    ${r.number}`);
  if (rows.length > 10) console.log(`    ... and ${rows.length - 10} more`);

  if (!yes) {
    console.log("\n  Dry run — nothing removed. Re-run with --yes.\n");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    const entryIds = entries.map((e) => e.id);
    // The document points at its entry, so the reference goes before the entry.
    if (entity === "invoice") {
      await tx.update(invoices).set({ journalEntryId: null }).where(inArray(invoices.id, ids));
    } else {
      await tx.update(customerPayments).set({ journalEntryId: null }).where(inArray(customerPayments.id, ids));
    }
    if (entryIds.length) {
      await tx.delete(journalEntryLines).where(inArray(journalEntryLines.entryId, entryIds));
      await tx.delete(journalEntries).where(inArray(journalEntries.id, entryIds));
    }
    if (entity === "invoice") {
      await tx.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, ids));
      await tx.delete(invoices).where(inArray(invoices.id, ids));
    } else {
      await tx.delete(paymentApplications).where(inArray(paymentApplications.paymentId, ids));
      await tx.delete(customerPayments).where(inArray(customerPayments.id, ids));
    }
    await tx.delete(zohoIdMap).where(and(eq(zohoIdMap.entity, entity), inArray(zohoIdMap.eggsyId, ids)));
  });
  console.log(`\n  Removed ${rows.length} ${entity}(s) and ${entries.length} journal entr(ies).`);
  console.log(`  Re-load them with the matching loader and --dir.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
