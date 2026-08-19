-- Where stock sits, and which batch it came from.
--
-- `locations` has existed since the beginning and nothing referenced it — its
-- own comment said it was defined early so transactions could carry a location
-- "before any of them are built, because retrofitting a dimension across posted
-- journals is the expensive way to do it". This is that retrofit, done while the
-- ledger is small enough for it to cost one migration.
CREATE TABLE IF NOT EXISTS "stock_locations" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "location_id" uuid NOT NULL REFERENCES "locations"("id"),
  "code"        varchar(20) NOT NULL,
  "name"        text NOT NULL,
  "kind"        varchar(12) NOT NULL CHECK ("kind" IN ('main','house','silo')),
  "is_active"   boolean NOT NULL DEFAULT true,
  "created_at"  timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_stock_locations_code" ON "stock_locations" ("location_id","code");
CREATE INDEX IF NOT EXISTS "ix_stock_locations_location" ON "stock_locations" ("location_id");

CREATE TABLE IF NOT EXISTS "item_lots" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"     uuid NOT NULL REFERENCES "items"("id"),
  "lot_no"      text,
  "expiry_date" date,
  "received_on" date NOT NULL,
  "notes"       text,
  "created_at"  timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_item_lots_no" ON "item_lots" ("item_id","lot_no");
CREATE INDEX IF NOT EXISTS "ix_item_lots_expiry" ON "item_lots" ("expiry_date") WHERE "expiry_date" IS NOT NULL;

-- Every existing location gets its main store.
INSERT INTO "stock_locations" ("location_id","code","name","kind")
SELECT l.id, 'MAIN', l.name || ' — main store', 'main'
FROM "locations" l
WHERE NOT EXISTS (
  SELECT 1 FROM "stock_locations" s WHERE s.location_id = l.id AND s.code = 'MAIN'
);

ALTER TABLE "inventory_transactions"
  ADD COLUMN IF NOT EXISTS "stock_location_id" uuid REFERENCES "stock_locations"("id"),
  ADD COLUMN IF NOT EXISTS "lot_id" uuid REFERENCES "item_lots"("id");

-- Every movement so far was the mill's: production and the transfers out of it.
-- Sending them to the mill's own store is the truthful backfill, not a guess.
UPDATE "inventory_transactions" t
   SET "stock_location_id" = (
     SELECT s.id FROM "stock_locations" s
     JOIN "locations" l ON l.id = s.location_id
     WHERE s.kind = 'main' AND l.type = 'feed_mill'
     ORDER BY l.created_at LIMIT 1)
 WHERE t."stock_location_id" IS NULL;

-- Anything left has no mill to belong to; put it in the primary location's store
-- so the column can be NOT NULL without inventing a place.
UPDATE "inventory_transactions" t
   SET "stock_location_id" = (
     SELECT s.id FROM "stock_locations" s
     JOIN "locations" l ON l.id = s.location_id
     WHERE s.kind = 'main' ORDER BY l.is_primary DESC, l.created_at LIMIT 1)
 WHERE t."stock_location_id" IS NULL;

ALTER TABLE "inventory_transactions" ALTER COLUMN "stock_location_id" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "ix_inv_txn_stock_location"
  ON "inventory_transactions" ("stock_location_id","item_id","transaction_date");
