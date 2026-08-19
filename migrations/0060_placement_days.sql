-- One row per house per day: what was fed, drunk, laid and lost.
--
-- The PRIMARY KEY is the fix for the duplicate-record bug. The table this
-- replaces had only non-unique indexes and relied on an app-level 409 whose
-- guard compared a UTC-parsed date against a server-local midnight — on a
-- non-UTC server the duplicate sailed straight through, and the same shed-day
-- ended up recorded twice with different numbers.
CREATE TABLE IF NOT EXISTS "placement_days" (
  "placement_id"     uuid NOT NULL REFERENCES "flock_placements"("id") ON DELETE CASCADE,
  "day"              date NOT NULL,
  "feed_consumed_kg" numeric(10,2) CHECK ("feed_consumed_kg" >= 0),
  "feed_closing_kg"  numeric(10,2) CHECK ("feed_closing_kg" >= 0),
  "water_l"          numeric(10,2) CHECK ("water_l" >= 0),
  -- Eggs are nullable with nothing tying them to the house's purpose: a pullet
  -- house genuinely produces at point of lay before transfer, and a schema that
  -- forbade it would make operators throw away real eggs. The form hides the
  -- field until the flock is old enough; the model allows it.
  "eggs_total"       integer CHECK ("eggs_total" >= 0),
  "eggs_cracked"     integer CHECK ("eggs_cracked" >= 0),
  "eggs_dirty"       integer CHECK ("eggs_dirty" >= 0),
  "note"             text,
  "source"           text NOT NULL DEFAULT 'manual'
                       CHECK ("source" IN ('manual','iot','import')),
  "recorded_by"      uuid REFERENCES "users"("id"),
  "created_at"       timestamp NOT NULL DEFAULT now(),
  "updated_at"       timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("placement_id", "day")
);

-- The daily entry screen asks "every house, this day", so the index runs that
-- way round as well as the primary key's.
CREATE INDEX IF NOT EXISTS "ix_placement_days_day" ON "placement_days" ("day");

-- Mortality is deliberately NOT a column here. It lives in flock_movements so
-- it can carry a cause, and so the bird count keeps coming from one ledger
-- instead of being split across two tables that can disagree. Saving a day
-- writes both, in one transaction.
