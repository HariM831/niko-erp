-- Dirty eggs are counted and sold in trays of 30, not boxes (7 Oct 2026).
ALTER TABLE "egg_sales_preferences" ADD COLUMN IF NOT EXISTS "dirty_eggs_per_box" integer NOT NULL DEFAULT 30;
UPDATE "items" SET "unit" = 'trays'
  WHERE "id" IN (SELECT "item_id" FROM "egg_size_items" WHERE "size" = 'dirty');
