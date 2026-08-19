-- Procurement became Office, in the code and here.
--
-- Names only: not a row moves. The tables keep every column, index, constraint
-- and foreign key they had, because RENAME carries them, and the data inside is
-- untouched — the same goods receipts, under the word the business uses.
--
-- The two string columns matter as much as the tables. document_series.entity
-- and attachments.entity_type hold 'procurement_receipt' as DATA: leave them
-- and the receipt counter stops being found and three bill photographs come
-- loose from the truck they were taken at.
ALTER TABLE "procurement_receipts" RENAME TO "office_receipts";
ALTER TABLE "procurement_receipt_lines" RENAME TO "office_receipt_lines";

UPDATE "document_series" SET entity = 'office_receipt' WHERE entity = 'procurement_receipt';
UPDATE "attachments" SET entity_type = 'office_receipt' WHERE entity_type = 'procurement_receipt';
UPDATE "custom_fields" SET entity = 'office_receipt' WHERE entity = 'procurement_receipt';

-- Indexes and constraints keep their old names after a table rename, which is
-- harmless but reads as a lie six months on.
ALTER INDEX IF EXISTS "uq_pr_active_vehicle" RENAME TO "uq_or_active_vehicle";
ALTER INDEX IF EXISTS "uq_pr_vendor_bill" RENAME TO "uq_or_vendor_bill";
ALTER INDEX IF EXISTS "uq_prl_po_line" RENAME TO "uq_orl_po_line";
