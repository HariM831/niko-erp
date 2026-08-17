-- Feed mill: nutrient profiles, feed standards, formulas, production, transfers.
--
-- Generated, then trimmed: migrations 0036 to 0038 were hand-written (partial
-- indexes and a COALESCE that drizzle-kit will not emit), so its snapshot did not
-- know about bill_lines.rule_id, vendor_credit_lines.rule_id or qc_spec_params.unit
-- and proposed adding all three a second time. Those five statements are removed.

CREATE TYPE "public"."life_stage" AS ENUM('chick_starter', 'developer', 'grower', 'prelayer', 'layer_1', 'layer_2', 'layer_3');--> statement-breakpoint
CREATE TYPE "public"."nutrient_source" AS ENUM('lab', 'supplier', 'book');--> statement-breakpoint
CREATE TYPE "public"."production_status" AS ENUM('pending', 'completed', 'void');--> statement-breakpoint
CREATE TABLE "feed_standard_params" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"standard_id" uuid NOT NULL,
	"nutrient" varchar(20) NOT NULL,
	"min_value" numeric(12, 4),
	"max_value" numeric(12, 4),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_standards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" "life_stage" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(30) NOT NULL,
	"transfer_date" date NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity_kg" numeric(14, 3) NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"rate_per_kg" numeric(18, 6),
	"value" numeric(14, 2),
	"journal_entry_id" uuid,
	"status" "production_status" DEFAULT 'completed' NOT NULL,
	"void_reason" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feed_transfers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "formula_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"formula_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity_kg" numeric(14, 3) NOT NULL,
	"min_percent" numeric(6, 3),
	"max_percent" numeric(6, 3),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formulas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"output_item_id" uuid NOT NULL,
	"stage" "life_stage",
	"batch_size_kg" numeric(14, 3) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_nutrients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"nutrient" varchar(20) NOT NULL,
	"value" numeric(12, 4) NOT NULL,
	"source" "nutrient_source" DEFAULT 'book' NOT NULL,
	"tested_at" date,
	"notes" text,
	"updated_by" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"planned_kg" numeric(14, 3) NOT NULL,
	"actual_kg" numeric(14, 3),
	"rate_per_kg" numeric(18, 6),
	"value" numeric(14, 2),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(30) NOT NULL,
	"formula_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"batch_count" integer DEFAULT 1 NOT NULL,
	"planned_output_kg" numeric(14, 3) NOT NULL,
	"status" "production_status" DEFAULT 'pending' NOT NULL,
	"actual_output_kg" numeric(14, 3),
	"input_value" numeric(14, 2),
	"overhead_value" numeric(14, 2),
	"cost_per_kg" numeric(18, 6),
	"journal_entry_id" uuid,
	"completed_at" timestamp,
	"completed_by" uuid,
	"void_reason" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "production_orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "feed_standard_params" ADD CONSTRAINT "feed_standard_params_standard_id_feed_standards_id_fk" FOREIGN KEY ("standard_id") REFERENCES "public"."feed_standards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_standards" ADD CONSTRAINT "feed_standards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_transfers" ADD CONSTRAINT "feed_transfers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_transfers" ADD CONSTRAINT "feed_transfers_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_transfers" ADD CONSTRAINT "feed_transfers_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_transfers" ADD CONSTRAINT "feed_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formula_lines" ADD CONSTRAINT "formula_lines_formula_id_formulas_id_fk" FOREIGN KEY ("formula_id") REFERENCES "public"."formulas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formula_lines" ADD CONSTRAINT "formula_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulas" ADD CONSTRAINT "formulas_output_item_id_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulas" ADD CONSTRAINT "formulas_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_nutrients" ADD CONSTRAINT "item_nutrients_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_nutrients" ADD CONSTRAINT "item_nutrients_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_lines" ADD CONSTRAINT "production_order_lines_order_id_production_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."production_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_lines" ADD CONSTRAINT "production_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_formula_id_formulas_id_fk" FOREIGN KEY ("formula_id") REFERENCES "public"."formulas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feed_standard_param" ON "feed_standard_params" USING btree ("standard_id","nutrient");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feed_standard_version" ON "feed_standards" USING btree ("stage","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feed_standard_active" ON "feed_standards" USING btree ("stage") WHERE is_active;--> statement-breakpoint
CREATE INDEX "ix_feed_transfer_date" ON "feed_transfers" USING btree ("transfer_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_formula_line" ON "formula_lines" USING btree ("formula_id","item_id");--> statement-breakpoint
CREATE INDEX "ix_formula_line_item" ON "formula_lines" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_formula_version" ON "formulas" USING btree ("name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_formula_active" ON "formulas" USING btree ("name") WHERE is_active;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_item_nutrient" ON "item_nutrients" USING btree ("item_id","nutrient");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_production_order_line" ON "production_order_lines" USING btree ("order_id","item_id");--> statement-breakpoint
CREATE INDEX "ix_production_order_status" ON "production_orders" USING btree ("status","order_date");