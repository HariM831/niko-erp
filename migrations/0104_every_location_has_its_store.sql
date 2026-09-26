-- Every location has its one store, named after it.
--
-- 0051 gave each location that existed then a main store, but adding a location
-- from Settings never did — so Dhekiajuli, created on staging 25 Sep 2026 as
-- the feed mill, had nowhere for stock to land and the mill could not produce
-- ("No stock location exists — every location needs a main store"). It is not
-- a second place: the mill is the location and the location is its store.
--
-- The names were also frozen at 0051: Nabil's store still read "Nalbari — main
-- store" after the location was renamed. The route now keeps them in step;
-- this brings the existing ones level.

INSERT INTO "stock_locations" ("location_id","code","name","kind")
SELECT l.id, 'MAIN', l.name || ' — main store', 'main'
FROM "locations" l
WHERE NOT EXISTS (
  SELECT 1 FROM "stock_locations" s WHERE s.location_id = l.id AND s.kind = 'main'
);

UPDATE "stock_locations" s
   SET "name" = l.name || ' — main store'
  FROM "locations" l
 WHERE s.location_id = l.id
   AND s.kind = 'main'
   AND s.name <> l.name || ' — main store';
