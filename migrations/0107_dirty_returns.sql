-- Dirty comes back as a grade.
--
-- 0094 removed it on 13 Sep 2026 ("remove dirty no longer needed"); on 27 Sep
-- the user's price list names it again — "Dirty (210 Eggs)", priced off the
-- benchmark like the weight grades — and asked for it back. A box holds 210.
-- Nothing was ever graded, counted or sold as Dirty in niko, so the columns
-- return at zero and no history is re-stated. Brown's change to a fixed box
-- rate is code only: egg_box_rates is keyed by size already.
ALTER TABLE "egg_grading"       ADD COLUMN IF NOT EXISTS "dirty" integer NOT NULL DEFAULT 0 CHECK ("dirty" >= 0);
--> statement-breakpoint
ALTER TABLE "egg_house_closing" ADD COLUMN IF NOT EXISTS "dirty" integer NOT NULL DEFAULT 0 CHECK ("dirty" >= 0);
--> statement-breakpoint
ALTER TABLE "egg_spot_orders"   ADD COLUMN IF NOT EXISTS "dirty" integer NOT NULL DEFAULT 0 CHECK ("dirty" >= 0);
--> statement-breakpoint
ALTER TABLE "egg_dispatches"    ADD COLUMN IF NOT EXISTS "loaded_dirty" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "egg_size_offsets"  ADD COLUMN IF NOT EXISTS "dirty" numeric(10,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "egg_size_items" DROP CONSTRAINT IF EXISTS "ck_egg_size";
--> statement-breakpoint
ALTER TABLE "egg_size_items"
  ADD CONSTRAINT "ck_egg_size" CHECK ("size" IN ('small','medium','large','xl','jumbo','brown','niko','dirty'));
--> statement-breakpoint
-- Its stock item: the one 0094 retired, back in service with the same
-- accounts as the other egg grades; created if this database never had it.
INSERT INTO "items" ("type", "name", "unit", "category", "track_inventory", "is_sold", "is_purchased", "description")
SELECT 'goods', 'Eggs — Dirty', 'boxes', 'eggs', true, true, false, 'Dirty-shell eggs. A box holds 210.'
WHERE NOT EXISTS (SELECT 1 FROM "items" WHERE "name" = 'Eggs — Dirty');
--> statement-breakpoint
UPDATE "items" d
   SET "is_active" = true,
       "track_inventory" = true,
       "sales_account_id" = COALESCE(d."sales_account_id", b."sales_account_id"),
       "inventory_account_id" = COALESCE(d."inventory_account_id", b."inventory_account_id"),
       "updated_at" = now()
  FROM "items" b
 WHERE d."name" = 'Eggs — Dirty' AND b."name" = 'Eggs — Brown';
--> statement-breakpoint
INSERT INTO "egg_size_items" ("size", "item_id")
SELECT 'dirty', i."id" FROM "items" i WHERE i."name" = 'Eggs — Dirty'
ON CONFLICT ("size") DO NOTHING;
