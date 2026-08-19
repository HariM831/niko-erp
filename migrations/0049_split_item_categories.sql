-- Feed becomes raw material only, and "produce" becomes the three things it
-- actually was.
--
-- Produce covered eggs, birds and manure in one bucket, while the feed the mill
-- makes sat under Feed beside the maize it was made from. Nothing could be
-- reported on: "how much feed do we hold" answered with a maize silo and a
-- finished-goods store added together.
--
-- The rename does most of the work. Postgres cannot drop an enum value, but it
-- can rename one, so 'produce' BECOMES 'eggs' — which is what most of those
-- items were — and the handful that are not are moved after.
ALTER TYPE "item_category" RENAME VALUE 'produce' TO 'eggs';
ALTER TYPE "item_category" ADD VALUE IF NOT EXISTS 'poultry_feed';
ALTER TYPE "item_category" ADD VALUE IF NOT EXISTS 'birds';
ALTER TYPE "item_category" ADD VALUE IF NOT EXISTS 'manure';
