/**
 * Reading a day out of a silo's weight.
 *
 * Kept apart from the store, like counters.ts, so it runs without a database
 * and can be checked against series copied off the real sheds.
 *
 * The silo's load cells are the one instrument on the farm that sees both
 * sides of the feed: a tanker arriving is a jump of several tonnes in a few
 * minutes, and a feeding run is a fall of three or four tonnes over the best
 * part of an hour. Everything in between is a few kilos of wobble. So the day
 * is cut into MOVES — stretches where the weight goes one way by more than the
 * wobble — and the moves are read as tankers (up) and feeding (down).
 *
 * This is the cross-check on the controller's feed counter, which is itself
 * worked out from the silo during a run and on 7 Oct 2026 missed L2's whole
 * 08:00 run (the silo fell 2,930 kg, the counter added about 400).
 */

export interface SiloSample {
  at: Date;
  kg: number;
}

export interface SiloMove {
  start: Date;
  end: Date;
  /** Positive for a tanker, negative for feeding. */
  kg: number;
}

/** A step smaller than this is wobble, not the silo moving. */
const STEP_KG = 30;
/** A move smaller than this is drift, not a run or a tanker. */
const MOVE_KG = 300;
/** Two quiet readings in a row end a move. */
const QUIET_TO_END = 2;
/** A fall that comes straight back is a glitch in the reading, not feed. */
const GLITCH_MS = 30 * 60_000;

/**
 * The day's moves, from the level before `dayStart` to the last reading
 * before `dayEnd`. Readings below zero are bad readings and are skipped.
 */
export function siloMoves(samples: SiloSample[], dayStart: Date, dayEnd: Date): SiloMove[] {
  const series = samples
    .filter((s) => s.kg >= 0 && s.at < dayEnd)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  // Start from the last reading before midnight, so a run that began at
  // 23:58 counts only what fell after it.
  const firstIn = series.findIndex((s) => s.at >= dayStart);
  if (firstIn < 0) return [];
  const from = Math.max(0, firstIn - 1);

  const moves: SiloMove[] = [];
  let run: { sign: number; kg: number; start: Date; end: Date } | null = null;
  let quiet = 0;
  const close = () => {
    if (run && Math.abs(run.kg) >= MOVE_KG) {
      moves.push({ start: run.start, end: run.end, kg: run.kg });
    }
    run = null;
    quiet = 0;
  };

  for (let i = from + 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    const cur = series[i]!;
    const d = cur.kg - prev.kg;
    if (Math.abs(d) < STEP_KG) {
      if (run && ++quiet >= QUIET_TO_END) close();
      continue;
    }
    const sign = Math.sign(d);
    if (run && run.sign === sign) {
      run.kg += d;
      run.end = cur.at;
      quiet = 0;
      continue;
    }
    close();
    // A move belongs to the day it starts in. Moves still running at
    // midnight were begun the day before and are read from midnight.
    run = { sign, kg: d, start: prev.at < dayStart ? dayStart : prev.at, end: cur.at };
  }
  close();

  // A fall answered by a rise of the same size within half an hour is the
  // reading dropping out and coming back.
  const out: SiloMove[] = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]!;
    const n = moves[i + 1];
    if (
      n &&
      Math.sign(m.kg) !== Math.sign(n.kg) &&
      n.start.getTime() - m.end.getTime() <= GLITCH_MS &&
      Math.abs(m.kg + n.kg) <= 0.1 * Math.abs(m.kg)
    ) {
      i++;
      continue;
    }
    out.push(m);
  }
  return out;
}

/** What the silo says the birds ate: every fall added up. */
export function siloFed(moves: SiloMove[]): number {
  return Math.round(moves.filter((m) => m.kg < 0).reduce((s, m) => s - m.kg, 0));
}

/** The tankers the silo saw, in order. */
export function siloTankers(moves: SiloMove[]): SiloMove[] {
  return moves.filter((m) => m.kg > 0);
}

/**
 * Did the controller report the whole day?
 *
 * Two ways it does not. The house drops off the network and nothing arrives
 * (a gap). Or the vendor's cloud keeps serving the last values it had while
 * the house is unreachable, and the backfill stores them — L2 read 8,412 kg
 * fed and 30,100 L drunk, unchanged, from 17:00 on 1 Oct until 14:00 on
 * 2 Oct. The water meter ticks every few minutes in a house with birds in
 * it, night included, so three hours without it moving is a frozen feed.
 */
export interface DayCoverage {
  complete: boolean;
  reason: string | null;
}

const MAX_GAP_MS = 60 * 60_000;
const FROZEN_MS = 3 * 3_600_000;
const EDGE_MS = 30 * 60_000;

export function dayCoverage(
  samples: Array<{ at: Date; waterL: number | null }>,
  dayStart: Date,
  dayEnd: Date,
): DayCoverage {
  const inDay = samples
    .filter((s) => s.at >= dayStart && s.at < dayEnd)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!inDay.length) return { complete: false, reason: "No readings from the controller that day." };
  if (inDay[0]!.at.getTime() - dayStart.getTime() > EDGE_MS) {
    return { complete: false, reason: `No readings until ${hhmm(inDay[0]!.at)}.` };
  }
  if (dayEnd.getTime() - inDay[inDay.length - 1]!.at.getTime() > EDGE_MS) {
    return { complete: false, reason: `No readings after ${hhmm(inDay[inDay.length - 1]!.at)}.` };
  }
  for (let i = 1; i < inDay.length; i++) {
    const gap = inDay[i]!.at.getTime() - inDay[i - 1]!.at.getTime();
    if (gap > MAX_GAP_MS) {
      return {
        complete: false,
        reason: `No readings from ${hhmm(inDay[i - 1]!.at)} to ${hhmm(inDay[i]!.at)}.`,
      };
    }
  }
  const metered = inDay.filter((s) => s.waterL != null);
  if (!metered.length) return { complete: true, reason: null };
  let since = metered[0]!;
  for (const s of metered) {
    if (s.waterL !== since.waterL) {
      since = s;
      continue;
    }
    if (s.at.getTime() - since.at.getTime() > FROZEN_MS) {
      return {
        complete: false,
        reason: `The controller repeated one reading from ${hhmm(since.at)} — it was not reporting.`,
      };
    }
  }
  return { complete: true, reason: null };
}

const hhmm = (d: Date) =>
  d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
