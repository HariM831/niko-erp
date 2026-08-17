-- Deductions move from a vendor credit onto the bill itself.
--
-- Settlement used to raise a bill at the vendor's figure and a separate vendor
-- credit for what we would not pay, then apply one to the other. The credit was
-- never countersigned or returned, so the second document bought nothing that a
-- negative line on the first does not — and a line keeps the goods figure tying
-- to the vendor's invoice, with the difference explained one row below it.
--
-- No foreign key to deduction_rules: procurement's schema imports the purchases
-- schema, so a reference back would close an import cycle. Same reason
-- vendor_credit_lines.rule_id and procurement_receipt_lines.qc_spec_id are bare
-- uuids.
ALTER TABLE "bill_lines" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "rule_version" integer;--> statement-breakpoint
CREATE INDEX "ix_bill_lines_rule" ON "bill_lines" ("rule_id") WHERE "rule_id" IS NOT NULL;
