-- A face people can go on teaching, instead of one photo forever.
--
-- Every scan matches against the single descriptor taken at enrolment, so a
-- worker photographed badly once is matched badly for good: no way to improve
-- and no way for them to fix it themselves. The gate already computes an
-- embedding for every scan and throws it away.
--
-- Keep it. `punches.method` says where it came from — 'face' is a match the
-- gate accepted on its own, 'manual' is the guard picking the name after the
-- scan missed. Both teach, because the workers who need teaching are exactly
-- the ones who never auto-match, but the two stay distinguishable so a
-- wrong-person capture can be found and cleared by source.
--
-- Nulled rather than deleted when it ages out: the punch is the attendance
-- record and outlives its vector by years.
ALTER TABLE punches
  ADD COLUMN face_embedding jsonb;

-- The gallery read asks for one capture per day, newest days first, per
-- employee — and the nightly prune walks the same order to clear what the
-- read no longer serves.
CREATE INDEX ix_punches_face_gallery
  ON punches (employee_id, punch_date DESC)
  WHERE face_embedding IS NOT NULL;
