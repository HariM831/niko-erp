CREATE TYPE "public"."deduction_basis" AS ENUM('pct_of_value', 'per_point_per_kg', 'shortfall_value', 'flat');--> statement-breakpoint
CREATE TYPE "public"."spec_direction" AS ENUM('max', 'min');--> statement-breakpoint
CREATE TABLE "deduction_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parameter" varchar(30) NOT NULL,
	"direction" "spec_direction" DEFAULT 'max' NOT NULL,
	"item_id" uuid,
	"vendor_id" uuid,
	"threshold" numeric(10, 4),
	"basis" "deduction_basis" NOT NULL,
	"rate_per_point" numeric(12, 4),
	"flat_amount" numeric(14, 2),
	"min_amount" numeric(14, 2),
	"version" integer DEFAULT 1 NOT NULL,
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qc_spec_params" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spec_id" uuid NOT NULL,
	"parameter" varchar(30) NOT NULL,
	"label" text,
	"direction" "spec_direction" NOT NULL,
	"target" numeric(10, 4),
	"warn_at" numeric(10, 4),
	"reject_at" numeric(10, 4),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qc_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sample_count" integer DEFAULT 3 NOT NULL,
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD COLUMN "qc_spec_id" uuid;--> statement-breakpoint
ALTER TABLE "deduction_rules" ADD CONSTRAINT "deduction_rules_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deduction_rules" ADD CONSTRAINT "deduction_rules_vendor_id_contacts_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deduction_rules" ADD CONSTRAINT "deduction_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_spec_params" ADD CONSTRAINT "qc_spec_params_spec_id_qc_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."qc_specs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_specs" ADD CONSTRAINT "qc_specs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_specs" ADD CONSTRAINT "qc_specs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_qc_spec_param" ON "qc_spec_params" USING btree ("spec_id","parameter");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_qc_spec_version" ON "qc_specs" USING btree ("item_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_qc_spec_active" ON "qc_specs" USING btree ("item_id") WHERE is_active;