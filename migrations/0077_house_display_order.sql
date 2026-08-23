-- Houses in shed order, everywhere.
--
-- The Amino import filled display_order with the export's row index, which
-- put L3 before L2. Every list in the app orders by display_order (some by
-- code as a workaround); set the order from the code itself so both agree:
-- layers by number, then pullets by number. A house with no number sorts
-- last within its purpose.
UPDATE "houses" h SET "display_order" =
  (CASE WHEN h."purpose" = 'layer' THEN 0 ELSE 100 END)
  + COALESCE(NULLIF(regexp_replace(h."code", '\D', '', 'g'), '')::int, 99);
