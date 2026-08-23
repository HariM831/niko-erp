-- The size items adopted from the Zoho import (Small, Medium, Large, Jumbo
-- were Zoho's own sales items, and every historical egg invoice links to them)
-- came across untracked, as every Zoho item did. They carry stock now.
-- No opening balance is set here: the count on the shelf is data the sheet
-- supplies, not something a migration should invent.
UPDATE "items" SET "track_inventory" = true, "unit" = 'boxes', "category" = 'eggs', "is_active" = true
WHERE "id" IN (SELECT "item_id" FROM "egg_size_items");
