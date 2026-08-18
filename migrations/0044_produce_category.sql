-- The farm's own output — eggs, birds, manure — gets a category of its own.
-- They are sold, not store goods, and forcing them under Miscellaneous would
-- have made that label meaningless. Adding the value only: rows are
-- categorised by a separate statement because Postgres refuses to USE a new
-- enum value in the transaction that created it.
ALTER TYPE "public"."item_category" ADD VALUE 'produce' BEFORE 'miscellaneous';
