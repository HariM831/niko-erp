-- Advances to vendors, and paying a bank batch from the Vendor Sheet
-- (docs/vendor-advances-and-batches-plan.md, 22 Oct 2026).
--
-- 1. An advance request: money asked for against a purchase order before the
--    bill, with the vendor's proforma attached. It goes to the bank in a batch
--    like a bill does, and once paid becomes a vendor payment with nothing
--    applied, waiting for the PO's bill.
-- 2. A batch line can carry an advance as its document, and remembers the
--    vendor payment it became once the batch is marked paid.
-- 3. A batch is marked paid, with who, when and the payment date used.
-- 4. Vendor payments say whether their unapplied part sits in Vendor Advances.
--    Payments brought from Zoho always did; niko's own put it inside payables
--    until now. New payments do, and scripts/move-vendor-advances.ts brings the
--    old ones across, one entry each.

CREATE TYPE "vendor_advance_status" AS ENUM ('open', 'paid', 'cancelled');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_advance_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "number" varchar(30) NOT NULL,
  "purchase_order_id" uuid NOT NULL REFERENCES "purchase_orders"("id"),
  "vendor_id" uuid NOT NULL REFERENCES "contacts"("id"),
  "amount" numeric(14, 2) NOT NULL,
  "proforma_number" text,
  "proforma_date" date,
  "notes" text,
  "status" "vendor_advance_status" DEFAULT 'open' NOT NULL,
  "vendor_payment_id" uuid REFERENCES "vendor_payments"("id"),
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "cancelled_at" timestamp,
  "cancelled_by" uuid REFERENCES "users"("id"),
  "cancel_reason" text,
  CONSTRAINT "vendor_advance_requests_number_unique" UNIQUE("number"),
  CONSTRAINT "vendor_advance_requests_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_var_po" ON "vendor_advance_requests" ("purchase_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_var_payment" ON "vendor_advance_requests" ("vendor_payment_id");
--> statement-breakpoint

ALTER TABLE "payment_batch_lines" ADD COLUMN IF NOT EXISTS "advance_request_id" uuid
  REFERENCES "vendor_advance_requests"("id");
--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD COLUMN IF NOT EXISTS "vendor_payment_id" uuid
  REFERENCES "vendor_payments"("id");
--> statement-breakpoint
-- When Mark paid recorded this transfer in the books. Deleting the payment it
-- made clears it again, and the batch goes back to waiting.
ALTER TABLE "payment_batch_lines" ADD COLUMN IF NOT EXISTS "recorded_at" timestamp;
--> statement-breakpoint
ALTER TABLE "payment_batch_lines" DROP CONSTRAINT IF EXISTS "payment_batch_lines_one_document";
--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_lines_one_document"
  CHECK (num_nonnulls("bill_id", "expense_id", "advance_request_id") = 1);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pbl_advance" ON "payment_batch_lines" ("advance_request_id");
--> statement-breakpoint

ALTER TABLE "payment_batches" ADD COLUMN IF NOT EXISTS "paid_at" timestamp;
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD COLUMN IF NOT EXISTS "paid_by" uuid REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD COLUMN IF NOT EXISTS "paid_on" date;
--> statement-breakpoint

ALTER TABLE "vendor_payments" ADD COLUMN IF NOT EXISTS "advances_in_ledger" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "vendor_payments" p SET "advances_in_ledger" = true
 WHERE EXISTS (SELECT 1 FROM "zoho_id_map" z WHERE z."entity" = 'vendor_payment' AND z."eggsy_id" = p."id");
--> statement-breakpoint

INSERT INTO "document_series" ("series_id", "entity", "prefix")
SELECT "id", 'vendor_advance_request', 'ADV-' FROM "number_series"
ON CONFLICT ("series_id", "entity") DO NOTHING;
