-- Sent and paid invoices can be edited, as in Zoho.
--
-- The setting existed but defaulted off, and the invoice screen offered Edit on
-- drafts alone — so nothing issued could be corrected short of a credit note.
-- Decided 28 Sep 2026: an issued invoice, paid or not, can be edited; the money
-- applied to it stays applied and the edit only has to leave room for it.
-- Existing rows only ever held the default.
ALTER TABLE "preferences" ALTER COLUMN "allow_editing_sent_invoice" SET DEFAULT true;
UPDATE "preferences" SET "allow_editing_sent_invoice" = true;
