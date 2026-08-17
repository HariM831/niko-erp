-- Numbering for the feed mill's two documents.
ALTER TABLE "production_orders" ALTER COLUMN "number" SET DATA TYPE varchar(30);--> statement-breakpoint
INSERT INTO "document_series" ("series_id", "entity", "prefix", "next_number", "padding")
SELECT "id", 'production_order', 'PRD-', 1, 5 FROM "number_series"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "document_series" ("series_id", "entity", "prefix", "next_number", "padding")
SELECT "id", 'feed_transfer', 'FT-', 1, 5 FROM "number_series"
ON CONFLICT DO NOTHING;
