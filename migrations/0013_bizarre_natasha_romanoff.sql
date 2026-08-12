ALTER TABLE "estimate_lines" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "estimates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_order_lines" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_orders" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "estimate_lines" CASCADE;--> statement-breakpoint
DROP TABLE "estimates" CASCADE;--> statement-breakpoint
DROP TABLE "sales_order_lines" CASCADE;--> statement-breakpoint
DROP TABLE "sales_orders" CASCADE;--> statement-breakpoint
--> IF EXISTS: the CASCADE on "sales_orders" above already dropped this constraint.
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_sales_order_id_sales_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN "sales_order_id";--> statement-breakpoint
DROP TYPE "public"."estimate_status";--> statement-breakpoint
DROP TYPE "public"."sales_order_status";--> statement-breakpoint
--> Numbering config is data, not schema, so drizzle can't drop it for us.
DELETE FROM "document_series" WHERE "entity" IN ('estimate', 'sales_order');
