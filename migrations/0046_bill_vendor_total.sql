-- The grand total the vendor printed, before anything we deducted.
-- Our own total is what we owe; theirs is the number on the paper somebody is
-- holding when they ring up about a bill, so it has to be searchable.
ALTER TABLE "bills"
  ADD COLUMN IF NOT EXISTS "vendor_bill_total" numeric(14, 2);
