-- Farms, phase 1: the reference data a flock is measured against.
--
-- Standards are VERSIONED and a flock pins the version it was placed under.
-- Revising a breeder guide must never silently restate a closed flock's "vs
-- standard" history — the comparison is meaningless if the benchmark moves
-- underneath it.
CREATE TABLE IF NOT EXISTS "breeds" (
  "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"      text NOT NULL UNIQUE,
  "name"      text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS "standard_sets" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "breed_id"       uuid NOT NULL REFERENCES "breeds"("id"),
  "name"           text NOT NULL,
  "source"         text CHECK ("source" IN ('breeder','in-house','blend')),
  "version"        integer NOT NULL DEFAULT 1,
  "effective_from" date,
  "is_default"     boolean NOT NULL DEFAULT false,
  "note"           text,
  "created_at"     timestamp NOT NULL DEFAULT now(),
  UNIQUE ("breed_id", "name", "version")
);

-- One default per breed, enforced by the database rather than by whoever last
-- edited the screen.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_standard_sets_default"
  ON "standard_sets" ("breed_id") WHERE "is_default";

-- PRIMARY KEY (set_id, age_week) is the point. The old breed_standards table
-- had no uniqueness on (breed, week), and every consumer did
-- `find(s => s.week === w)` — which silently takes the first of a duplicate
-- pair after somebody imports the same CSV twice.
CREATE TABLE IF NOT EXISTS "standard_points" (
  "set_id"                uuid NOT NULL REFERENCES "standard_sets"("id") ON DELETE CASCADE,
  "age_week"              integer NOT NULL CHECK ("age_week" BETWEEN 1 AND 120),
  "body_weight_g"         numeric(8,1),
  "uniformity_cv_pct"     numeric(5,2),
  "feed_g_per_bird_day"   numeric(6,2),
  "water_ml_per_bird_day" numeric(7,2),
  "lay_pct"               numeric(5,2),
  "egg_weight_g"          numeric(6,2),
  "cum_mortality_pct"     numeric(5,2),
  PRIMARY KEY ("set_id", "age_week")
);

-- What a bird is worth, by breed and age week.
--
-- Edited on the same grid as the benchmarks above but stored apart, because it
-- obeys the OPPOSITE rule: a benchmark is pinned at placement, a valuation is
-- whatever is true now. effective_from is what makes "now" safe — a new rate
-- moves live flocks forward from its date and leaves closed periods alone,
-- which matters because this app locks periods.
CREATE TABLE IF NOT EXISTS "bird_valuation_rates" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "breed_id"       uuid NOT NULL REFERENCES "breeds"("id"),
  "age_week"       integer NOT NULL CHECK ("age_week" BETWEEN 1 AND 120),
  "rate"           numeric(14,2) NOT NULL,
  "effective_from" date NOT NULL,
  "note"           text,
  "created_by"     uuid REFERENCES "users"("id"),
  "created_at"     timestamp NOT NULL DEFAULT now(),
  UNIQUE ("breed_id", "age_week", "effective_from")
);

CREATE INDEX IF NOT EXISTS "ix_bird_valuation_lookup"
  ON "bird_valuation_rates" ("breed_id", "age_week", "effective_from" DESC);

-- "3 dead" tells you nothing. "3 prolapse" tells you the lighting programme is
-- wrong. Mandatory on every mortality and cull row.
CREATE TABLE IF NOT EXISTS "mortality_causes" (
  "code"       text PRIMARY KEY,
  "label"      text NOT NULL,
  "category"   text NOT NULL
                 CHECK ("category" IN ('disease','environment','management','predation','unknown')),
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active"  boolean NOT NULL DEFAULT true
);

INSERT INTO "mortality_causes" ("code","label","category","sort_order") VALUES
  ('prolapse',    'Prolapse',           'management',  10),
  ('pecking',     'Pecking / cannibalism','management',20),
  ('heat',        'Heat stress',        'environment', 30),
  ('cold',        'Cold stress',        'environment', 40),
  ('smother',     'Smothering',         'management',  50),
  ('injury',      'Injury',             'management',  60),
  ('respiratory', 'Respiratory disease','disease',     70),
  ('enteric',     'Enteric disease',    'disease',     80),
  ('ascites',     'Ascites',            'disease',     90),
  ('marek',       'Marek''s',           'disease',    100),
  ('ib',          'Infectious bronchitis','disease',  110),
  ('coccidiosis', 'Coccidiosis',        'disease',    120),
  ('predator',    'Predator',           'predation',  130),
  ('cull_weak',   'Culled — weak / runt','management',140),
  ('cull_sick',   'Culled — sick',      'management', 150),
  ('unknown',     'Unknown',            'unknown',    900)
ON CONFLICT ("code") DO NOTHING;
