CREATE TABLE "gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"radius_m" integer DEFAULT 200 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weighbridges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity_kg" numeric(14, 3),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "unit_bag_weight_kg" numeric(8, 3);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "shortage_tolerance_pct" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "parent_location_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "delivered_quantity" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighbridges" ADD CONSTRAINT "weighbridges_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_location_id_locations_id_fk" FOREIGN KEY ("parent_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Goods receipts draw a number like any other document. Backfilled across every
-- existing series, not just the default, so an organisation running separate
-- numbering per line of business does not hit "no numbering configured" the
-- first time a truck arrives.
INSERT INTO "document_series" ("series_id", "entity", "prefix", "next_number", "padding")
SELECT "id", 'procurement_receipt', 'GR-', 1, 5 FROM "number_series"
ON CONFLICT ("series_id", "entity") DO NOTHING;