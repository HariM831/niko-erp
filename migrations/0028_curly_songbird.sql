ALTER TABLE "credit_notes" ADD COLUMN "adjustment_account_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "adjustment_description" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "adjustment_account_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "adjustment_description" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "adjustment_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "adjustment_description" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "adjustment_account_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "adjustment_description" text;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD COLUMN "adjustment_account_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD COLUMN "adjustment_description" text;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_adjustment_account_id_accounts_id_fk" FOREIGN KEY ("adjustment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_adjustment_account_id_accounts_id_fk" FOREIGN KEY ("adjustment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_adjustment_account_id_accounts_id_fk" FOREIGN KEY ("adjustment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_adjustment_account_id_accounts_id_fk" FOREIGN KEY ("adjustment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_adjustment_account_id_accounts_id_fk" FOREIGN KEY ("adjustment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;