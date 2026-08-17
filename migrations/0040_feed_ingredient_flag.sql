-- Which items the feed mill actually mixes.
--
-- The org buys ninety-odd things and mixes a dozen; without a flag every
-- diluent, PVC pipe and generator lines up on the Nutrient Profiles screen
-- and in the formulator's ingredient list. Finished feed stays false — its
-- analysis is a consequence of the formula, not an input anybody types.
ALTER TABLE "items" ADD COLUMN "is_feed_ingredient" boolean DEFAULT false NOT NULL;
