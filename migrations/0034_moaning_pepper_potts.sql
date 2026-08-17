CREATE TYPE "public"."deduction_scope" AS ENUM('line', 'vehicle');--> statement-breakpoint
ALTER TABLE "deduction_rules" ADD COLUMN "scope" "deduction_scope" DEFAULT 'line' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "shortage_tolerance_pct";