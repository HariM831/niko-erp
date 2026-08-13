ALTER TABLE "attachments" ADD COLUMN "filing_ref" varchar(30);--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_filing_ref_unique" UNIQUE("filing_ref");--> statement-breakpoint
--> Numbering rows for the new "attachment" entity on every series that already
--> exists. Without these the first upload would fail for want of a counter, and
--> drizzle cannot generate it because it is data, not schema.
INSERT INTO "document_series" ("series_id", "entity", "prefix", "padding")
SELECT "id", 'attachment', 'DOC-', 5 FROM "number_series"
ON CONFLICT DO NOTHING;
