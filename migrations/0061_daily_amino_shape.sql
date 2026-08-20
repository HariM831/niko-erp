-- Bring placement_days to the shape the farm already reads and writes.
--
-- The daily entry screen is being ported field-for-field from the Amino app,
-- because the people filling it in every morning know that form and the data
-- migrating across was recorded through it. Where the two disagreed, the farm's
-- own habits won.
--
-- Water is TWO tank readings, not one figure. The rebuild spec argued for a
-- single litre number and called the split "a tank-plumbing detail" — but the
-- operator reads two meters, and asking them to add up before typing is how a
-- reading gets mistyped. Downstream code takes the sum, so the spec's point
-- still holds where it mattered: only one number leaves this table.
ALTER TABLE "placement_days"
  ADD COLUMN IF NOT EXISTS "water_upper_kl" numeric(10,2) CHECK ("water_upper_kl" >= 0),
  ADD COLUMN IF NOT EXISTS "water_lower_kl" numeric(10,2) CHECK ("water_lower_kl" >= 0);

-- Nothing has been recorded yet, so there is nothing to carry over.
ALTER TABLE "placement_days" DROP COLUMN IF EXISTS "water_l";

COMMENT ON COLUMN "placement_days"."feed_closing_kg" IS
  'What is left in the silo. Shown as "Stock (kg)", the farm''s own word for it.';
