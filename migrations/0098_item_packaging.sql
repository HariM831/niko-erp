-- Packaging: egg boxes, trays, tape, strap, jute. A real cost of every egg
-- sold, bought on 88 bill lines in the Zoho years, and until now filed under
-- nothing. Its own category so the boxes can be reported against the eggs
-- they carried, and so the invoice form can leave them out.
ALTER TYPE "item_category" ADD VALUE IF NOT EXISTS 'packaging';
