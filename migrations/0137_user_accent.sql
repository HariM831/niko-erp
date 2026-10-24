-- Each user's chosen accent, so it follows them to any browser rather than
-- staying in the one they picked it on. Null means they never chose: the app's
-- default (Niko red from 24 Oct 2026) applies.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accent" varchar(20);
