-- Paying vendors: what is owed, and the file that goes to the bank.
--
-- Three things this adds, in the order the Payments screen uses them:
--
-- 1. Vendor bank details. A bank credits on the name it holds, not the one we
--    trade under, so the beneficiary name is stored beside the account rather
--    than derived from the contact's display name.
-- 2. An unpaid state for expenses. paid_through_id becomes nullable: null
--    means the cost is owed rather than gone, and the journal credits Accounts
--    Payable instead of a bank. due_date rides along, as it does on a bill.
-- 3. Payment batches — a record of an instruction handed to the bank, not of a
--    payment. Nothing here touches the ledger and nothing marks a bill paid;
--    the batch exists so the same bill is not sent out twice, and so the file
--    can be re-read months later when a vendor asks what we sent.

-- ── 1. Vendor bank details ──────────────────────────────────────────────
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "bank_beneficiary_name" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "bank_account_number" varchar(30);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "bank_ifsc" varchar(11);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "bank_name" text;
--> statement-breakpoint

-- Our own customer code with the bank, as their bulk-payment template wants it.
ALTER TABLE "bank_accounts" ADD COLUMN IF NOT EXISTS "bank_customer_code" varchar(20);
--> statement-breakpoint

-- ── 2. Unpaid expenses ──────────────────────────────────────────────────
ALTER TABLE "expenses" ALTER COLUMN "paid_through_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "due_date" date;
--> statement-breakpoint

-- ── 3. Payment batches ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payment_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "number" varchar(30) NOT NULL,
  "batch_date" date NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "total" numeric(14, 2) DEFAULT '0' NOT NULL,
  "notes" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "payment_batches_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_batch_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL,
  "bill_id" uuid,
  "expense_id" uuid,
  "vendor_id" uuid NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "beneficiary_name" text NOT NULL,
  "account_number" varchar(30) NOT NULL,
  "ifsc" varchar(11) NOT NULL,
  "transfer_mode" varchar(8) NOT NULL,
  "remarks" text,
  "line_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_lines_batch_id_payment_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payment_batches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_lines_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_lines_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_lines_vendor_id_contacts_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- A line pays one document, never both and never neither.
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_lines_one_document" CHECK (("bill_id" IS NULL) <> ("expense_id" IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pbl_batch" ON "payment_batch_lines" USING btree ("batch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pbl_bill" ON "payment_batch_lines" USING btree ("bill_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pbl_expense" ON "payment_batch_lines" USING btree ("expense_id");
--> statement-breakpoint

-- Batch numbering, in every series that exists — a series with no row for an
-- entity hands out no numbers, and the first payment run would fail on it.
INSERT INTO "document_series" ("series_id", "entity", "prefix")
SELECT "id", 'payment_batch', 'PB-' FROM "number_series"
ON CONFLICT ("series_id", "entity") DO NOTHING;
