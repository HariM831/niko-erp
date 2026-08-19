-- Farms, phase 2: the flock spine.
--
-- A flock is a cohort — one hatch date, one standard curve. WHERE it lives is a
-- separate, changing fact, which is why placements are their own table: a
-- transfer is closing one placement and opening another, not editing a row.
--
-- This is what the old model could not express. A flock split across two layer
-- houses is one cohort in two places; a house holding two flocks is one place
-- with two cohorts. Both are ordinary here and neither was representable when a
-- shed carried its own bird count.
CREATE TABLE IF NOT EXISTS "flocks" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"            text NOT NULL UNIQUE,
  "location_id"     uuid NOT NULL REFERENCES "locations"("id"),
  "breed_id"        uuid NOT NULL REFERENCES "breeds"("id"),
  -- Pinned at placement: see 0056. Never repointed when a standard is revised.
  "standard_set_id" uuid NOT NULL REFERENCES "standard_sets"("id"),
  "hatch_date"      date NOT NULL,
  "origin"          text NOT NULL CHECK ("origin" IN ('doc','purchased_pullet','opening')),
  "origin_ref"      text,
  "placed_count"    integer NOT NULL CHECK ("placed_count" > 0),
  "status"          text NOT NULL DEFAULT 'rearing'
                      CHECK ("status" IN ('rearing','laying','depleted')),
  "lay_start_date"  date,
  "depleted_on"     date,
  "note"            text,
  "created_at"      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ix_flocks_location_status" ON "flocks" ("location_id","status");

CREATE TABLE IF NOT EXISTS "flock_placements" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "flock_id"   uuid NOT NULL REFERENCES "flocks"("id"),
  "house_id"   uuid NOT NULL REFERENCES "houses"("id"),
  "from_date"  date NOT NULL,
  "to_date"    date,
  "note"       text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CHECK ("to_date" IS NULL OR "to_date" >= "from_date")
);

-- One open placement per flock per house. A flock may be open in several
-- houses at once — that is a split, not a mistake.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_flock_placements_open"
  ON "flock_placements" ("flock_id","house_id") WHERE "to_date" IS NULL;
CREATE INDEX IF NOT EXISTS "ix_flock_placements_house" ON "flock_placements" ("house_id","from_date");
CREATE INDEX IF NOT EXISTS "ix_flock_placements_flock" ON "flock_placements" ("flock_id","from_date");

-- Every bird that entered or left, and why.
--
-- qty is always positive; direction comes from kind and is applied in the
-- rollup, never stored. Storing a sign as well as a kind gives two places for
-- the truth to live and one of them to be wrong. 'adjustment' is the single
-- kind that can go either way, so it carries an explicit sign — and the CHECK
-- makes that column meaningless on every other kind.
CREATE TABLE IF NOT EXISTS "flock_movements" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "placement_id"             uuid NOT NULL REFERENCES "flock_placements"("id"),
  "event_date"               date NOT NULL,
  "kind"                     text NOT NULL CHECK ("kind" IN (
                               'place','mortality','cull','male_removal',
                               'transfer_out','transfer_in','adjustment','depletion')),
  "qty"                      integer NOT NULL CHECK ("qty" > 0),
  "adjustment_sign"          smallint CHECK ("adjustment_sign" IN (-1,1)),
  "cause_code"               text REFERENCES "mortality_causes"("code"),
  "counterpart_placement_id" uuid REFERENCES "flock_placements"("id"),
  "note"                     text,
  "recorded_by"              uuid REFERENCES "users"("id"),
  "created_at"               timestamp NOT NULL DEFAULT now(),
  CHECK (("kind" = 'adjustment') = ("adjustment_sign" IS NOT NULL)),
  -- A transfer with no other end is a bird that vanished.
  CHECK ("kind" NOT IN ('transfer_in','transfer_out') OR "counterpart_placement_id" IS NOT NULL),
  -- The highest-value field the rebuild adds.
  CHECK ("kind" NOT IN ('mortality','cull') OR "cause_code" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "ix_flock_movements_placement_date"
  ON "flock_movements" ("placement_id","event_date");
