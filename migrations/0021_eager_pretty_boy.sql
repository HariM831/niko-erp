CREATE TABLE "preferences" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'default' NOT NULL,
	"discount_level" varchar(12) DEFAULT 'line' NOT NULL,
	"discount_before_tax" boolean DEFAULT true NOT NULL,
	"enable_adjustment" boolean DEFAULT true NOT NULL,
	"enable_shipping_charge" boolean DEFAULT true NOT NULL,
	"tax_treatment" varchar(10) DEFAULT 'exclusive' NOT NULL,
	"rounding_mode" varchar(10) DEFAULT 'whole' NOT NULL,
	"rounding_increment" numeric(6, 2) DEFAULT '1.00' NOT NULL,
	"quantity_decimals" integer DEFAULT 2 NOT NULL,
	"allow_duplicate_item_names" boolean DEFAULT false NOT NULL,
	"prevent_negative_stock" boolean DEFAULT true NOT NULL,
	"show_out_of_stock_warning" boolean DEFAULT true NOT NULL,
	"notify_on_reorder_level" boolean DEFAULT false NOT NULL,
	"allow_duplicate_contact_names" boolean DEFAULT false NOT NULL,
	"default_customer_type" varchar(12) DEFAULT 'business' NOT NULL,
	"enable_credit_limit" boolean DEFAULT true NOT NULL,
	"require_account_code" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_name_unique";