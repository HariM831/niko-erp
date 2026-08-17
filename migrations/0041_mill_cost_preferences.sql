-- The two milling cost constants, as preferences instead of code.
--
-- Amino hardcoded 1% baking loss and Rs 0.75/kg overhead in two files, each
-- with a comment saying it must match the other. The formulator's reported
-- cost and a production completion both read this one row now.
ALTER TABLE "preferences" ADD COLUMN "mill_moisture_retention" numeric(5,4) DEFAULT '0.99' NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "mill_overhead_per_kg" numeric(8,4) DEFAULT '0.75' NOT NULL;
