-- What kind of thing an item is: feed, vaccines, medicines, construction,
-- miscellaneous. Fixed options rather than a custom field because behaviour
-- hangs off them — the formulator offers only feed and medicines, the Farm
-- Store will accept only vaccines, medicines and miscellaneous — and a
-- user-editable option list would let a rename silently break those gates.
CREATE TYPE "public"."item_category" AS ENUM('feed', 'vaccines', 'medicines', 'construction', 'miscellaneous');--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "category" "item_category";--> statement-breakpoint
-- Everything the mill already mixes, and every formula's output, is feed.
UPDATE "items" SET "category" = 'feed' WHERE "is_feed_ingredient" OR "id" IN (SELECT "output_item_id" FROM "formulas");
