ALTER TABLE "preferences" ADD COLUMN "allow_editing_sent_invoice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "hide_zero_value_lines" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "default_invoice_terms" text;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "default_invoice_notes" text;