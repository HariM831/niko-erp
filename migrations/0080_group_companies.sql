-- The group companies are not customers or vendors.
--
-- Nandamuri Poultries and Luit Valley Farms own sheds at Nalbari; Amino sells
-- them feed and pullets and buys their eggs back. The documents are real and
-- post to the GL like any other - but the two companies are the group, not
-- the market, and a top-customers list or an AR aging with Luit Valley's
-- 2.33 crore in it says nothing true about the trade. Flagged on the contact
-- and excluded from every customer- and vendor-scoped view; their ledger has
-- its own page under Accountant.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "is_group_company" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "contacts" SET "is_group_company" = true
WHERE "id" IN (SELECT DISTINCT "owner_id" FROM "houses" WHERE "owner_id" IS NOT NULL);
