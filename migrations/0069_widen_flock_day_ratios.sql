-- Room for the first day of lay.
--
-- These columns were sized for a flock in production, where feed per egg is a
-- hundred-odd grams and hen-day is a percentage. The first day a flock lays,
-- the house eats four tonnes and produces ONE egg — a genuine 4,576,000 grams
-- per egg, which is true, useless, and eight digits wider than the column.
--
-- Widened rather than capped or nulled. Capping would state a figure nobody
-- computed; nulling would hide the most interesting week in a flock's life
-- behind a dash. A reader who sees millions of grams per egg learns exactly
-- what happened: the birds have only just started.
ALTER TABLE "flock_day"
  ALTER COLUMN "feed_g_per_egg"   TYPE numeric(14,2),
  ALTER COLUMN "feed_per_bird_g"  TYPE numeric(14,2),
  ALTER COLUMN "cfpe"             TYPE numeric(14,4),
  ALTER COLUMN "cum_cfpe"         TYPE numeric(14,4),
  -- Hen-day stays a percentage in normal life, but a placement holding the last
  -- few birds of a batch while the shed's eggs land on it can run to thousands.
  ALTER COLUMN "hd_pct"           TYPE numeric(10,2),
  ALTER COLUMN "water_per_bird_ml" TYPE numeric(14,2),
  ALTER COLUMN "water_feed_ratio" TYPE numeric(14,3),
  ALTER COLUMN "cum_feed_kg_per_bird" TYPE numeric(14,3);
