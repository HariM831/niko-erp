/**
 * Reading the controllers' daily counters.
 *
 * Kept apart from the store so it can be run without a database: these are
 * the rules a number on the board depends on, and they are checked against
 * series copied off the real sheds.
 */

/**
 * The highest value of a daily counter since it last fell and stayed down.
 *
 * A fall to under a fifth of the running peak that the NEXT sample confirms is
 * a reset, and the day starts over from there. A fall the next sample undoes
 * is a dropout and is skipped. A fall in the newest sample has no next sample
 * to judge it by, so it is left for the next poll — five minutes of showing
 * the old day's total beats five minutes of showing a glitch as the day.
 */
export function sinceReset(values: number[]): number | null {
  let peak: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (peak == null || v > peak) {
      peak = v;
      continue;
    }
    if (peak > 0 && v < 0.2 * peak) {
      const next = values[i + 1];
      if (next != null && next < 0.2 * peak) {
        peak = Math.max(v, next);
        i++;
      }
    }
  }
  return peak == null ? null : Math.max(peak, 0);
}
