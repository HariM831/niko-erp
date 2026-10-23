-- A standing order's grade breakup for one day (23 Oct 2026).
--
-- Agreements are a box count; the customer gives the exact split by grade the
-- day before or on the day, within about 5% of it. The split lives on that
-- day's qty_override exception, so the agreement itself never changes.

ALTER TABLE "egg_agreement_exceptions" ADD COLUMN IF NOT EXISTS "sizes" jsonb;
