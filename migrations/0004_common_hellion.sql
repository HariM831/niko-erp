ALTER TABLE "bill_lines" ADD COLUMN "allocated_freight" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "landed_unit_cost" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "freight_amount" numeric(14, 2) DEFAULT '0' NOT NULL;