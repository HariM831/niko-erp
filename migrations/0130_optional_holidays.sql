-- Optional (restricted) holidays, 22 Oct 2026: a salaried employee may take
-- any two of the company's optional-holiday dates in a year, as leave type OH.
-- An optional holiday is a working day for everyone who has not taken it, so
-- day resolution ignores it; it exists only as the list OH may be taken from.
ALTER TYPE "holiday_type" ADD VALUE IF NOT EXISTS 'optional';
--> statement-breakpoint
ALTER TYPE "leave_type" ADD VALUE IF NOT EXISTS 'OH';
--> statement-breakpoint
ALTER TABLE "payroll_settings" ADD COLUMN "optional_holidays_per_year" integer NOT NULL DEFAULT 2;
-- The dates themselves are loaded after this has run (a new enum value cannot
-- be used inside the transaction that adds it).
