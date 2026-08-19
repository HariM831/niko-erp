-- A batch is placed over several hatches, not on one day.
--
-- 0057 gave a flock a single hatch_date, which is a fiction: 10,000 chicks
-- arrive as three or four hatches across a week, and pretending they all
-- hatched on one day makes the age wrong for most of the birds — and age is
-- what every standard comparison is keyed on.
--
-- So the hatches are the record and `flocks.hatch_date` becomes DERIVED: the
-- bird-weighted average of them. It stays a stored column because it is sorted
-- and filtered on everywhere, but exactly one function writes it, alongside
-- placed_count, from the rows below. Nothing else may touch either.
CREATE TABLE IF NOT EXISTS "flock_hatches" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "flock_id"   uuid NOT NULL REFERENCES "flocks"("id") ON DELETE CASCADE,
  "hatch_date" date NOT NULL,
  "qty"        integer NOT NULL CHECK ("qty" > 0),
  UNIQUE ("flock_id", "hatch_date")
);

CREATE INDEX IF NOT EXISTS "ix_flock_hatches_flock" ON "flock_hatches" ("flock_id","hatch_date");

-- Existing flocks had one hatch by construction. Their weighted average is that
-- date, so nothing about them changes.
INSERT INTO "flock_hatches" ("flock_id","hatch_date","qty")
  SELECT "id", "hatch_date", "placed_count" FROM "flocks"
ON CONFLICT ("flock_id","hatch_date") DO NOTHING;

-- Origin was two form fields for something that is a sentence. "Purchased
-- pullets, Suguna invoice 4471" reads better than a dropdown plus a reference
-- box, and nothing branched on the value.
ALTER TABLE "flocks" DROP COLUMN IF EXISTS "origin";
ALTER TABLE "flocks" DROP COLUMN IF EXISTS "origin_ref";

-- The standard set is the breed's default, resolved when the flock is placed.
-- Nullable because a breed may not have a curve yet, and refusing to record a
-- real flock of birds because nobody has typed in a benchmark is the wrong way
-- round. Still PINNED once set: a later revision never repoints it.
ALTER TABLE "flocks" ALTER COLUMN "standard_set_id" DROP NOT NULL;
