-- Stop paying for indexes nothing reads.
--
-- Measured on 1.67M rows: the table's heap was 174 MB and its indexes 469 MB —
-- nearly three times the data. Postgres's own counters say why:
--
--   uq_iot_history             1,776,262 scans   244 MB   the dedup, essential
--   iot_history_pkey           1,776,262 scans    38 MB   used by RETURNING
--   ix_iot_history_house_time         29 scans    22 MB   marginal, kept
--   ix_iot_history_tag_time            0 scans   189 MB   never once read
--
-- The tag index was built on the assumption that somebody would ask for one
-- tag across all houses. Nothing does, and 189 MB is a high price for a
-- hypothesis.
DROP INDEX IF EXISTS "ix_iot_history_tag_time";

-- The prune's own index: it deletes by `recorded_at < cutoff` and had no index
-- with that column leading, so every run scanned the whole table.
--
-- BRIN rather than btree. This table is written in time order and never
-- updated, which is exactly the shape BRIN is for: it records a min and max per
-- block range instead of an entry per row, costing kilobytes where a btree of
-- the same column would cost a hundred megabytes and more every year.
CREATE INDEX IF NOT EXISTS "ix_iot_history_recorded_brin"
  ON "iot_history" USING brin ("recorded_at") WITH (pages_per_range = 64);
