-- Payroll, catching up with what Amino learned after the port.
-- Plan: docs/payroll-amino-catchup-plan.md.
--
-- Arrears. Someone joins on the 24th; nobody runs a payroll for six days; the
-- money is paid with the following month. It is salary, late — not a bonus —
-- so it is its own kind of pay input, naming the month it was earned in.
ALTER TYPE "pay_input_kind" ADD VALUE IF NOT EXISTS 'arrears';
--> statement-breakpoint
ALTER TABLE "pay_inputs"
  ADD COLUMN IF NOT EXISTS "earned_month" integer,
  ADD COLUMN IF NOT EXISTS "earned_year"  integer,
  ADD COLUMN IF NOT EXISTS "days"         real;
--> statement-breakpoint
-- Compared as text on purpose: the migrator runs this file in one transaction,
-- and Postgres will not let an enum value be used in the transaction that
-- added it.
ALTER TABLE "pay_inputs" ADD CONSTRAINT "ck_pay_inputs_arrears_earned" CHECK (
  "kind"::text <> 'arrears'
  OR ("earned_month" BETWEEN 1 AND 12
      AND "earned_year" IS NOT NULL
      AND ("earned_year", "earned_month") < ("year", "month"))
);
--> statement-breakpoint
ALTER TABLE "salary_slips" ADD COLUMN IF NOT EXISTS "arrears" numeric(14,2) NOT NULL DEFAULT 0;
--> statement-breakpoint
-- A personal weekly off. One man on the day shift rests on Wednesday; until now
-- that took a whole cloned shift. Null defers to the shift's own days.
ALTER TABLE "shift_assignments" ADD COLUMN IF NOT EXISTS "weekly_off_days" integer[];
