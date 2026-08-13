ALTER TABLE "credit_note_lines" ALTER COLUMN "rate" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "invoice_lines" ALTER COLUMN "rate" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "bill_lines" ALTER COLUMN "rate" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "rate" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ALTER COLUMN "rate" SET DATA TYPE numeric(18, 6);