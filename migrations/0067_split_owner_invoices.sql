-- Feed and pullets get an invoice each.
--
-- They were on one document because they travel in the same direction: Amino
-- sells both to the owner. But they are different trades on different terms —
-- feed goes out every week and is priced off the mill, pullets go out twice a
-- year and are priced off the valuation curve — and each invoice carries a
-- statement showing only its own transactions. One document holding both meant
-- one statement listing both, and a reader totting up the wrong column.
ALTER TABLE "owner_billing_runs"
  RENAME COLUMN "invoice_id" TO "feed_invoice_id";

ALTER TABLE "owner_billing_runs"
  ADD COLUMN IF NOT EXISTS "bird_invoice_id" uuid REFERENCES "invoices"("id");

-- Runs raised before the split had one combined invoice. It is recorded as the
-- feed invoice because that is what the bulk of it was, and it is the honest
-- place to look for it — inventing a second row to split it in two would be
-- writing history that never happened.
COMMENT ON COLUMN "owner_billing_runs"."feed_invoice_id" IS
  'The feed invoice. On runs raised before 0067 this is the combined feed-and-pullet invoice.';
