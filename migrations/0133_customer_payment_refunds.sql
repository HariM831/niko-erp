-- Money returned to a customer out of a receipt's unused amount (22 Oct 2026),
-- the selling side of 0132's vendor refunds. Zoho's two customer refunds (Luit
-- Valley Rs 28 lakh, Zakir Egg Store Rs 3 lakh) stood as loose journals, so
-- the receipts still showed that money as spare and the egg bay could apply it
-- to a new invoice. scripts/link-customer-refunds.ts ties them to their receipts.
CREATE TABLE IF NOT EXISTS "customer_payment_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL REFERENCES "customer_payments"("id"),
  "refund_date" date NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "bank_account_id" uuid REFERENCES "bank_accounts"("id"),
  "reference" text,
  "notes" text,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id"),
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "customer_payment_refunds_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cpr_payment" ON "customer_payment_refunds" ("payment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cpr_journal" ON "customer_payment_refunds" ("journal_entry_id");
