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
 * The series is cut into runs at each reset. A reset looks like a fall to
 * under a fifth of the running peak — but so does a dropout, and the two are
 * told apart by what comes AFTER the low stretch:
 *
 *   · The counter comes back near where it was: a dropout. L3 went 4115, 0,
 *     4115 inside fifteen minutes; on 2026-09-01 every shed read 0/0 for ten
 *     minutes and then carried on from 10,933. The low samples are skipped.
 *     Taking that stretch for a reset counted the whole day twice.
 *
 *   · The counter comes back low and climbing: a reset. The run ends at the
 *     fall and a new one begins there.
 *
 *   · The series ends inside the low stretch. Two or more low samples are
 *     taken as a reset; a single one waits for the next poll, because five
 *     minutes of showing the old total beats five minutes of showing a
 *     glitch as the day.
 *
 * "Near where it was" is half the old peak, judged on the first sample back
 * over a fifth of it. After a reset that sample sits at about a fifth; after
 * a dropout it sits at the old level. This needs samples closer together
 * than half a day's eating, which even the hourly thinning of old data is.
 *
 * Each run that reaches into the day contributes its peak less the value it
 * held at midnight, and the day is their sum. Null when nothing was sampled
 * after `dayStart`.
 */
export function climbSince(samples: CounterSample[], dayStart: Date): number | null {
  interface Run {
    peak: number;
    /** The counter at midnight — the last value seen before it, else zero. */
    baseline: number;
    inDay: boolean;
  }
  const runs: Run[] = [];
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

  let run: Run | null = null;
  let i = 0;
  while (i < samples.length) {
    const s = samples[i]!;
    if (!run) {
      run = open(s);
      i++;
      continue;
    }
    const low = run.peak > 0 && s.v < 0.2 * run.peak;
    if (!low) {
      extend(run, s);
      i++;
      continue;
    }
    // A low stretch: find where the counter comes back, if it does.
    let j = i;
    while (j < samples.length && samples[j]!.v < 0.2 * run.peak) j++;
    const back = samples[j];
    const dropout = back ? back.v >= 0.5 * run.peak : j - i < 2;
    if (dropout) {
      i = j;
      continue;
    }
    run = open(s);
    for (let k = i + 1; k < j; k++) extend(run, samples[k]!);
    i = j;
  }

  const today = runs.filter((r) => r.inDay);
  if (!today.length) return null;
  return today.reduce((sum, r) => sum + Math.max(0, r.peak - r.baseline), 0);
}
