ALTER TYPE "public"."custom_field_data_type" ADD VALUE 'multiselect_lookup';--> statement-breakpoint
ALTER TYPE "public"."custom_field_data_type" ADD VALUE 'autonumber';--> statement-breakpoint
CREATE TABLE "custom_field_value_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value_id" uuid NOT NULL,
	"lookup_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_fields" ADD COLUMN "number_prefix" varchar(20);--> statement-breakpoint
ALTER TABLE "custom_fields" ADD COLUMN "number_padding" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD COLUMN "next_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_value_lookups" ADD CONSTRAINT "custom_field_value_lookups_value_id_custom_field_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."custom_field_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_field_value_lookup" ON "custom_field_value_lookups" USING btree ("value_id","lookup_id");