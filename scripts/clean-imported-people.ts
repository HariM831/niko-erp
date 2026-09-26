/**
 * The junk Amino's people carried across, taken out of the fields that matter.
 *
 * Amino let HR type anything into an identity field, and "N/A", "Pending" and
 * "nil" are all over them. Three of those are not cosmetic:
 *
 *   A bank account number beginning with a comma. 104 of them — a CSV import
 *   into Amino years ago, the comma never stripped. niko writes payment files
 *   from this column, and ",30935103625" is not an account any bank will pay.
 *
 *   A PAN that is not a PAN. niko checks the length on save, so an employee
 *   whose PAN says "Pending" cannot be saved AT ALL — not their photograph,
 *   not their shift, nothing. That is how it was found: HR could not enrol a
 *   face because the form refused to save a record it had not touched.
 *
 *   An email that is not an email, which will be mailed a payslip one day.
 *
 * Blank is the honest value for all of these. A number nobody has is not
 * "Pending" — it is missing, and the form will say so. [[ask-never-guess]]
 *
 * Dry by default; `--apply` writes, in one transaction.
 *
 *   npx tsx scripts/clean-imported-people.ts
 *   npx tsx scripts/clean-imported-people.ts --apply
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");

const say = (s = "") => console.log(s);
say("\n  CLEANING THE IMPORTED PEOPLE\n");

/** Words people type into a field they have nothing for. */
const PLACEHOLDER = `^(n/?a|na|nil|none|null|pending|not applicable|no|-|\\.)$`;

const steps: Array<{ what: string; count: string; fix: string }> = [
  {
    what: "bank account numbers carrying something that is not a digit",
    count: `SELECT count(*)::int AS n FROM employees
             WHERE bank_account_number ~ '[^0-9]' AND regexp_replace(bank_account_number, '[^0-9]', '', 'g') <> ''`,
    // The digits are the account; the comma is the accident. A value with no
    // digits at all is not an account number and goes blank instead.
    fix: `UPDATE employees
             SET bank_account_number = regexp_replace(bank_account_number, '[^0-9]', '', 'g'), updated_at = now()
           WHERE bank_account_number ~ '[^0-9]' AND regexp_replace(bank_account_number, '[^0-9]', '', 'g') <> ''`,
  },
  {
    what: "bank account numbers with no digits in them at all",
    count: `SELECT count(*)::int AS n FROM employees
             WHERE bank_account_number IS NOT NULL AND bank_account_number <> ''
               AND regexp_replace(bank_account_number, '[^0-9]', '', 'g') = ''`,
    fix: `UPDATE employees SET bank_account_number = NULL, updated_at = now()
           WHERE bank_account_number IS NOT NULL AND bank_account_number <> ''
             AND regexp_replace(bank_account_number, '[^0-9]', '', 'g') = ''`,
  },
  {
    what: "PANs that are not ten characters",
    count: `SELECT count(*)::int AS n FROM employees
             WHERE pan_number IS NOT NULL AND pan_number <> ''
               AND length(regexp_replace(upper(pan_number), '[^A-Z0-9]', '', 'g')) <> 10`,
    fix: `UPDATE employees SET pan_number = NULL, updated_at = now()
           WHERE pan_number IS NOT NULL AND pan_number <> ''
             AND length(regexp_replace(upper(pan_number), '[^A-Z0-9]', '', 'g')) <> 10`,
  },
  {
    what: "emails that are not an address",
    count: `SELECT count(*)::int AS n FROM employees
             WHERE email IS NOT NULL AND email <> '' AND email !~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`,
    fix: `UPDATE employees SET email = NULL, updated_at = now()
           WHERE email IS NOT NULL AND email <> '' AND email !~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`,
  },
  {
    what: "UAN and ESI numbers reading N/A, Pending or the like",
    count: `SELECT (
               (SELECT count(*) FROM employees WHERE uan_number ~* '${PLACEHOLDER}')
             + (SELECT count(*) FROM employees WHERE esi_number ~* '${PLACEHOLDER}')
             )::int AS n`,
    fix: `UPDATE employees
             SET uan_number = CASE WHEN uan_number ~* '${PLACEHOLDER}' THEN NULL ELSE uan_number END,
                 esi_number = CASE WHEN esi_number ~* '${PLACEHOLDER}' THEN NULL ELSE esi_number END,
                 updated_at = now()
           WHERE uan_number ~* '${PLACEHOLDER}' OR esi_number ~* '${PLACEHOLDER}'`,
  },
  {
    what: "blank strings where nothing means nothing",
    count: `SELECT count(*)::int AS n FROM employees
             WHERE '' IN (coalesce(pan_number,'x'), coalesce(aadhar_number,'x'), coalesce(uan_number,'x'),
                          coalesce(esi_number,'x'), coalesce(email,'x'), coalesce(date_of_leaving::text,'x'))`,
    fix: `UPDATE employees
             SET pan_number = nullif(pan_number, ''), aadhar_number = nullif(aadhar_number, ''),
                 uan_number = nullif(uan_number, ''), esi_number = nullif(esi_number, ''),
                 email = nullif(email, ''), updated_at = now()
           WHERE '' IN (coalesce(pan_number,'x'), coalesce(aadhar_number,'x'), coalesce(uan_number,'x'),
                        coalesce(esi_number,'x'), coalesce(email,'x'))`,
  },
];

await db.transaction(async (tx) => {
  for (const step of steps) {
    const [{ n }] = (await tx.execute(sql.raw(step.count))).rows as Array<{ n: number }>;
    say(`  ${String(n).padStart(4)}  ${step.what}`);
    if (n > 0 && APPLY) await tx.execute(sql.raw(step.fix));
  }
  say();
  if (!APPLY) {
    say("  dry run — nothing written. Re-run with --apply.\n");
    throw new Error("__dry__");
  }
  say("  applied.\n");
}).catch((e) => {
  if (!(e instanceof Error) || e.message !== "__dry__") throw e;
});

process.exit(0);
