CREATE TYPE "public"."custom_field_data_type" AS ENUM('text', 'textarea', 'email', 'url', 'phone', 'number', 'decimal', 'amount', 'percent', 'date', 'datetime', 'checkbox', 'dropdown', 'multiselect', 'lookup');--> statement-breakpoint
CREATE TABLE "custom_field_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_id" uuid NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_value_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value_id" uuid NOT NULL,
	"option_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"value_text" text,
	"value_number" numeric(18, 4),
	"value_date" date,
	"value_timestamp" timestamp,
	"value_bool" boolean,
	"option_id" uuid,
	"value_lookup_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" varchar(40) NOT NULL,
	"label" text NOT NULL,
	"data_type" "custom_field_data_type" NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"show_in_pdf" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"help_text" text,
	"max_length" integer,
	"min_value" numeric(18, 4),
	"max_value" numeric(18, 4),
	"lookup_entity" varchar(40),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_field_options" ADD CONSTRAINT "custom_field_options_field_id_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_value_options" ADD CONSTRAINT "custom_field_value_options_value_id_custom_field_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."custom_field_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_value_options" ADD CONSTRAINT "custom_field_value_options_option_id_custom_field_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."custom_field_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_field_id_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_option_id_custom_field_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."custom_field_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_field_option" ON "custom_field_options" USING btree ("field_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_field_value_option" ON "custom_field_value_options" USING btree ("value_id","option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_field_value" ON "custom_field_values" USING btree ("field_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_field_label" ON "custom_fields" USING btree ("entity","label");