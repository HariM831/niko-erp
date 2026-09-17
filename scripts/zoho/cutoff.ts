/**
 * The day the books move: the last day of Zoho's history that niko takes on.
 *
 * One value, read by everything that asks Zoho for a statement or a ledger and
 * by everything that compares niko against one. It was a literal in four files
 * while the migration was rehearsed, which is how a statement pulled to one
 * date gets checked against a ledger measured to another.
 *
 * Deliberately not "today": a pull that runs past midnight would otherwise ask
 * for two different days, and toISOString() is UTC, which is yesterday in India
 * until 05:30.
 *
 *   ZOHO_CUTOFF=2026-09-17 npx tsx scripts/zoho/pull-reports.ts
 */
const raw = process.env.ZOHO_CUTOFF ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
  console.error("Set ZOHO_CUTOFF to the cutover date, as YYYY-MM-DD.");
  process.exit(1);
}

export const CUTOFF = raw;
export const EPOCH = "2000-01-01";

/** Last day of the financial year before the cutoff — India runs 1 April to 31 March. */
export const PRIOR_YEARS_END = (() => {
  const [y, m] = CUTOFF.split("-").map(Number) as [number, number];
  return `${m >= 4 ? y : y - 1}-03-31`;
})();
