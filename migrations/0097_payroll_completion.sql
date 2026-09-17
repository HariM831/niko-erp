-- The rest of what Amino has and niko lacked, and room for Amino's history.
-- Plan: docs/payroll-completion-plan.md.
--
-- Why a name was picked by hand at the gate. A refused camera and a face that
-- did not match are different problems; the failure report counted both as the
-- face failing. Null on older rows reads as "no match", which is what a manual
-- punch could only have meant before.
ALTER TABLE "punches" ADD COLUMN IF NOT EXISTS "manual_reason" varchar(20);
--> statement-breakpoint
-- An expense claim covers days: a trip from the 3rd to the 5th is one claim.
-- Both or neither, and never backwards. They describe the claim; the month
-- that pays it stays the explicit pay month.
ALTER TABLE "pay_inputs" ADD COLUMN IF NOT EXISTS "date_from" date, ADD COLUMN IF NOT EXISTS "date_to" date;
--> statement-breakpoint
ALTER TABLE "pay_inputs" ADD CONSTRAINT "ck_pay_inputs_dates" CHECK (
  ("date_from" IS NULL) = ("date_to" IS NULL) AND ("date_to" IS NULL OR "date_to" >= "date_from")
);
--> statement-breakpoint
-- The browser Canteen Gate records plates with no device behind them, under
-- the name of whoever is logged in; and it serves — but marks — a breakfast or
-- dinner for someone not on the list for it.
ALTER TABLE "canteen_servings" ALTER COLUMN "device_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "canteen_servings"
  ADD COLUMN IF NOT EXISTS "served_by" uuid REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "ineligible" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Breakfast for a night shift is the system's own flag, beside HR's and never
-- over it.
ALTER TABLE "canteen_meal_eligibility" ADD COLUMN IF NOT EXISTS "breakfast_auto" boolean NOT NULL DEFAULT false;
