-- Move the items the rename could not reach.
--
-- A separate migration because Postgres refuses to USE an enum value in the
-- same transaction that added it — 'poultry_feed', 'birds' and 'manure' were
-- created in 0049 and only become usable after it commits.
--
-- Poultry feed is identified by being a formula's OUTPUT rather than by name:
-- that is what makes it produced rather than bought, and it survives somebody
-- renaming a formula.
UPDATE "items" SET category = 'poultry_feed'
 WHERE id IN (SELECT output_item_id FROM formulas WHERE output_item_id IS NOT NULL);

UPDATE "items" SET category = 'birds'
 WHERE category = 'eggs' AND (name ILIKE '%bird%' OR name ILIKE '%chick%');

UPDATE "items" SET category = 'manure'
 WHERE category = 'eggs' AND name ILIKE '%manure%';
