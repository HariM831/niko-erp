-- Brown and Niko are grades; Dirty is not.
--
-- The packing room's sheet of 12 Sep 2026 carries a BROWN column, handwritten
-- over the printed SMALL (21 boxes from L5, 61 opening, 82 closing), and a
-- NIKO column at 360 to the box (34 in stock). It carries no Dirty column and
-- never did. The user's calls on 13 Sep 2026: "brown is a separate grade, add
-- it as a column"; "remove dirty no longer needed"; "add niko as a grade".
--
-- Brown eggs are sorted by colour and never weighed into a band; a box holds
-- 210 like the weight grades. A Niko box holds 360, so it gets its own
-- eggs-per-box the way jumbo (180) did in 0086.
--
-- Nothing has been graded, counted or dispatched in either environment, so
-- the new columns start at zero, the dirty columns hold nothing and go, and
-- no history is re-stated.
ALTER TABLE "egg_grading"
  ADD COLUMN IF NOT EXISTS "brown" integer NOT NULL DEFAULT 0 CHECK ("brown" >= 0),
  ADD COLUMN IF NOT EXISTS "niko"  integer NOT NULL DEFAULT 0 CHECK ("niko" >= 0),
  DROP COLUMN IF EXISTS "dirty";
--> statement-breakpoint
ALTER TABLE "egg_house_closing"
  ADD COLUMN IF NOT EXISTS "brown" integer NOT NULL DEFAULT 0 CHECK ("brown" >= 0),
  ADD COLUMN IF NOT EXISTS "niko"  integer NOT NULL DEFAULT 0 CHECK ("niko" >= 0),
  DROP COLUMN IF EXISTS "dirty";
--> statement-breakpoint
ALTER TABLE "egg_spot_orders"
  ADD COLUMN IF NOT EXISTS "brown" integer NOT NULL DEFAULT 0 CHECK ("brown" >= 0),
  ADD COLUMN IF NOT EXISTS "niko"  integer NOT NULL DEFAULT 0 CHECK ("niko" >= 0),
  DROP COLUMN IF EXISTS "dirty";
--> statement-breakpoint
ALTER TABLE "egg_dispatches"
  ADD COLUMN IF NOT EXISTS "loaded_brown" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "loaded_niko"  integer NOT NULL DEFAULT 0,
  DROP COLUMN IF EXISTS "loaded_dirty";
--> statement-breakpoint
ALTER TABLE "egg_size_offsets"
  ADD COLUMN IF NOT EXISTS "brown" numeric(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "niko"  numeric(10,4) NOT NULL DEFAULT 0,
  DROP COLUMN IF EXISTS "dirty";
--> statement-breakpoint
ALTER TABLE "egg_sales_preferences"
  ADD COLUMN IF NOT EXISTS "niko_eggs_per_box" integer NOT NULL DEFAULT 360;
--> statement-breakpoint
-- The size list is a CHECK, so the new sizes have to be let in before they
-- can be given stock items, and dirty has to leave the map before it leaves
-- the list.
DELETE FROM "egg_size_items" WHERE "size" = 'dirty';
--> statement-breakpoint
UPDATE "items" SET "is_active" = false, "track_inventory" = false
WHERE "name" = 'Eggs — Dirty'
  AND NOT EXISTS (SELECT 1 FROM "inventory_transactions" t WHERE t."item_id" = "items"."id");
--> statement-breakpoint
ALTER TABLE "egg_size_items" DROP CONSTRAINT IF EXISTS "ck_egg_size";
--> statement-breakpoint
ALTER TABLE "egg_size_items"
  ADD CONSTRAINT "ck_egg_size" CHECK ("size" IN ('small','medium','large','xl','jumbo','brown','niko'));
--> statement-breakpoint
-- Their stock items, in boxes like the rest. Zoho never had either, so they
-- are created here the way Dirty once was.
INSERT INTO "items" ("type", "name", "unit", "category", "track_inventory", "is_sold", "is_purchased", "description")
SELECT 'goods', v.name, 'boxes', 'eggs', true, true, false, v.descr
FROM (VALUES
  ('Eggs — Brown', 'Brown shell eggs, graded by colour rather than weight. A box holds 210.'),
  ('Eggs — Niko',  'Niko pack. A box holds 360.')
) AS v(name, descr)
WHERE NOT EXISTS (SELECT 1 FROM "items" i WHERE i.name = v.name);
--> statement-breakpoint
INSERT INTO "egg_size_items" ("size", "item_id")
SELECT s.size, i.id
FROM (VALUES ('brown', 'Eggs — Brown'), ('niko', 'Eggs — Niko')) AS s(size, name)
JOIN "items" i ON i.name = s.name
ON CONFLICT ("size") DO NOTHING;
