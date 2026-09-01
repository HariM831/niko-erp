-- A jumbo box holds 180 eggs, not 210.
--
-- One eggs-per-box figure priced every size, so a jumbo box was invoiced for
-- 210 eggs when it holds 180: thirty eggs a box that were never in it, about
-- 17% over. Nothing has been billed wrong, because no jumbo has yet been
-- graded or dispatched in either environment; this closes it before the first
-- one is.
ALTER TABLE egg_sales_preferences
  ADD COLUMN jumbo_eggs_per_box integer NOT NULL DEFAULT 180;
