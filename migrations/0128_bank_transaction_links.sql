-- A statement line can stand for several journals that add up to it (Zoho's
-- multi-select match), and a line that created its own document is told apart
-- from one paired with a document already in the books, so uncategorizing can
-- delete what categorizing made (16 Oct 2026). Replaces the single
-- bank_transactions.matched_journal_entry_id.
CREATE TYPE "bank_link_kind" AS ENUM ('matched', 'categorized');
--> statement-breakpoint
CREATE TABLE "bank_transaction_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bank_transaction_id" uuid NOT NULL REFERENCES "bank_transactions"("id") ON DELETE CASCADE,
  "bank_account_id" uuid NOT NULL REFERENCES "bank_accounts"("id"),
  "journal_entry_id" uuid NOT NULL REFERENCES "journal_entries"("id") ON DELETE CASCADE,
  "kind" "bank_link_kind" NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_banklink_txn" ON "bank_transaction_links" ("bank_transaction_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_banklink_je_bank" ON "bank_transaction_links" ("journal_entry_id", "bank_account_id");
--> statement-breakpoint
-- Categorizing posted a banking journal whose source is the line itself.
INSERT INTO "bank_transaction_links" ("bank_transaction_id", "bank_account_id", "journal_entry_id", "kind", "created_at")
SELECT t.id, t.bank_account_id, t.matched_journal_entry_id,
       CASE WHEN je.source_type = 'banking' AND je.source_id = t.id THEN 'categorized'::bank_link_kind ELSE 'matched'::bank_link_kind END,
       COALESCE(t.reconciled_at, t.created_at)
FROM "bank_transactions" t
JOIN "journal_entries" je ON je.id = t.matched_journal_entry_id
WHERE t.matched_journal_entry_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "bank_transactions" DROP COLUMN "matched_journal_entry_id";
