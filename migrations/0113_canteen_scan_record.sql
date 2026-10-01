-- The canteen keeps what its camera saw (docs/canteen-face-matching-plan.md,
-- 1 Oct 2026). It needed a name picked by hand for 46% of plates against the
-- gate's 4%, and a failed scan left nothing behind to learn from or to judge.
--
-- face_embedding: the scanned face, kept only when it may teach the canteen's
-- gallery (a face match, or a hand-pick among the scan's five closest).
-- scan_*: what the scan made of the face, for a face match and a hand-pick
-- alike — the best score, the two closest people, and how many frames it took.

ALTER TABLE "canteen_servings"
  ADD COLUMN IF NOT EXISTS "face_embedding" jsonb,
  ADD COLUMN IF NOT EXISTS "scan_score" real,
  ADD COLUMN IF NOT EXISTS "scan_closest_id" uuid REFERENCES "employees"("id"),
  ADD COLUMN IF NOT EXISTS "scan_second_score" real,
  ADD COLUMN IF NOT EXISTS "scan_second_id" uuid REFERENCES "employees"("id"),
  ADD COLUMN IF NOT EXISTS "scan_frames" smallint;

CREATE INDEX IF NOT EXISTS "ix_servings_face_embedding"
  ON "canteen_servings" ("employee_id", "meal_date")
  WHERE "face_embedding" IS NOT NULL;
