-- Centred face matching, recorded beside the raw decision and switched off
-- (docs/face-matching-centred-plan.md, steps 1-2 and rollout 1-2).
--
-- face_models holds the roster's mean face, one row per nightly build. Every
-- punch and plate the browser gates record now also says what centred
-- matching made of the same face: the build it used, whom it picked, at what
-- score, and the runner-up. Nothing reads these to decide anything; two weeks
-- of them calibrate the centred thresholds before the switch exists.
CREATE TABLE "face_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mean" double precision[] NOT NULL,
  "dim" integer NOT NULL,
  "people" integer NOT NULL,
  "built_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "punches" ADD COLUMN "face_model_id" uuid REFERENCES "face_models"("id");
ALTER TABLE "punches" ADD COLUMN "centred_match_id" uuid REFERENCES "employees"("id");
ALTER TABLE "punches" ADD COLUMN "match_score_centred" real;
ALTER TABLE "punches" ADD COLUMN "centred_second_score" real;

ALTER TABLE "canteen_servings" ADD COLUMN "face_model_id" uuid REFERENCES "face_models"("id");
ALTER TABLE "canteen_servings" ADD COLUMN "centred_match_id" uuid REFERENCES "employees"("id");
ALTER TABLE "canteen_servings" ADD COLUMN "match_score_centred" real;
ALTER TABLE "canteen_servings" ADD COLUMN "centred_second_score" real;
