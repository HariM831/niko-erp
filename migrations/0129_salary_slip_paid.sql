-- A payslip paid from a bank statement line (Banking › Salary Payment, 16 Oct
-- 2026) remembers the journal that paid it, so the same slip is not paid
-- twice. Deleting that journal (uncategorizing the line) frees the slip.
ALTER TABLE "salary_slips" ADD COLUMN "paid_journal_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "uq_salary_slips_paid_je" ON "salary_slips" ("paid_journal_entry_id");
