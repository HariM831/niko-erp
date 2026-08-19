-- Sheds stop being locations.
--
-- The feed mill import put them there because there was nowhere else: "sheds
-- become locations (type farm) where no location of that name exists". So L2
-- and Nalbari Feed Mill ended up in one list, and the feed transfer screen
-- offered the mill as a destination house.
--
-- A location is a SITE — it carries an address and the state code that decides
-- GST place of supply. A shed is a building inside one.
CREATE TABLE IF NOT EXISTS "houses" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "location_id"       uuid NOT NULL REFERENCES "locations"("id"),
  "stock_location_id" uuid NOT NULL REFERENCES "stock_locations"("id"),
  "code"              text NOT NULL,
  "name"              text,
  "purpose"           text NOT NULL CHECK ("purpose" IN ('rear','lay','both')),
  "capacity"          integer,
  "display_order"     integer NOT NULL DEFAULT 0,
  "bh_device_id"      text,
  "silo1_kg"          numeric(10,2),
  "silo2_kg"          numeric(10,2),
  "is_active"         boolean NOT NULL DEFAULT true,
  "created_at"        timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_houses_code" ON "houses" ("location_id","code");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_houses_stock_location" ON "houses" ("stock_location_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_houses_bh_device" ON "houses" ("bh_device_id") WHERE "bh_device_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ix_houses_location" ON "houses" ("location_id","display_order");

-- A transfer goes to a HOUSE. to_location_id stays for the rows written before
-- houses existed: rewriting a posted document to point at a row invented after
-- it is how history stops meaning anything.
ALTER TABLE "feed_transfers"
  ADD COLUMN IF NOT EXISTS "to_house_id" uuid REFERENCES "houses"("id");
