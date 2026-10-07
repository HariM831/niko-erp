-- Dirty is counted in trays of 30 and SOLD in boxes of 210 (7 Oct 2026): the
-- figure is eggs per stock tray, not per box sold.
ALTER TABLE "egg_sales_preferences" RENAME COLUMN "dirty_eggs_per_box" TO "dirty_eggs_per_tray";
