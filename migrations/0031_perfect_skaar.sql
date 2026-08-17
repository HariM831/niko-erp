CREATE TYPE "public"."allocation_method" AS ENUM('pro_rata', 'manual');--> statement-breakpoint
CREATE TYPE "public"."po_match_method" AS ENUM('auto', 'chosen_from_list', 'manual', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."qc_verdict" AS ENUM('pass', 'warning', 'rejected', 'overridden', 'no_spec');--> statement-breakpoint
CREATE TYPE "public"."receipt_line_status" AS ENUM('pending', 'qc_accepted', 'qc_rejected', 'unloading', 'unloaded', 'settled');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('gate_in', 'weighed_in', 'qc_passed', 'unloading', 'unloading_complete', 'gate_out', 'settled', 'turned_away', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."vendor_match_method" AS ENUM('gstin', 'pan', 'exact', 'fuzzy', 'manual', 'none');--> statement-breakpoint
CREATE TABLE "procurement_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"status" "receipt_line_status" DEFAULT 'pending' NOT NULL,
	"purchase_order_id" uuid,
	"po_line_id" uuid,
	"item_id" uuid,
	"item_name" text,
	"agreed_rate_per_kg" numeric(18, 6),
	"bill_description" text,
	"bill_hsn_code" varchar(10),
	"bill_quantity_kg" numeric(14, 3) NOT NULL,
	"bill_rate_per_kg" numeric(18, 6),
	"bill_rate_basis" varchar(10),
	"bill_amount" numeric(14, 2),
	"bill_tax_amount" numeric(14, 2),
	"bill_bag_count" integer,
	"po_match_score" numeric(5, 2),
	"po_match_method" "po_match_method" DEFAULT 'unmatched' NOT NULL,
	"po_match_reasons" jsonb,
	"rate_variance_reason" text,
	"qc_verdict" "qc_verdict",
	"qc_moisture_pct" numeric(6, 3),
	"qc_protein_pct" numeric(6, 3),
	"qc_fiber_pct" numeric(6, 3),
	"qc_fat_pct" numeric(6, 3),
	"qc_other_params" jsonb,
	"qc_sample_count" integer,
	"qc_override_reason" text,
	"qc_override_by" uuid,
	"qc_rejection_reason" text,
	"warehouse_location_id" uuid,
	"unloading_started_at" timestamp,
	"unloading_completed_at" timestamp,
	"unloading_by" uuid,
	"bag_count_expected" integer,
	"bag_count_actual" integer,
	"unit_count" integer,
	"damage_percent" numeric(5, 2),
	"damage_type" varchar(12),
	"damage_remarks" text,
	"allocated_net_kg" numeric(14, 3),
	"shortage_kg" numeric(14, 3) GENERATED ALWAYS AS ("bill_quantity_kg" - COALESCE("allocated_net_kg", 0)) STORED,
	"bill_line_id" uuid
);
--> statement-breakpoint
CREATE TABLE "procurement_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(30) NOT NULL,
	"status" "receipt_status" DEFAULT 'gate_in' NOT NULL,
	"location_id" uuid NOT NULL,
	"vendor_id" uuid,
	"vendor_bill_number" text,
	"vendor_bill_date" date,
	"bill_document_type" varchar(20),
	"bill_total_amount" numeric(14, 2),
	"bill_tax_amount" numeric(14, 2),
	"bill_vendor_pan" varchar(10),
	"bill_vendor_gstin" varchar(15),
	"payment_terms_days" integer,
	"vendor_match_method" "vendor_match_method",
	"ocr_raw" jsonb,
	"ocr_confidence" jsonb,
	"ocr_footing_ok" boolean,
	"ocr_corrected_fields" text[],
	"ocr_model" text,
	"ocr_extracted_at" timestamp,
	"vehicle_number" varchar(20) NOT NULL,
	"gate_id" uuid,
	"arrival_at" timestamp DEFAULT now() NOT NULL,
	"device_captured_at" timestamp,
	"gate_in_by" uuid,
	"gate_in_latitude" numeric(10, 7),
	"gate_in_longitude" numeric(10, 7),
	"gate_in_accuracy_m" numeric(8, 2),
	"gate_in_distance_m" numeric(10, 2),
	"gate_in_geofence" varchar(10),
	"plate_ocr_text" text,
	"plate_matches_bill" boolean,
	"vendor_slip_gross_kg" numeric(14, 3),
	"vendor_slip_tare_kg" numeric(14, 3),
	"vendor_slip_net_kg" numeric(14, 3),
	"gross_weight_kg" numeric(14, 3),
	"gross_weighed_at" timestamp,
	"gross_weighed_by" uuid,
	"gross_weighbridge_id" uuid,
	"gross_variance_pct" numeric(6, 3),
	"gross_variance_reason" text,
	"qc_at" timestamp,
	"qc_by" uuid,
	"qc_rollup_verdict" varchar(15),
	"unloading_started_at" timestamp,
	"unloading_completed_at" timestamp,
	"tare_weight_kg" numeric(14, 3),
	"tare_weighed_at" timestamp,
	"tare_weighed_by" uuid,
	"tare_weighbridge_id" uuid,
	"net_weight_kg" numeric(14, 3) GENERATED ALWAYS AS ("gross_weight_kg" - "tare_weight_kg") STORED,
	"allocation_method" "allocation_method" DEFAULT 'pro_rata',
	"shortage_reason" text,
	"departed_at" timestamp,
	"gate_out_by" uuid,
	"bill_id" uuid,
	"vendor_credit_id" uuid,
	"bill_total_variance_reason" text,
	"settled_at" timestamp,
	"settled_by" uuid,
	"exit_stage" varchar(12),
	"exit_reason" text,
	"exit_at" timestamp,
	"exit_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "procurement_receipts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "procurement_receipt_lines_receipt_id_procurement_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."procurement_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "procurement_receipt_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "procurement_receipt_lines_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "procurement_receipt_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "procurement_receipt_lines_qc_override_by_users_id_fk" FOREIGN KEY ("qc_override_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "procurement_receipt_lines_warehouse_location_id_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "procurement_receipt_lines_unloading_by_users_id_fk" FOREIGN KEY ("unloading_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "procurement_receipt_lines_bill_line_id_bill_lines_id_fk" FOREIGN KEY ("bill_line_id") REFERENCES "public"."bill_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_vendor_id_contacts_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_gate_in_by_users_id_fk" FOREIGN KEY ("gate_in_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_gross_weighed_by_users_id_fk" FOREIGN KEY ("gross_weighed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_gross_weighbridge_id_weighbridges_id_fk" FOREIGN KEY ("gross_weighbridge_id") REFERENCES "public"."weighbridges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_qc_by_users_id_fk" FOREIGN KEY ("qc_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_tare_weighed_by_users_id_fk" FOREIGN KEY ("tare_weighed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_tare_weighbridge_id_weighbridges_id_fk" FOREIGN KEY ("tare_weighbridge_id") REFERENCES "public"."weighbridges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_gate_out_by_users_id_fk" FOREIGN KEY ("gate_out_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_vendor_credit_id_vendor_credits_id_fk" FOREIGN KEY ("vendor_credit_id") REFERENCES "public"."vendor_credits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_settled_by_users_id_fk" FOREIGN KEY ("settled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "procurement_receipts_exit_by_users_id_fk" FOREIGN KEY ("exit_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_prl_receipt" ON "procurement_receipt_lines" USING btree ("receipt_id","line_no");--> statement-breakpoint
CREATE INDEX "ix_prl_po_line" ON "procurement_receipt_lines" USING btree ("po_line_id");--> statement-breakpoint
CREATE INDEX "ix_prl_item" ON "procurement_receipt_lines" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "ix_pr_queue" ON "procurement_receipts" USING btree ("status","location_id","arrival_at");--> statement-breakpoint
CREATE INDEX "ix_pr_vendor" ON "procurement_receipts" USING btree ("vendor_id");--> statement-breakpoint
-- A re-scanned bill must never become a second payable.
CREATE UNIQUE INDEX "uq_pr_vendor_bill" ON "procurement_receipts" ("vendor_id", lower("vendor_bill_number"))
  WHERE "vendor_bill_number" IS NOT NULL AND "status" <> 'turned_away';--> statement-breakpoint
-- One live receipt per plate. Enforced by the database rather than a
-- pre-insert SELECT, which races between six stations on six devices.
CREATE UNIQUE INDEX "uq_pr_active_vehicle" ON "procurement_receipts" ("vehicle_number")
  WHERE "status" IN ('gate_in','weighed_in','qc_passed','unloading','unloading_complete');--> statement-breakpoint
ALTER TABLE "procurement_receipts" ADD CONSTRAINT "ck_pr_tare_below_gross"
  CHECK ("tare_weight_kg" IS NULL OR "gross_weight_kg" IS NULL OR "tare_weight_kg" < "gross_weight_kg");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prl_line_no" ON "procurement_receipt_lines" ("receipt_id", "line_no");--> statement-breakpoint
-- One PO line cannot be claimed twice on the same receipt.
CREATE UNIQUE INDEX "uq_prl_po_line" ON "procurement_receipt_lines" ("receipt_id", "po_line_id")
  WHERE "po_line_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "ck_prl_qty_positive"
  CHECK ("bill_quantity_kg" > 0);--> statement-breakpoint
-- A rejected line never takes a share of the vehicle net: the material never
-- came off, and its weight is still sitting inside the tare.
ALTER TABLE "procurement_receipt_lines" ADD CONSTRAINT "ck_prl_rejected_no_allocation"
  CHECK ("status" <> 'qc_rejected' OR COALESCE("allocated_net_kg", 0) = 0);