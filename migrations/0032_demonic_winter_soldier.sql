ALTER TABLE "locations" ADD COLUMN "latitude" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "longitude" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "radius_m" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "kind" varchar(30);--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "captured_at" timestamp;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "latitude" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "longitude" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "accuracy_m" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;