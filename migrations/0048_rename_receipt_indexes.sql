-- The remaining index names from when these tables were "procurement_*".
-- A table rename carries its indexes but keeps their names, which is harmless
-- until somebody reads ix_pr_queue on a table called office_receipts and has to
-- work out whether it belongs.
ALTER INDEX IF EXISTS "ix_pr_queue" RENAME TO "ix_or_queue";
ALTER INDEX IF EXISTS "ix_pr_vendor" RENAME TO "ix_or_vendor";
ALTER INDEX IF EXISTS "ix_prl_receipt" RENAME TO "ix_orl_receipt";
ALTER INDEX IF EXISTS "ix_prl_po_line" RENAME TO "ix_orl_po_line";
ALTER INDEX IF EXISTS "ix_prl_item" RENAME TO "ix_orl_item";
ALTER INDEX IF EXISTS "uq_prl_line_no" RENAME TO "uq_orl_line_no";
