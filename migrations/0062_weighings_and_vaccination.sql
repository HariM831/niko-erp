-- Weekly weights and vaccination, for the House page's remaining two tabs.
--
-- Shaped to match the forms being ported, with one change that matters: both
-- are keyed to the PLACEMENT, not the shed. In the app these come from, a
-- weighing belonged to a shed, so a flock's weight history restarted when it
-- moved to the layer house — the same break that made lifetime mortality
-- unusable. Keyed to the placement, the whole series follows the birds, and the
-- adapter groups by shed for the screen that wants it that way.
CREATE TABLE IF NOT EXISTS "bird_weighings" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "placement_id"  uuid NOT NULL REFERENCES "flock_placements"("id") ON DELETE CASCADE,
  "week_number"   integer NOT NULL CHECK ("week_number" BETWEEN 0 AND 120),
  "weighed_on"    date NOT NULL,
  /* Grams. numeric, not real — a body weight is compared against a standard to
     one decimal, and float drift shows up in the comparison. */
  "avg_weight_g"  numeric(8,1),
  /* Layers only; a rearing weighing leaves it null rather than zero. */
  "egg_weight_g"  numeric(6,2),
  "sample_size"   integer CHECK ("sample_size" > 0),
  "note"          text,
  "recorded_by"   uuid REFERENCES "users"("id"),
  "created_at"    timestamp NOT NULL DEFAULT now(),
  UNIQUE ("placement_id", "week_number")
);

CREATE INDEX IF NOT EXISTS "ix_bird_weighings_placement"
  ON "bird_weighings" ("placement_id", "week_number");

-- The programme: which vaccine is due at which age. A flat list, exactly as the
-- farm keeps it — "Day 1", "Week 6" as written text rather than a parsed age,
-- because that is what is printed on the sheet pinned up in the shed.
CREATE TABLE IF NOT EXISTS "vaccine_standards" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "age"          text NOT NULL,
  "vaccine_name" text NOT NULL,
  "sort_order"   integer NOT NULL DEFAULT 0
);

-- What was actually given.
CREATE TABLE IF NOT EXISTS "vaccination_events" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "placement_id"     uuid NOT NULL REFERENCES "flock_placements"("id") ON DELETE CASCADE,
  "event_date"       date NOT NULL,
  "vaccine_name"     text NOT NULL,
  "make"             text,
  "birds_vaccinated" integer CHECK ("birds_vaccinated" >= 0),
  "vaccinator_count" integer CHECK ("vaccinator_count" >= 0),
  "labours_count"    integer CHECK ("labours_count" >= 0),
  "image_url"        text,
  "note"             text,
  "recorded_by"      uuid REFERENCES "users"("id"),
  "created_at"       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ix_vaccination_events_placement"
  ON "vaccination_events" ("placement_id", "event_date");
