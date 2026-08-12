CREATE TYPE "public"."asset_status" AS ENUM('active', 'fully_depreciated', 'disposed');--> statement-breakpoint
CREATE TYPE "public"."depreciation_method" AS ENUM('straight_line', 'written_down_value');--> statement-breakpoint
CREATE TABLE "depreciation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(30) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"asset_account_id" uuid NOT NULL,
	"status" "asset_status" DEFAULT 'active' NOT NULL,
	"acquisition_date" date NOT NULL,
	"cost" numeric(14, 2) NOT NULL,
	"salvage_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"method" "depreciation_method" DEFAULT 'straight_line' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"opening_accumulated" numeric(14, 2) DEFAULT '0' NOT NULL,
	"depreciation_start_date" date NOT NULL,
	"vendor_id" uuid,
	"serial_number" text,
	"location" text,
	"disposal_date" date,
	"disposal_proceeds" numeric(14, 2),
	"disposal_journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity_change" numeric(14, 3) DEFAULT '0' NOT NULL,
	"value_change" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"line_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(30) NOT NULL,
	"adjustment_date" date NOT NULL,
	"mode" varchar(10) DEFAULT 'quantity' NOT NULL,
	"reason" text NOT NULL,
	"description" text,
	"adjustment_account_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"is_void" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_adjustments_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "inventory_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"transaction_date" date NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"source_type" varchar(40) NOT NULL,
	"source_id" uuid,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_vendor_id_contacts_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("disposal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD CONSTRAINT "inventory_adjustment_lines_adjustment_id_inventory_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."inventory_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD CONSTRAINT "inventory_adjustment_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_adjustment_account_id_accounts_id_fk" FOREIGN KEY ("adjustment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_depreciation_asset" ON "depreciation_entries" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "ix_depreciation_period" ON "depreciation_entries" USING btree ("period_end");--> statement-breakpoint
CREATE INDEX "ix_fixed_assets_account" ON "fixed_assets" USING btree ("asset_account_id");--> statement-breakpoint
CREATE INDEX "ix_fixed_assets_status" ON "fixed_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_inv_txn_item" ON "inventory_transactions" USING btree ("item_id","transaction_date");--> statement-breakpoint
CREATE INDEX "ix_inv_txn_source" ON "inventory_transactions" USING btree ("source_type","source_id");