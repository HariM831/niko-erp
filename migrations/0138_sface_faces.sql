-- Faces are read by SFace on the phone from 24 Oct 2026 (docs/face-sface-plan.md).
--
-- On the farm's own gate photos Human's FaceRes put the wrong name on about 16
-- scans in 100 against a single enrolment photo; OpenCV's SFace on about 1.
-- Every vector stored so far is FaceRes's — 1024 numbers that cannot be
-- compared with SFace's 128 — so each one moves to a *_faceres column of its
-- own, kept exactly as it was and never matched against again. Nothing is
-- deleted.
--
-- The SFace vectors are made from the photos already on file by
-- scripts/sface-switch-over.ts: every enrolment photo, then every punch photo.
--
-- punches.face_taught says whether a scan passed the check that lets it into
-- its worker's gallery. Every scan's vector is kept from now on, taught or not;
-- the gallery is the first taught scan of each of the worker's last 7 days
-- with one (services/face-gallery.ts).
--
-- updated_at drives the devices' delta pull, and every write bumps it.
ALTER TABLE "employees" ADD COLUMN "face_descriptor_faceres" jsonb;
--> statement-breakpoint
UPDATE "employees" SET "face_descriptor_faceres" = "face_descriptor", "face_descriptor" = NULL, "updated_at" = now() WHERE "face_descriptor" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "punches" ADD COLUMN "face_embedding_faceres" jsonb;
--> statement-breakpoint
ALTER TABLE "punches" ADD COLUMN "face_taught" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "punches" SET "face_embedding_faceres" = "face_embedding", "face_embedding" = NULL WHERE "face_embedding" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "canteen_servings" ADD COLUMN "face_embedding_faceres" jsonb;
--> statement-breakpoint
UPDATE "canteen_servings" SET "face_embedding_faceres" = "face_embedding", "face_embedding" = NULL WHERE "face_embedding" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ix_punches_face_taught" ON "punches" USING btree ("employee_id","punch_date","punched_at") WHERE "punches"."face_taught";
