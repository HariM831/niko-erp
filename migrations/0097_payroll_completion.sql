-- The rest of what Amino has and niko lacked, and room for Amino's history.
-- Plan: docs/payroll-completion-plan.md.
--
-- Why a name was picked by hand at the gate. A refused camera and a face that
-- did not match are different problems; the failure report counted both as the
-- face failing. Null on older rows reads as "no match", which is what a manual
-- punch could only have meant before.
ALTER TABLE "punches" ADD COLUMN IF NOT EXISTS "manual_reason" varchar(20);
