CREATE TABLE "bill_line_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_line_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"option_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_line_tags" ADD CONSTRAINT "bill_line_tags_bill_line_id_bill_lines_id_fk" FOREIGN KEY ("bill_line_id") REFERENCES "public"."bill_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_tags" ADD CONSTRAINT "bill_line_tags_tag_id_reporting_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."reporting_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_tags" ADD CONSTRAINT "bill_line_tags_option_id_reporting_tag_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."reporting_tag_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bill_line_tag" ON "bill_line_tags" USING btree ("bill_line_id","tag_id");