/**
 * A quality spec's limits as a picture: the axis to draw them on, pass /
 * warning / reject as spans of it, and ticks for the three limits.
 *
 * The material quality spec drew these first; the QC station reads the same
 * spec with a reading on it. Both call here, so a "min" parameter fails to the
 * left on both screens and never to the right on one of them.
 */
import type { Band, BandTick } from "../components/ui/band-strip";

export interface SpecLimits {
  direction: "max" | "min";
  target?: string | number | null;
  warnAt?: string | number | null;
  rejectAt?: string | number | null;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * An axis wide enough to show the bands with room either side, so a limit at
 * the very edge does not sit flush against the end of the bar. A reading, when
 * there is one, is kept on the axis too — a sample far out of spec is the one
 * whose position matters most.
 */
export function specAxis(d: SpecLimits, reading?: number | null): { lo: number; hi: number } | null {
  const limits = [num(d.target), num(d.warnAt), num(d.rejectAt)].filter((v): v is number => v != null);
  if (!limits.length) return null;
  const all = reading != null && Number.isFinite(reading) ? [...limits, reading] : limits;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.5, Math.max(Math.abs(hi), 1) * 0.1);
  return { lo: Math.floor(lo - pad), hi: Math.ceil(hi + pad) };
}

/**
 * Pass, warning and reject as spans of the axis, in the parameter's own units.
 *
 * A "max" parameter runs green → amber → red left to right; a "min" runs the
 * other way. A missing limit does not leave a hole — the band beside it takes
 * the space, because a spec with no reject limit really does pass everything
 * above the warning.
 */
export function specBands(d: SpecLimits, ax: { lo: number; hi: number }): Band[] {
  const warn = num(d.warnAt);
  const rej = num(d.rejectAt);
  const out: Band[] = [];
  if (d.direction === "max") {
    out.push({ tone: "pass", from: ax.lo, to: warn ?? rej ?? ax.hi });
    if (warn != null) out.push({ tone: "warn", from: warn, to: rej ?? ax.hi });
    if (rej != null) out.push({ tone: "fail", from: rej, to: ax.hi });
  } else {
    if (rej != null) out.push({ tone: "fail", from: ax.lo, to: rej });
    if (warn != null) out.push({ tone: "warn", from: rej ?? ax.lo, to: warn });
    out.push({ tone: "pass", from: warn ?? rej ?? ax.lo, to: ax.hi });
  }
  return out.filter((b) => b.to > b.from);
}

/** The target, warning and reject limits as ticks under the strip. */
export function specTicks(d: SpecLimits): BandTick[] {
  const target = num(d.target);
  const warn = num(d.warnAt);
  const rej = num(d.rejectAt);
  const ticks: BandTick[] = [];
  if (target != null) ticks.push({ at: target, label: `▲ ${target}`, tone: "pass" });
  if (warn != null) ticks.push({ at: warn, tone: "warn" });
  if (rej != null) ticks.push({ at: rej, tone: "fail" });
  return ticks;
}
