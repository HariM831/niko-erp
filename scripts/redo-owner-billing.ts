/**
 * Void a month's owner documents and clear the run, so it can be raised again.
 *
 * Voided, never deleted: the invoice and the bill have posted to the ledger, and
 * a void writes the reversing entry that takes them back out. Deleting the rows
 * would leave the journals behind and the books would not balance.
 *
 * The numbers are spent either way — INV-000010 stays INV-000010 and stays
 * void. That is what a document number is for.
 *
 * The steps mirror the void routes in sales.ts and purchases.ts, including
 * taking stock back out for tracked bill lines: the void reverses the debit to
 * the stock account, so leaving the quantity behind would have Stock on Hand
 * claiming goods the ledger says were never bought.
 *
 *   npx tsx scripts/redo-owner-billing.ts --period 2026-08
 *   npx tsx scripts/redo-owner-billing.ts --period 2026-08 --owner Luit
 */
import { unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  attachments,
  billLines,
  bills,
  contacts,
  invoices,
  items,
  ownerBillingRuns,
} from "@shared/schema";
import { db } from "../server/db";
import { mainStore, moveStock } from "../server/services/inventory";
import { reverseJournal } from "../server/services/posting";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const period = arg("period");
const only = arg("owner");

if (!period) {
  console.log("\n  --period is required, e.g. --period 2026-08\n");
  process.exit(1);
}

const userId = ((await db.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
const from = `${period.slice(0, 7)}-01`;

const runs = await db
  .select({ run: ownerBillingRuns, name: contacts.displayName })
  .from(ownerBillingRuns)
  .innerJoin(contacts, eq(contacts.id, ownerBillingRuns.contactId))
  .where(eq(ownerBillingRuns.period, from));

if (!runs.length) {
  console.log(`\n  nothing raised for ${period.slice(0, 7)}\n`);
  process.exit(0);
}

for (const { run, name } of runs) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) continue;
  console.log(`\n  ${name} — ${from.slice(0, 7)}`);

  // The attachments first: they explain documents that are about to become
  // void, and a void invoice carrying a statement that still adds up is worse
  // than one carrying none.
  const docIds = [run.feedInvoiceId, run.birdInvoiceId, run.billId].filter(Boolean) as string[];
  if (docIds.length) {
    const att = await db.select().from(attachments).where(inArray(attachments.entityId, docIds));
    for (const a of att) {
      await unlink(path.resolve(process.cwd(), "uploads", a.storedName)).catch(() => {});
      await db.delete(attachments).where(eq(attachments.id, a.id));
    }
    if (att.length) console.log(`    removed ${att.length} attachment(s)`);
  }

  // Feed and pullets are separate invoices; both come off.
  let blocked = false;
  for (const [label, id] of [
    ["feed", run.feedInvoiceId],
    ["pullet", run.birdInvoiceId],
  ] as const) {
    if (!id) continue;
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    if (!inv) {
      console.log(`    ${label} invoice is already gone`);
    } else if (inv.status === "void") {
      console.log(`    ${label} invoice ${inv.number} was already void`);
    } else if (Number(inv.balanceDue) !== Number(inv.total)) {
      console.log(`    ! ${inv.number} has payments applied — unapply them first, skipping`);
      blocked = true;
    } else {
      await db.transaction(async (tx) => {
        if (inv.journalEntryId) {
          await reverseJournal(tx, inv.journalEntryId, inv.invoiceDate, userId);
        }
        await tx
          .update(invoices)
          .set({ status: "void", balanceDue: "0.00", updatedAt: new Date() })
          .where(eq(invoices.id, inv.id));
      });
      console.log(`    voided ${label} invoice ${inv.number}`);
    }
  }
  if (blocked) continue;

  if (run.billId) {
    const [bl] = await db.select().from(bills).where(eq(bills.id, run.billId));
    if (!bl) {
      console.log("    bill is already gone");
    } else if (bl.status === "void") {
      console.log(`    bill ${bl.number} was already void`);
    } else if (Number(bl.balanceDue) !== Number(bl.total)) {
      console.log(`    ! ${bl.number} has payments applied — unapply them first, skipping`);
      continue;
    } else {
      await db.transaction(async (tx) => {
        // Both the goods entry and any separate freight entry come back off.
        for (const je of [bl.journalEntryId, bl.freightJournalEntryId]) {
          if (je) await reverseJournal(tx, je, bl.billDate, userId);
        }
        await tx
          .update(bills)
          .set({ status: "void", balanceDue: "0.00", updatedAt: new Date() })
          .where(eq(bills.id, bl.id));

        const stockBack = await tx
          .select({ itemId: billLines.itemId, quantity: billLines.quantity, amount: billLines.amount })
          .from(billLines)
          .innerJoin(items, eq(items.id, billLines.itemId))
          .where(and(eq(billLines.billId, bl.id), eq(items.trackInventory, true)));
        const movements = stockBack
          .filter((l) => Number(l.amount) > 0 && l.itemId)
          .map((l) => ({
            itemId: l.itemId!,
            quantity: `-${Number(l.quantity).toFixed(3)}`,
            value: `-${Number(l.amount).toFixed(2)}`,
          }));
        if (movements.length) {
          await moveStock(tx, {
            movements,
            transactionDate: bl.billDate,
            sourceType: "bill",
            sourceId: bl.id,
            stockLocationId: await mainStore(tx),
          });
        }
      });
      console.log(`    voided bill ${bl.number}`);
    }
  }

  // Last, so a failure above leaves the month still marked as billed rather
  // than open for a second raise on top of live documents.
  await db
    .delete(ownerBillingRuns)
    .where(and(eq(ownerBillingRuns.contactId, run.contactId), eq(ownerBillingRuns.period, from)));
  console.log(`    ${from.slice(0, 7)} is open to be raised again`);
}

console.log("");
process.exit(0);
