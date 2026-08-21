-- Milling overhead goes from ₹750 to ₹1,000 a ton.
--
-- Paired with production finally applying `mill_moisture_retention`, which it
-- had been ignoring while the formulator costed against it. Together they are
-- what an owner is charged for feed: raw material, plus ₹1 a kg, over the 99%
-- that actually comes out of the mill.
--
-- Only new production is affected. Batches already made keep the cost they were
-- made at, and the feed transfers raised from them keep their stored rate —
-- restating a milling run from months ago would rewrite closed periods.
UPDATE "preferences" SET "mill_overhead_per_kg" = 1.00;
ALTER TABLE "preferences" ALTER COLUMN "mill_overhead_per_kg" SET DEFAULT 1.00;
