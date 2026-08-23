-- Egg stock by size, the way the farm actually counts it.
--
-- The day sheet is two halves. The Production Report is graded output per
-- SHED per SIZE, in boxes — that is the thing entered. The Stock Summary
-- (opening + production − sales = closing, per size) is derived, never keyed:
-- the same rule as bird counts and every other stock figure in the system.
--
-- Stock is ONE pool per size at the farm store. Production is recorded per
-- shed because the sheet says which shed laid what, but a sale is never per
-- shed — the truck takes 1,434 Large from the pile, not from L3 — so the
-- shed is a property of the grading entry and nothing else.
--
-- This replaces the placeholder single "Eggs (farm)" item counted in eggs,
-- which was fed from the bird record's raw lay. The lay is a biological
-- count (it drives hen-day %); graded boxes are what can be sold. They differ
-- by cracks, dirties and shrink, and that gap is worth seeing, not hiding.

-- One row per shed-day, the Production Report half of the sheet.
CREATE TABLE IF NOT EXISTS "egg_grading" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "graded_on"    date NOT NULL,
  "house_id"     uuid NOT NULL REFERENCES "houses"("id"),
  "small"        integer NOT NULL DEFAULT 0 CHECK ("small" >= 0),
  "medium"       integer NOT NULL DEFAULT 0 CHECK ("medium" >= 0),
  "large"        integer NOT NULL DEFAULT 0 CHECK ("large" >= 0),
  "xl"           integer NOT NULL DEFAULT 0 CHECK ("xl" >= 0),
  "jumbo"        integer NOT NULL DEFAULT 0 CHECK ("jumbo" >= 0),
  "dirty"        integer NOT NULL DEFAULT 0 CHECK ("dirty" >= 0),
  "recorded_by"  uuid NOT NULL REFERENCES "users"("id"),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_egg_grading_house_day" UNIQUE ("house_id", "graded_on")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_egg_grading_day" ON "egg_grading" ("graded_on");
--> statement-breakpoint

-- The stock item for each size. A table rather than six columns on the
-- preferences row so the sizes are data the service iterates, not code.
CREATE TABLE IF NOT EXISTS "egg_size_items" (
  "size"     varchar(10) PRIMARY KEY,
  "item_id"  uuid NOT NULL UNIQUE REFERENCES "items"("id"),
  CONSTRAINT "ck_egg_size" CHECK ("size" IN ('small','medium','large','xl','jumbo','dirty'))
);
--> statement-breakpoint

-- The items, in BOXES: the trade's own unit, and the unit every figure on the
-- sheet is in. Created here so every environment gets the same six.
INSERT INTO "items" ("type", "name", "unit", "category", "track_inventory", "is_sold", "is_purchased", "description")
SELECT 'goods', v.name, 'boxes', 'eggs', true, true, false, v.descr
FROM (VALUES
  ('Eggs — Small',  'Graded shell eggs, small (box under 10.5 kg). Stock rises with the grading sheet, falls when the bay invoices.'),
  ('Eggs — Medium', 'Graded shell eggs, medium (box 10.5–12 kg).'),
  ('Eggs — Large',  'Graded shell eggs, large (box 12–13.5 kg).'),
  ('Eggs — XL',     'Graded shell eggs, extra large (box over 13.5 kg).'),
  ('Eggs — Jumbo',  'Graded shell eggs, jumbo.'),
  ('Eggs — Dirty',  'Dirty / second-grade eggs, sold at a discount.')
) AS v(name, descr)
WHERE NOT EXISTS (SELECT 1 FROM "items" i WHERE i.name = v.name);
--> statement-breakpoint
INSERT INTO "egg_size_items" ("size", "item_id")
SELECT s.size, i.id
FROM (VALUES ('small','Eggs — Small'), ('medium','Eggs — Medium'), ('large','Eggs — Large'),
             ('xl','Eggs — XL'), ('jumbo','Eggs — Jumbo'), ('dirty','Eggs — Dirty')) AS s(size, name)
JOIN "items" i ON i.name = s.name
ON CONFLICT ("size") DO NOTHING;
--> statement-breakpoint

-- The kg-per-box bands the grader sorts by, printed at the foot of the sheet.
-- Upper bound of each grade; XL is everything above the large band. Jumbo is
-- a separate pick, not a weight band, so it has none.
ALTER TABLE "egg_sales_preferences"
  ADD COLUMN IF NOT EXISTS "band_small_max_kg"  numeric(5,2) NOT NULL DEFAULT 10.5,
  ADD COLUMN IF NOT EXISTS "band_medium_max_kg" numeric(5,2) NOT NULL DEFAULT 12.0,
  ADD COLUMN IF NOT EXISTS "band_large_max_kg"  numeric(5,2) NOT NULL DEFAULT 13.5;
--> statement-breakpoint

-- Retire the placeholder. Its movements were the bird record's raw lay and
-- the two demo dispatches; the lay is no longer stock and the dispatches are
-- re-stated per size below. The rows go rather than linger as a second,
-- wrong count of the same eggs.
DELETE FROM "inventory_transactions"
WHERE "item_id" = (SELECT "egg_item_id" FROM "egg_sales_preferences");
--> statement-breakpoint
UPDATE "items" SET "is_active" = false, "track_inventory" = false
WHERE "id" = (SELECT "egg_item_id" FROM "egg_sales_preferences");
--> statement-breakpoint

-- Live dispatches re-stated as per-size box movements, so the bay's history
-- since go-live survives the change of unit.
INSERT INTO "inventory_transactions"
  ("item_id", "stock_location_id", "transaction_date", "quantity", "value", "source_type", "source_id", "notes")
SELECT si."item_id",
       (SELECT sl.id FROM "stock_locations" sl JOIN "locations" l ON l.id = sl.location_id
         WHERE sl.kind = 'main' ORDER BY l.is_primary DESC, l.created_at ASC LIMIT 1),
       d."dispatch_date",
       -(CASE si.size WHEN 'small' THEN d.loaded_small WHEN 'medium' THEN d.loaded_medium
                      WHEN 'large' THEN d.loaded_large WHEN 'xl' THEN d.loaded_xl
                      WHEN 'jumbo' THEN d.loaded_jumbo ELSE d.loaded_dirty END)::numeric,
       0,
       'invoice', d."invoice_id",
       'Invoice ' || i."number" || ' (re-stated per size)'
FROM "egg_dispatches" d
JOIN "invoices" i ON i.id = d."invoice_id"
CROSS JOIN "egg_size_items" si
WHERE d."status" = 'invoiced'
  AND (CASE si.size WHEN 'small' THEN d.loaded_small WHEN 'medium' THEN d.loaded_medium
                    WHEN 'large' THEN d.loaded_large WHEN 'xl' THEN d.loaded_xl
                    WHEN 'jumbo' THEN d.loaded_jumbo ELSE d.loaded_dirty END) > 0;
