-- Where each purchase line's and expense's account head came from, and what
-- niko suggested for it (docs/account-head-suggestion-plan.md).
ALTER TABLE "bill_lines" ADD COLUMN IF NOT EXISTS "account_source" varchar(10);
ALTER TABLE "bill_lines" ADD COLUMN IF NOT EXISTS "suggested_account_id" uuid REFERENCES "accounts"("id");
ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "account_source" varchar(10);
ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "suggested_account_id" uuid REFERENCES "accounts"("id");
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "account_source" varchar(10);
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "suggested_account_id" uuid REFERENCES "accounts"("id");
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "account_source" varchar(10);
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "suggested_account_id" uuid REFERENCES "accounts"("id");
