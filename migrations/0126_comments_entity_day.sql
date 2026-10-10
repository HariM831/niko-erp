-- A comment on one day of one employee (10 Oct 2026): HR's note on the
-- attendance calendar — "leave form came in late", "sent to the mill". The day
-- has no row of its own to hang a comment on (attendance_days is rewritten by
-- every recompute), so the comment names the employee and carries the date.
-- Null for every other kind of comment.
ALTER TABLE "comments" ADD COLUMN "entity_day" date;
