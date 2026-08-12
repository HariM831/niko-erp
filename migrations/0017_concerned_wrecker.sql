CREATE TYPE "public"."location_type" AS ENUM('farm', 'feed_mill', 'warehouse', 'office');--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(12) NOT NULL,
	"name" text NOT NULL,
	"type" "location_type" DEFAULT 'farm' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"state_code" varchar(4),
	"pincode" varchar(10),
	"phone" text,
	"in_charge" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "locations_code_unique" UNIQUE("code"),
	CONSTRAINT "locations_name_unique" UNIQUE("name")
);
