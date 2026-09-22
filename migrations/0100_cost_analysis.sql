-- Cost Analysis: the P&L stated per egg produced.
--
-- The statement picks its heads by a mapping kept as data, because the live
-- chart is Zoho's and shares no codes with the seeded one. An account with no
-- row is unassigned and reported in red; 'excluded' is a recorded decision.
CREATE TABLE "cost_analysis_heads" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"section" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cost_analysis_heads_section_check" CHECK ("section" IN ('income','cogs','farm','mill','packing','admin','finance','excluded'))
);
--> statement-breakpoint
ALTER TABLE "cost_analysis_heads" ADD CONSTRAINT "cost_analysis_heads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- The pullet constant: what a bird cost by the time it lays, over the eggs it
-- lays in its life. Charged on every egg in place of the chick bill and the
-- rearing feed. Rs 360 over 450 eggs was the figure given on 22 Sep 2026.
ALTER TABLE "preferences" ADD COLUMN "pullet_cost_per_bird" numeric(10, 2) DEFAULT '360.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "eggs_per_pullet_life" integer DEFAULT 450 NOT NULL;
