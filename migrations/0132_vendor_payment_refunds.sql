-- Money a vendor sends back out of an advance (22 Oct 2026). Zoho's "Refund"
-- on a Payment Made: it comes off what the payment has spare, and the bank is
-- debited. Before this niko had nowhere to put it, so the 30 refunds brought
-- from Zoho stood as loose journals and every refunded advance still showed as
-- spare. scripts/link-vendor-refunds.ts ties those to their payments.
CREATE TABLE IF NOT EXISTS "vendor_payment_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL REFERENCES "vendor_payments"("id"),
  "refund_date" date NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "bank_account_id" uuid REFERENCES "bank_accounts"("id"),
  "reference" text,
  "notes" text,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id"),
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "vendor_payment_refunds_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_vpr_payment" ON "vendor_payment_refunds" ("payment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_vpr_journal" ON "vendor_payment_refunds" ("journal_entry_id");
