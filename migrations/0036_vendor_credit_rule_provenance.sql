-- Which deduction rule charged a credit line, and which version of it.
--
-- Settlement already computed both and carried them through the whole chain,
-- then dropped them at write time — so a deduction was explicable only by
-- reading the credit note's prose, never by query. A rule could not be asked
-- what it had cost, and a version could not be retired knowing what it charged.
--
-- No foreign key: shared/schema/procurement.ts imports the purchases schema, so
-- pointing back at deduction_rules would close an import cycle. Same reason
-- procurement_receipt_lines.qc_spec_id is a bare uuid.
ALTER TABLE "vendor_credit_lines" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN "rule_version" integer;--> statement-breakpoint
CREATE INDEX "ix_vendor_credit_lines_rule" ON "vendor_credit_lines" ("rule_id") WHERE "rule_id" IS NOT NULL;
