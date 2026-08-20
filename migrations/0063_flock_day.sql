-- flock_day — the reporting surface. One table; the reports read it and nothing
-- else, so no report does arithmetic of its own.
--
-- This exists because the same figure was being computed in four places that
-- disagreed: a shed's closing count on the board, on its own page, in the
-- report and in the API. Here every derivation happens once, on write.
--
-- A real table rather than a view: the cumulative columns run over a flock's
-- whole life across every house it has lived in, which a view cannot do at any
-- size worth having.
CREATE TABLE IF NOT EXISTS "flock_day" (
  "placement_id"          uuid NOT NULL REFERENCES "flock_placements"("id") ON DELETE CASCADE,
  "day"                   date NOT NULL,

  /* Denormalised so a report can filter without joining back. Rewritten with
     the row, so they cannot drift. */
  "flock_id"              uuid NOT NULL,
  "house_id"              uuid NOT NULL,
  "location_id"           uuid NOT NULL,
  /* From the FLOCK's own lay date, never from the kind of house it sits in: a
     flock laying in a pullet shed is in lay, and its eggs count. */
  "phase"                 text NOT NULL CHECK ("phase" IN ('rear','lay')),

  /* Week 1 is days 0–6, which is how published breed guides are keyed. */
  "age_days"              integer NOT NULL,
  "age_week"              integer NOT NULL,

  "opening_birds"         integer NOT NULL,
  "closing_birds"         integer NOT NULL,
  "mortality"             integer NOT NULL DEFAULT 0,
  "culls"                 integer NOT NULL DEFAULT 0,
  "male_removals"         integer NOT NULL DEFAULT 0,
  "transfers_in"          integer NOT NULL DEFAULT 0,
  "transfers_out"         integer NOT NULL DEFAULT 0,

  "eggs"                  integer,
  "eggs_cracked"          integer,
  "eggs_dirty"            integer,
  "hd_pct"                numeric(6,2),
  "cum_eggs"              bigint NOT NULL DEFAULT 0,
  "eggs_per_hen_housed"   numeric(8,2),

  "feed_kg"               numeric(10,2),
  "feed_delivered_kg"     numeric(10,2) NOT NULL DEFAULT 0,
  "feed_closing_kg"       numeric(10,2),
  "feed_per_bird_g"       numeric(8,2),
  "feed_g_per_egg"        numeric(8,2),
  "cum_feed_kg"           numeric(12,2) NOT NULL DEFAULT 0,
  "cum_feed_kg_per_bird"  numeric(8,3),

  /* Cost is FIFO over the HOUSE's deliveries, which is physically true: feed
     left in a silo is eaten by whoever is placed there next. Operational only —
     Farms posts no journal; feed reaches the books as period-end stock. */
  "item_id"               uuid,
  "feed_cost"             numeric(14,2),
  "feed_cost_per_kg"      numeric(10,4),
  /* A delivery with no cost basis is consumed but contributes nothing, and says
     so. Better a visible gap than a quietly understated cost per egg. */
  "feed_cost_incomplete"  boolean NOT NULL DEFAULT false,
  "cfpe"                  numeric(10,4),
  "cum_feed_cost"         numeric(14,2),
  "cum_cfpe"              numeric(10,4),

  "water_l"               numeric(10,2),
  "water_per_bird_ml"     numeric(10,2),
  "water_feed_ratio"      numeric(8,3),

  "cum_mortality"         integer NOT NULL DEFAULT 0,
  "cum_mortality_pct"     numeric(6,3),
  "liveability_pct"       numeric(6,3),

  /* The last weighing on or before the day, carried forward. */
  "body_weight_g"         numeric(8,1),
  "egg_weight_g"          numeric(6,2),

  /* The flock's PINNED standard at this age — copied in, so revising a guide
     never restates a batch that was measured against the old one. */
  "std_body_weight_g"     numeric(8,1),
  "std_feed_g_per_bird"   numeric(6,2),
  "std_water_ml_per_bird" numeric(7,2),
  "std_lay_pct"           numeric(5,2),
  "std_egg_weight_g"      numeric(6,2),
  "std_cum_mortality_pct" numeric(5,2),

  "refreshed_at"          timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("placement_id", "day")
);

CREATE INDEX IF NOT EXISTS "ix_flock_day_day"      ON "flock_day" ("day");
CREATE INDEX IF NOT EXISTS "ix_flock_day_flock"    ON "flock_day" ("flock_id", "day");
CREATE INDEX IF NOT EXISTS "ix_flock_day_house"    ON "flock_day" ("house_id", "day");
CREATE INDEX IF NOT EXISTS "ix_flock_day_location" ON "flock_day" ("location_id", "day");
