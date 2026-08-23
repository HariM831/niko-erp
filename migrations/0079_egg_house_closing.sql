-- The evening count, per shed.
--
-- The sheds hold their own eggs until a truck lifts them, so the packing
-- room counts each shed's room at day end. That count is the one figure the
-- ledger cannot derive and the check on everything it does: shed opening
-- (yesterday's count) + graded today - counted tonight = what left the shed,
-- and the sum of all counts against the ledger's closing is the day's
-- variance. It is recorded as a COUNT, never written into stock by itself -
-- a difference is posted as an adjustment, where a difference belongs.
CREATE TABLE IF NOT EXISTS "egg_house_closing" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "counted_on"   date NOT NULL,
  "house_id"     uuid NOT NULL REFERENCES "houses"("id"),
  "small"        integer NOT NULL DEFAULT 0 CHECK ("small" >= 0),
  "medium"       integer NOT NULL DEFAULT 0 CHECK ("medium" >= 0),
  "large"        integer NOT NULL DEFAULT 0 CHECK ("large" >= 0),
  "xl"           integer NOT NULL DEFAULT 0 CHECK ("xl" >= 0),
  "jumbo"        integer NOT NULL DEFAULT 0 CHECK ("jumbo" >= 0),
  "dirty"        integer NOT NULL DEFAULT 0 CHECK ("dirty" >= 0),
  "recorded_by"  uuid NOT NULL REFERENCES "users"("id"),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_egg_house_closing_day" UNIQUE ("house_id", "counted_on")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_egg_house_closing_day" ON "egg_house_closing" ("counted_on");
