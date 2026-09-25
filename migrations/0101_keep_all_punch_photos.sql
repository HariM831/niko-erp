-- Keeping the photograph of every punch, not only the doubtful ones.
--
-- niko has always kept a punch photo when the punch was manual or the face
-- match fell under the review score; everything else was recorded without a
-- picture, because a year of them runs to gigabytes nobody opens. This makes
-- that a choice rather than a rule, for a gate being watched closely.

ALTER TABLE payroll_settings
  ADD COLUMN IF NOT EXISTS keep_all_punch_photos boolean NOT NULL DEFAULT false;
