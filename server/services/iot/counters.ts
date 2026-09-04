/**
 * Reading the controllers' daily counters.
 *
 * Kept apart from the store so it can be run without a database: these are
 * the rules a number on the board depends on, and they are checked against
 * series copied off the real sheds.
 */

export interface CounterSample {
  at: Date;
  v: number;
}

/**
 * How much a daily counter has climbed since `dayStart`.
 *
 * The controllers' counters reset once a day, but not at the same hour as
 * each other or as the farm: L5's feed rolls over around 21:30 IST, L3's
 * around 02:00, the water meters a few minutes past midnight. So the reading
 * is not "today's" in the farm's sense, and neither is its peak. What the
 * farm wants is the climb since ITS midnight, which may span two of the
 * controller's days: everything the old counter added after midnight before
 * it reset, plus everything the new one has added since.
 *
 * The series is cut into runs at each reset — a fall to under a fifth of the
 * running peak that the NEXT sample confirms. A fall the next sample undoes is
 * a dropout (L3 went 4115, 0, 4115 inside fifteen minutes) and is skipped. A
 * fall in the newest sample has no next sample to judge it by and waits for
 * the next poll: five minutes of showing the old total beats five minutes of
 * showing a glitch as the day. Each run that reaches into the day contributes
 * its peak less the value it held at midnight, and the day is their sum.
 *
 * Null when nothing was sampled after `dayStart`.
 */
export function climbSince(samples: CounterSample[], dayStart: Date): number | null {
  interface Run {
    peak: number;
    /** The counter at midnight — the last value seen before it, else zero. */
    baseline: number;
    inDay: boolean;
  }
  const runs: Run[] = [];
  let run: Run | null = null;

  const open = (s: CounterSample): Run => {
    const r = { peak: s.v, baseline: s.at < dayStart ? s.v : 0, inDay: s.at >= dayStart };
    runs.push(r);
    return r;
  };
  const extend = (r: Run, s: CounterSample) => {
    if (s.v > r.peak) r.peak = s.v;
    if (s.at < dayStart) r.baseline = s.v;
    else r.inDay = true;
  };

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (!run) {
      run = open(s);
      continue;
    }
    if (run.peak > 0 && s.v < 0.2 * run.peak) {
      const next = samples[i + 1];
      if (next && next.v < 0.2 * run.peak) {
        run = open(s);
        extend(run, next);
        i++;
      }
      continue;
    }
    extend(run, s);
  }

  const today = runs.filter((r) => r.inDay);
  if (!today.length) return null;
  return today.reduce((sum, r) => sum + Math.max(0, r.peak - r.baseline), 0);
}
