-- The payroll system keys, re-hung on the accounts that actually exist.
--
-- 0081 keyed them by the seed chart's codes (6501 Salary & Bonus...), but the
-- live database's chart came from the Zoho dump, where 6501 is Administrative
-- Expense. A system key is a meaning, not a code — so it is assigned by name,
-- and only where the name plainly says what the account is. Fresh databases
-- built from seed.ts get the keys with the seed and skip every UPDATE here.

-- Take the keys off any account whose name says it is something else.
UPDATE "accounts" SET "system_key" = NULL
WHERE "system_key" IN ('salary_expense','wages_expense','pf_employer_expense','esi_employer_expense','pf_payable','esi_payable','pt_payable','salary_payable')
  AND NOT (
    ("system_key" = 'salary_expense'       AND "name" ~* 'salar')                   OR
    ("system_key" = 'wages_expense'        AND "name" ~* 'wage')                    OR
    ("system_key" = 'pf_employer_expense'  AND "name" ~* 'provident')               OR
    ("system_key" = 'esi_employer_expense' AND "name" ~* 'esi')                     OR
    ("system_key" = 'pf_payable'           AND "name" ~* 'pf|provident')            OR
    ("system_key" = 'esi_payable'          AND "name" ~* 'esi')                     OR
    ("system_key" = 'pt_payable'           AND "name" ~* 'professional')            OR
    ("system_key" = 'salary_payable'       AND "name" ~* 'salar|expenses payable')
  );
--> statement-breakpoint
-- Hang each key on the best-named postable account, if the key is unplaced.
DO $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('salary_expense',       ARRAY['Salary & Bonus', 'Salaries and Employee Wages']),
      ('wages_expense',        ARRAY['Labour Wages']),
      ('pf_employer_expense',  ARRAY['Contribution to Provident Fund']),
      ('esi_employer_expense', ARRAY['Contribution to ESIC', 'ESI Contribution']),
      ('pf_payable',           ARRAY['PF Payable', 'PF AND ESI Payable']),
      ('esi_payable',          ARRAY['ESI Payable']),
      ('pt_payable',           ARRAY['Professional Tax Payable']),
      ('salary_payable',       ARRAY['Salary Payable', 'Net Salary Payable', 'Expenses Payable (Salaries and others)'])
    ) AS v(key, names)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE system_key = pair.key) THEN
      UPDATE accounts SET system_key = pair.key
      WHERE id = (
        SELECT a.id FROM accounts a
        JOIN unnest(pair.names) WITH ORDINALITY AS n(name, ord) ON a.name = n.name
        WHERE a.system_key IS NULL AND NOT a.is_group
        ORDER BY n.ord LIMIT 1
      );
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Professional tax has no Zoho ancestor; make the account when it is missing.
INSERT INTO "accounts" ("code", "name", "type", "subtype", "system_key", "is_group")
SELECT 'PT-1', 'Professional Tax Payable', 'liability', 'other_current_liability', 'pt_payable', false
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE system_key = 'pt_payable');
