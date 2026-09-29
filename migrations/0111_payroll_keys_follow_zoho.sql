-- Payroll posts where Zoho booked payroll, and four unused keys come off.
--
-- The user, 29 Sep 2026. 0082 hung the payroll keys on accounts whose names
-- said salary, PF or ESI - but the live chart holds two of each, and it chose
-- the ones Zoho never posted to. A year of Zoho payroll sits in 6050 Salaries
-- and Employee Wages (Rs 2.09 crore), 2036 Salary Payable, 6549 PF Contribution
-- and 6546 ESI Contribution; niko's first run would have opened a second set
-- beside them. Each key moves only where exactly one account carries the name,
-- so a chart built from seed.ts, which has none of these names, is untouched.
--
-- wages_expense stays where it is: a key is unique to one account, and 6050
-- already takes salary_expense.
--
-- bank_charges, inventory, owners_capital and tds_receivable are read by no
-- code at all. The accounts stay (Bank Charges alone holds Rs 7.6 lakh of
-- history); only the key comes off, so nothing claims a meaning it does not have.

UPDATE "accounts" SET "system_key" = NULL
WHERE "system_key" IN ('bank_charges', 'inventory', 'owners_capital', 'tds_receivable');

UPDATE "accounts" SET "system_key" = NULL
WHERE ("system_key" = 'salary_expense'       AND (SELECT count(*) FROM accounts WHERE name = 'Salaries and Employee Wages') = 1)
   OR ("system_key" = 'salary_payable'       AND (SELECT count(*) FROM accounts WHERE name = 'Salary Payable') = 1)
   OR ("system_key" = 'pf_employer_expense'  AND (SELECT count(*) FROM accounts WHERE name = 'PF Contribution') = 1)
   OR ("system_key" = 'esi_employer_expense' AND (SELECT count(*) FROM accounts WHERE name = 'ESI Contribution') = 1);

UPDATE "accounts" SET "system_key" = 'salary_expense'
WHERE name = 'Salaries and Employee Wages' AND (SELECT count(*) FROM accounts WHERE name = 'Salaries and Employee Wages') = 1;
UPDATE "accounts" SET "system_key" = 'salary_payable'
WHERE name = 'Salary Payable' AND (SELECT count(*) FROM accounts WHERE name = 'Salary Payable') = 1;
UPDATE "accounts" SET "system_key" = 'pf_employer_expense'
WHERE name = 'PF Contribution' AND (SELECT count(*) FROM accounts WHERE name = 'PF Contribution') = 1;
UPDATE "accounts" SET "system_key" = 'esi_employer_expense'
WHERE name = 'ESI Contribution' AND (SELECT count(*) FROM accounts WHERE name = 'ESI Contribution') = 1;
