-- The daily intake a feed standard's concentrations are written for.
--
-- Hy-Line prints layer requirements per bird per day and tabulates the
-- concentrations by intake (guide p.27): Layer 1 at 85-105 g with 95 typical,
-- Layer 2 at 90-110 with 100, Layer 3 at 95-115 with 105. niko loaded the
-- typical column. Recording it lets a solve scale every requirement to what
-- the sheds eating that feed actually eat. The live layer standards are set
-- here; production has none yet, so there it touches nothing.
ALTER TABLE "feed_standards" ADD COLUMN "reference_intake_g" numeric(6, 1);
--> statement-breakpoint
UPDATE "feed_standards" SET "reference_intake_g" = CASE "stage"::text WHEN 'layer_1' THEN 95 WHEN 'layer_2' THEN 100 WHEN 'layer_3' THEN 105 END
WHERE "stage"::text IN ('layer_1', 'layer_2', 'layer_3') AND "reference_intake_g" IS NULL;
