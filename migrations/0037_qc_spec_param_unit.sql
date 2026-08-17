-- How a quality reading is expressed: "%", "ppb", "mg/kg".
--
-- The purchase order prints this figure for a vendor to read, and until now the
-- "%" was hardcoded in the formatter. Every parameter measured today happens to
-- be a percentage, so nothing was wrong yet — but "Aflatoxin : Max 20%" for a
-- limit of 20 parts per billion is off by seven orders of magnitude and looks
-- entirely ordinary on the page.
--
-- Nullable, not defaulted, for that same reason: a default would put the trap
-- back. Null prints no unit, which is uninformative but never wrong.
ALTER TABLE "qc_spec_params" ADD COLUMN "unit" varchar(12);--> statement-breakpoint
-- Backfill: every parameter that exists today is a percentage, and each was
-- entered by someone who meant a percentage.
UPDATE "qc_spec_params" SET "unit" = '%' WHERE "unit" IS NULL;
