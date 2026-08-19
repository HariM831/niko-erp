-- A house has a SITE and an OWNER, and they are not the same axis.
--
-- 0052 conflated them: `location_id` was filled from the feed mill export's
-- "farm name", which turned out to be company names — Nandamuri, Luit Valley,
-- Amino. In fact all six sheds stand at one site, Nalbari, and three companies
-- own two each. Panbari is the next site and will carry L6–L10.
--
-- The distinction is not cosmetic. It decides who gets billed: feed delivered
-- to L4 is a sale to Luit Valley, and the eggs L4 lays are a purchase from
-- them. Group the sheds by site and that billing disappears; group them by
-- company and you cannot answer "what is standing at Nalbari".
--
-- owner_id NULL means the shed is ours — Amino keeps these books, so Amino is
-- the org, not a contact. A self-referencing contact would invite somebody to
-- raise an invoice from us to us.
ALTER TABLE "houses"
  ADD COLUMN IF NOT EXISTS "owner_id" uuid REFERENCES "contacts"("id");

CREATE INDEX IF NOT EXISTS "ix_houses_owner" ON "houses" ("owner_id");
