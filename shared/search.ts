/**
 * Does what was typed find this row?
 *
 * Every word typed has to appear somewhere in the row, as written — so "ram
 * 0114" wants both, and "0114" finds the codes that contain it. Deliberately
 * not a fuzzy scorer: Amino's first picker used one, and typing an employee
 * code returned a dozen unrelated people whose letters happened to fall in
 * order.
 */
export function matchesTerms(haystack: string, query: string): boolean {
  const hay = haystack.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

/**
 * First day of the month `monthsBack` before the given pay month, as
 * YYYY-MM-DD — the cutoff for "joined recently". Wraps the year.
 */
export function monthsBefore(year: number, month: number, monthsBack: number): string {
  const total = year * 12 + (month - 1) - monthsBack;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}
