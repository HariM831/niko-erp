-- Dr EGGSY: field observations sent for diagnosis.
--
-- A worker photographs what they found in a shed — a post-mortem, wet litter,
-- a bird that looks wrong — and the observation goes to a model along with the
-- flock's own numbers for a first opinion. The photos live in `attachments`
-- (entity_type 'ai_observation'), same as every other file in the system;
-- this table is the observation itself and what the model said about it.
--
-- Keyed to the HOUSE, not the placement: the person in the shed knows which
-- shed they are standing in and nothing else. The analyze step resolves the
-- placement that held birds there on that date and builds the clinical context
-- from its flock_day rows.
CREATE TABLE IF NOT EXISTS "ai_observations" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "house_id"     uuid NOT NULL REFERENCES "houses"("id"),
  "observed_on"  date NOT NULL,
  -- What the person saw, in their own words. The model gets it too.
  "note"         text,
  -- The model's answer, verbatim, and who answered. Model recorded per row so
  -- a change in behaviour stays attributable, same rule as ocr_model.
  "ai_remark"    text,
  "ai_model"     text,
  "analyzed_at"  timestamptz,
  "submitted_by" uuid NOT NULL REFERENCES "users"("id"),
  -- Amino's observation id, so the import can run twice without doubling.
  "legacy_id"    varchar(40) UNIQUE,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ai_observations_house"
  ON "ai_observations" ("house_id", "observed_on");
