-- Niko packs 210 eggs to the box from 23 Oct 2026 (it was 360).
--
-- The box size becomes dated so the days before keep 360: eggs produced from
-- a graded sheet, eggs sold in Cost Analysis and per-egg prices read the size
-- in force on their own day. Niko is priced by the box, so no invoice changes.

CREATE TABLE IF NOT EXISTS "egg_box_sizes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "size" varchar(10) NOT NULL,
  "eggs_per_box" integer NOT NULL,
  "effective_from" date NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_egg_box_sizes" ON "egg_box_sizes" ("size", "effective_from");
--> statement-breakpoint
INSERT INTO "egg_box_sizes" ("size", "eggs_per_box", "effective_from") VALUES
  ('niko', 360, '2000-01-01'),
  ('niko', 210, '2026-10-23')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "egg_sales_preferences" SET "niko_eggs_per_box" = 210;
