-- Store readings wide instead of tall, and thin them as they age.
--
-- Measured on the 1,773,843 rows this migration carries across:
--
--   heap     184 MB   108.6 bytes/row
--   indexes  304 MB   179.8 bytes/row
--   ------------------------------------
--   total    488 MB   288 bytes per reading
--
-- The reading itself averaged 3.3 characters. The other 284 bytes were the
-- house id, the instant and the tag name — re-stated for every measurement,
-- then indexed together on top of that. At 162 readings a poll and 288 polls a
-- day, a year came to 17.0M rows and 4.9 GB.
--
-- One row per house per instant pays that bookkeeping once instead of 27 times:
--
--   23 B tuple header + 16 B house_id + 8 B at + 27 x 4 B values ~ 160 B
--   + ~40 B for the primary key entry
--   = ~200 B x 631k rows/year = ~126 MB/year
--
-- Which is also the shape the vendor's own history endpoint answers in, so a
-- backfill row now maps across almost as it arrives.

CREATE TABLE IF NOT EXISTS "iot_house_sample" (
  "house_id"          uuid        NOT NULL REFERENCES "houses"("id") ON DELETE CASCADE,
  "at"                timestamptz NOT NULL,

  "temp_c"            real,
  "target_temp_c"     real,
  "humidity_pct"      real,
  "co2_ppm"           real,
  "pressure_pa"       real,
  "bird_count"        real,
  "bird_age_days"     real,
  "feed_per_bird_g"   real,
  "water_per_bird_ml" real,

  "silo_kg"           real,
  "silo_kg_1"         real,
  "silo_kg_2"         real,
  "silo_kg_3"         real,
  "silo_kg_4"         real,
  "feed_kg"           real,
  "feed_kg_1"         real,
  "feed_kg_2"         real,
  "feed_kg_3"         real,
  "feed_kg_4"         real,
  "water_l"           real,
  "water_l_1"         real,
  "water_l_2"         real,
  "water_l_3"         real,
  "water_l_4"         real,

  "vent_level"        real,
  "vent_rate"         real,
  "mortality_today"   real,

  -- House and instant identify the row, so the key is also the de-duplication:
  -- running the backfill twice adds nothing. `real` throughout because these
  -- are instrument readings — 4 bytes carries about seven significant digits,
  -- and the largest number here is a silo at five.
  CONSTRAINT "iot_house_sample_pkey" PRIMARY KEY ("house_id", "at")
);
--> statement-breakpoint

-- The thinning deletes by `at` alone, which the primary key cannot serve
-- because it leads with the house. BRIN rather than btree: this table is
-- written in time order and never updated, so a min/max per block range costs
-- kilobytes where a btree of the same column would cost tens of megabytes and
-- grow every year.
CREATE INDEX IF NOT EXISTS "ix_iot_house_sample_at_brin"
  ON "iot_house_sample" USING brin ("at") WITH (pages_per_range = 64);
--> statement-breakpoint

-- Carry the tall history across.
--
-- `tag_id` is `<device>.<category>.<name>` from a live poll and `<device>.<name>`
-- from a backfill, so the join is on the last segment — the one grain the two
-- agree on, same as everywhere else in the IoT code.
--
-- Non-numeric values are dropped rather than coerced. A few tags report states
-- rather than measurements, and `'on'::real` is an error that would take the
-- whole migration down with it.
INSERT INTO "iot_house_sample" (
  "house_id", "at",
  "temp_c", "target_temp_c", "humidity_pct", "co2_ppm", "pressure_pa",
  "bird_count", "bird_age_days", "feed_per_bird_g", "water_per_bird_ml",
  "silo_kg", "silo_kg_1", "silo_kg_2", "silo_kg_3", "silo_kg_4",
  "feed_kg", "feed_kg_1", "feed_kg_2", "feed_kg_3", "feed_kg_4",
  "water_l", "water_l_1", "water_l_2", "water_l_3", "water_l_4",
  "vent_level", "vent_rate", "mortality_today"
)
SELECT
  house_id, recorded_at,
  max(v) FILTER (WHERE n = '当前温度'),
  max(v) FILTER (WHERE n = '目标温度'),
  max(v) FILTER (WHERE n = '当前湿度'),
  max(v) FILTER (WHERE n = 'CO2'),
  max(v) FILTER (WHERE n = '当前负压'),
  max(v) FILTER (WHERE n = '剩余数量'),
  max(v) FILTER (WHERE n = '当前日龄'),
  max(v) FILTER (WHERE n = '只鸡耗料量'),
  max(v) FILTER (WHERE n = '只鸡饮水量'),
  max(v) FILTER (WHERE n = '料塔当前总料量'),
  max(v) FILTER (WHERE n = '料塔实时重量1'),
  max(v) FILTER (WHERE n = '料塔实时重量2'),
  max(v) FILTER (WHERE n = '料塔实时重量3'),
  max(v) FILTER (WHERE n = '料塔实时重量4'),
  max(v) FILTER (WHERE n = '今日总用料量'),
  max(v) FILTER (WHERE n = '今日用料量1'),
  max(v) FILTER (WHERE n = '今日用料量2'),
  max(v) FILTER (WHERE n = '今日用料量3'),
  max(v) FILTER (WHERE n = '今日用料量4'),
  max(v) FILTER (WHERE n = '今日总用水量'),
  max(v) FILTER (WHERE n = '今日用水量1'),
  max(v) FILTER (WHERE n = '今日用水量2'),
  max(v) FILTER (WHERE n = '今日用水量3'),
  max(v) FILTER (WHERE n = '今日用水量4'),
  max(v) FILTER (WHERE n = '通风级别'),
  max(v) FILTER (WHERE n = '通风量'),
  max(v) FILTER (WHERE n = '新增死淘')
FROM (
  SELECT
    house_id,
    recorded_at,
    regexp_replace(tag_id, '^.*\.', '') AS n,
    CASE WHEN value ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN value::real END AS v
  FROM "iot_history"
) s
WHERE v IS NOT NULL
GROUP BY house_id, recorded_at
ON CONFLICT ("house_id", "at") DO NOTHING;
--> statement-breakpoint

-- Dropped, not kept alongside.
--
-- Everything in it arrived from the vendor's own six-week window within the
-- last six weeks, so the worst case if the pivot above is wrong is running the
-- backfill again — while keeping it would double the cost of the table this
-- migration exists to shrink.
DROP TABLE IF EXISTS "iot_history";
