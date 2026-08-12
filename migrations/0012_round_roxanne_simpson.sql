CREATE TABLE "number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "number_series_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "document_series" DROP CONSTRAINT "document_series_entity_unique";--> statement-breakpoint
INSERT INTO "number_series" ("name", "is_default") VALUES ('Default Transaction Series', true);--> statement-breakpoint
ALTER TABLE "document_series" ADD COLUMN "series_id" uuid;--> statement-breakpoint
UPDATE "document_series" SET "series_id" = (SELECT "id" FROM "number_series" WHERE "is_default" LIMIT 1);--> statement-breakpoint
ALTER TABLE "document_series" ALTER COLUMN "series_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_series_id_number_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."number_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_document_series" ON "document_series" USING btree ("series_id","entity");
