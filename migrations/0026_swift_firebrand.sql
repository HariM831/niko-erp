CREATE TABLE "zoho_id_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" varchar(40) NOT NULL,
	"zoho_id" varchar(64) NOT NULL,
	"eggsy_id" uuid NOT NULL,
	"label" text,
	"imported_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_zoho_id_map" ON "zoho_id_map" USING btree ("entity","zoho_id");--> statement-breakpoint
CREATE INDEX "idx_zoho_id_map_eggsy" ON "zoho_id_map" USING btree ("eggsy_id");