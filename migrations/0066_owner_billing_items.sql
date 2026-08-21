-- Which item an owner's eggs and pullets are billed as.
--
-- Named rather than guessed. The item master holds several egg items and more
-- than one bird item, and picking "the one that looks right" at posting time
-- means the answer can change when somebody adds an item — after which two
-- months of invoices name different things for the same trade.
--
-- Feed needs no setting: a feed transfer already names the item it carried.
ALTER TABLE "preferences"
  ADD COLUMN IF NOT EXISTS "egg_purchase_item_id" uuid REFERENCES "items"("id"),
  ADD COLUMN IF NOT EXISTS "bird_sale_item_id"    uuid REFERENCES "items"("id");

-- Best guesses, so the first run has something to work with: ungraded eggs
-- (what a shed actually produces — grading happens later) and the tracked bird
-- item. Both are settings, and either can be changed without touching code.
UPDATE "preferences" SET "egg_purchase_item_id" = (
  SELECT id FROM "items"
  WHERE category = 'eggs' AND lower(name) LIKE '%ungraded%'
  ORDER BY created_at LIMIT 1)
WHERE "egg_purchase_item_id" IS NULL;

UPDATE "preferences" SET "bird_sale_item_id" = (
  SELECT id FROM "items"
  WHERE category = 'birds' AND track_inventory
  ORDER BY created_at LIMIT 1)
WHERE "bird_sale_item_id" IS NULL;
