-- A purchase manager may extend one order's over-delivery allowance by up to
-- 5% more, on top of the org-wide allowance (the user, 3 Oct 2026). Kept on the
-- order with who, when and why, so a truck taken past the usual 5% has a name
-- and a reason behind it.

ALTER TABLE "purchase_orders"
  ADD COLUMN IF NOT EXISTS "extra_allowance_pct" numeric(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "extra_allowance_reason" text,
  ADD COLUMN IF NOT EXISTS "extra_allowance_by" uuid REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "extra_allowance_at" timestamp with time zone;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "ck_po_extra_allowance" CHECK ("extra_allowance_pct" >= 0 AND "extra_allowance_pct" <= 5);
