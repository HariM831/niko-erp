/**
 * Wipe every transaction and master record, then rebuild from the seed so the
 * books sit on the real Amino chart of accounts. Keeps users, roles and the
 * document-numbering series. Intended for pre-go-live resets only.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const TABLES = [
  // Children before parents.
  "payment_applications",
  "vendor_payment_applications",
  "vendor_credit_applications",
  "invoice_lines",
  "credit_note_lines",
  "estimate_lines",
  "sales_order_lines",
  "bill_lines",
  "purchase_order_lines",
  "vendor_credit_lines",
  "journal_entry_lines",
  "bank_transactions",
  "attachments",
  "comments",
  "customer_payments",
  "vendor_payments",
  "credit_notes",
  "vendor_credits",
  "invoices",
  // sales_orders references estimates; bills reference purchase_orders.
  "sales_orders",
  "estimates",
  "bills",
  "purchase_orders",
  "expenses",
  "journal_entries",
  "bank_accounts",
  "items",
  "contact_persons",
  "contact_addresses",
  "contacts",
  "accounts",
];

async function main() {
  await db.transaction(async (tx) => {
    // Self-referencing FKs (journal reversals, account parents) block plain deletes.
    await tx.execute(sql`UPDATE journal_entries SET reverses_entry_id = NULL`);
    await tx.execute(sql`UPDATE accounts SET parent_id = NULL`);
    for (const t of TABLES) {
      await tx.execute(sql.raw(`DELETE FROM "${t}"`));
    }
    // Restart numbering so the fresh books begin at 1.
    await tx.execute(sql`UPDATE document_series SET next_number = 1`);
  });
  console.log("Cleared all transactions, contacts, items and accounts.");
  await pool.end();
  process.exit(0);
}
main();
