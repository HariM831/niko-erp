-- Freight agreed on the purchase order, paid to the transporter by us (22 Oct 2026).
--
-- The user: soya comes at an agreed Rs 5,700 a ton, pallets at a lump sum of
-- Rs 68,000 a truck. It is part of what the material costs, though it is paid
-- to a transporter, not the vendor, and transporters are not kept as vendors.
-- Paid by bank later, several trucks at a time; per ton is on the kilos on the
-- vendor's bill.
--
-- 1. The PO carries the terms: none, per ton, or per truck.
-- 2. Each truck settled against such a PO raises a freight charge: debited to
--    the material's own account (its stock account, for stock), credited to
--    Freight Payable. Its lines say how it was split across the materials.
-- 3. A freight payment clears a set of charges out of a bank account.

CREATE TYPE "freight_basis" AS ENUM ('none', 'per_ton', 'per_truck');
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "freight_basis" "freight_basis" DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "freight_rate" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TYPE "journal_source_type" ADD VALUE IF NOT EXISTS 'freight_charge';
--> statement-breakpoint
ALTER TYPE "journal_source_type" ADD VALUE IF NOT EXISTS 'freight_payment';
--> statement-breakpoint

-- Beside the other current liabilities where the code is free; FRT-1 where not.
INSERT INTO "accounts" ("code", "name", "type", "subtype", "system_key", "is_group")
SELECT CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE code = '2132') THEN 'FRT-1' ELSE '2132' END,
       'Freight Payable', 'liability', 'other_current_liability', 'freight_payable', false
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE system_key = 'freight_payable');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "freight_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "number" varchar(30) NOT NULL,
  "payment_date" date NOT NULL,
  "bank_account_id" uuid NOT NULL REFERENCES "bank_accounts"("id"),
  "amount" numeric(14, 2) NOT NULL,
  "transporter" text,
  "reference" text,
  "notes" text,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id"),
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "freight_payments_number_unique" UNIQUE("number"),
  CONSTRAINT "freight_payments_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "freight_charges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bill_id" uuid NOT NULL REFERENCES "bills"("id"),
  "receipt_id" uuid REFERENCES "office_receipts"("id"),
  "purchase_order_id" uuid NOT NULL REFERENCES "purchase_orders"("id"),
  "charge_date" date NOT NULL,
  "vehicle_number" varchar(20),
  "basis" "freight_basis" NOT NULL,
  "rate" numeric(14, 2) NOT NULL,
  "quantity_kg" numeric(14, 3),
  "amount" numeric(14, 2) NOT NULL,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id"),
  "freight_payment_id" uuid REFERENCES "freight_payments"("id"),
  "voided_at" timestamp,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "freight_charges_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fc_bill" ON "freight_charges" ("bill_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fc_payment" ON "freight_charges" ("freight_payment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fc_po" ON "freight_charges" ("purchase_order_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "freight_charge_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "charge_id" uuid NOT NULL REFERENCES "freight_charges"("id") ON DELETE CASCADE,
  "item_id" uuid REFERENCES "items"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id"),
  "name" text NOT NULL,
  "quantity_kg" numeric(14, 3),
  "amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fcl_charge" ON "freight_charge_lines" ("charge_id");
--> statement-breakpoint

INSERT INTO "document_series" ("series_id", "entity", "prefix")
SELECT "id", 'freight_payment', 'FRP-' FROM "number_series"
ON CONFLICT ("series_id", "entity") DO NOTHING;
