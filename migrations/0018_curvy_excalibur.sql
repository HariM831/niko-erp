CREATE TABLE "journal_entry_line_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"option_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reporting_tag_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reporting_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reporting_tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "journal_entry_line_tags" ADD CONSTRAINT "journal_entry_line_tags_line_id_journal_entry_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."journal_entry_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_line_tags" ADD CONSTRAINT "journal_entry_line_tags_tag_id_reporting_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."reporting_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_line_tags" ADD CONSTRAINT "journal_entry_line_tags_option_id_reporting_tag_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."reporting_tag_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporting_tag_options" ADD CONSTRAINT "reporting_tag_options_tag_id_reporting_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."reporting_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_line_tag" ON "journal_entry_line_tags" USING btree ("line_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tag_option" ON "reporting_tag_options" USING btree ("tag_id","name");--> statement-breakpoint
ALTER TABLE "journal_entry_lines" DROP COLUMN "tag";