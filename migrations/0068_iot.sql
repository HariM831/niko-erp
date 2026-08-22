-- The sheds' own instruments.
--
-- Big Herdsman controllers report temperature, humidity, CO2, pressure, water
-- and feed for every house, five minutes at a time. The farm has been running
-- on them for a year and EGGSY has never seen a reading.
--
-- Time matters here in a way it does not elsewhere in this app: the vendor
-- keeps roughly six weeks of history and then discards it. Whatever is not
-- pulled across is not recoverable later at any price.
--
-- Three tables, because they answer three different questions:
--   iot_readings   what is the shed doing NOW           (one row per tag)
--   iot_history    what was it doing at 3am on Tuesday  (one row per reading)
--   iot_house_day  what did it do yesterday             (one row per house-day)

/* The latest value of every tag. Overwritten on each poll — this is a dial on
   a wall, not a record, and history has its own table. */
CREATE TABLE IF NOT EXISTS "iot_readings" (
  "house_id"   uuid NOT NULL REFERENCES "houses"("id") ON DELETE CASCADE,
  /* The controller's own tag name, kept verbatim. Big Herdsman's tags are
     Chinese and hierarchical ("基础数据.温度.当前温度"); translating them here
     would make every future tag a decision and every mismatch a mystery. */
  "tag_id"     text NOT NULL,
  "value"      text,
  /* The controller's own quality flag. A zero-quality reading is a reading the
     instrument does not stand behind, and must not be averaged with the rest. */
  "quality"    integer NOT NULL DEFAULT 0,
  "unit"       text NOT NULL DEFAULT '',
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("house_id", "tag_id")
);

/* Every reading, kept. This is the table the six-week window is about. */
CREATE TABLE IF NOT EXISTS "iot_history" (
  "id"          bigserial PRIMARY KEY,
  "house_id"    uuid NOT NULL REFERENCES "houses"("id") ON DELETE CASCADE,
  "tag_id"      text NOT NULL,
  "value"       text,
  "quality"     integer NOT NULL DEFAULT 0,
  "unit"        text NOT NULL DEFAULT '',
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  /* The same instant twice is the same reading, whether it arrived from a poll
     or from a backfill of the vendor's own history. Without this, running the
     backfill twice doubles a year of data and every average moves. */
  CONSTRAINT "uq_iot_history" UNIQUE ("house_id", "tag_id", "recorded_at")
);

CREATE INDEX IF NOT EXISTS "ix_iot_history_house_time" ON "iot_history" ("house_id", "recorded_at");
CREATE INDEX IF NOT EXISTS "ix_iot_history_tag_time" ON "iot_history" ("tag_id", "recorded_at");

/* One row per house per day: what the instruments say the shed did.
   Deliberately NOT merged into placement_days. What a person wrote down and
   what a sensor measured are two different claims, and the day they disagree
   is the day you want both. */
CREATE TABLE IF NOT EXISTS "iot_house_day" (
  "house_id"          uuid NOT NULL REFERENCES "houses"("id") ON DELETE CASCADE,
  "day"               date NOT NULL,

  /* How many polls landed in the day. An average over four samples and one
     over two hundred are not the same number, and the reader should be able
     to tell which they are looking at. */
  "samples"           integer NOT NULL DEFAULT 0,

  "temp_avg"          numeric(6,2),
  "temp_min"          numeric(6,2),
  "temp_max"          numeric(6,2),
  "humidity_avg"      numeric(6,2),
  "co2_avg"           numeric(8,2),
  "co2_max"           numeric(8,2),
  "pressure_avg"      numeric(8,2),

  /* The controller's own daily totals, not a sum of our samples. */
  "water_l"           numeric(12,2),
  "feed_kg"           numeric(12,2),
  "water_per_bird_ml" numeric(10,2),
  "feed_per_bird_g"   numeric(10,2),
  /* What the silos weigh — the reading the 2026-07-16 tag rename broke. */
  "silo_kg"           numeric(12,2),

  /* The controller's own count and age, kept apart from the flock ledger's.
     They disagree, and which one is right is a question worth being able to
     ask rather than one to answer by overwriting. */
  "bird_count"        integer,
  "bird_age_days"     integer,

  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("house_id", "day")
);

CREATE INDEX IF NOT EXISTS "ix_iot_house_day_day" ON "iot_house_day" ("day");

/* How the last poll went.
   A silent integration is indistinguishable from a working one until somebody
   needs the data, by which time the window has closed. */
CREATE TABLE IF NOT EXISTS "iot_poll_log" (
  "id"          bigserial PRIMARY KEY,
  "started_at"  timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "ok"          boolean NOT NULL DEFAULT false,
  "houses"      integer NOT NULL DEFAULT 0,
  "tags"        integer NOT NULL DEFAULT 0,
  "readings"    integer NOT NULL DEFAULT 0,
  "error"       text
);

CREATE INDEX IF NOT EXISTS "ix_iot_poll_log_time" ON "iot_poll_log" ("started_at" DESC);
