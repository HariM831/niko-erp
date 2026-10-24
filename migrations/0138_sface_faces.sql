-- Faces are read by SFace on the server from 23 Oct 2026 (docs/face-sface-plan.md).
--
-- On the farm's own gate photos Human's FaceRes, which ran on the phone, put
-- the wrong name on about 16 scans in 100 against a single enrolment photo;
-- OpenCV's SFace on about 1. Every vector stored so far is FaceRes's — 1024
-- numbers that mean nothing to SFace's 128 — so they go, rather than sit in
-- galleries matching nobody.
--
-- Nothing is lost that cannot be made again: face_enrolled_at stays set, and
-- the server re-enrols each of those workers from photo_url at boot
-- (services/face-enrol.ts). The gate's taught captures come back as the gate
-- scans, or at once from recent punch photos with
-- scripts/backfill-face-vectors.ts.
--
-- updated_at drives the devices' delta pull, and every write bumps it.
UPDATE "employees" SET "face_descriptor" = NULL, "updated_at" = now() WHERE "face_descriptor" IS NOT NULL;
--> statement-breakpoint
UPDATE "punches" SET "face_embedding" = NULL WHERE "face_embedding" IS NOT NULL;
--> statement-breakpoint
UPDATE "canteen_servings" SET "face_embedding" = NULL WHERE "face_embedding" IS NOT NULL;
