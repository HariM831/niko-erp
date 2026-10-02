import { useState, type PointerEvent, type ReactNode } from "react";

/**
 * `Sparkline` — a small line with one emphasised end.
 *
 * History as a solid line over a soft fill, an optional dashed continuation
 * (a forecast) with an optional shaded band around it, an optional flat
 * reference (a standard), and a dot on the last known point. Home drew the
 * first one for the benchmark price; a shed's lay %, a statement's running
 * balance and the weighbridge settling are the same picture. One of the six
 * shared shapes in docs/ui-visuals-plan.md.
 *
 * The caller decides which points count — this only scales and draws. Fewer
 * than two points is a one-line note, never an empty box.
 */
export interface SparkPoint {
  x: string;
  y: number;
}
export interface SparkAhead extends SparkPoint {
  /** A band around the dashed line — the forecast's p10 / p90. */
  lo?: number;
  hi?: number;
}
/** The point under the pointer, for the caller to put words to. */
export interface SparkPick extends SparkAhead {
  /** True on the dashed half — a forecast, not a known value. */
  ahead: boolean;
}

export interface SparkColors {
  line: string;
  fill: string;
  dashed: string;
  band: string;
  join: string;
  reference: string;
}

/* Tokens, so the accent themes carry through; Home passes its yolk set. */
const DEFAULT: SparkColors = {
  line: "var(--color-brand-500)",
  fill: "var(--color-brand-50)",
  dashed: "var(--color-brand-600)",
  band: "var(--color-brand-100)",
  join: "var(--color-soil-200)",
  reference: "var(--color-soil-400)",
};

const W = 320;
const H = 60;

export function Sparkline({
  points,
  ahead = [],
  reference,
  end = "dot",
  colors,
  className = "h-14 w-full",
  empty = "Not enough history for a line.",
  readout,
}: {
  points: SparkPoint[];
  ahead?: SparkAhead[];
  reference?: number | null;
  end?: "dot" | "none";
  colors?: Partial<SparkColors>;
  className?: string;
  empty?: string;
  /**
   * Point at the line (or tap it) and this says what is there — a day's rate,
   * or a forecast day's figure and range. Without it the line is a picture only.
   */
  readout?: (p: SparkPick) => ReactNode;
}) {
  const [pick, setPick] = useState<number | null>(null);
  if (points.length < 2) return <div className="text-xs text-soil-400">{empty}</div>;
  const c = { ...DEFAULT, ...colors };

  const values = [
    ...points.map((p) => p.y),
    ...ahead.flatMap((p) => [p.y, p.lo ?? p.y, p.hi ?? p.y]),
    ...(reference != null ? [reference] : []),
  ];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const total = points.length + ahead.length;
  const x = (i: number) => (i / (total - 1)) * W;
  const y = (v: number) => H - 6 - ((v - min) / span) * (H - 12);
  const f = (n: number) => n.toFixed(1);

  const last = points[points.length - 1]!;
  const joinX = x(points.length - 1);
  const histPath = points.map((p, i) => `${i ? "L" : "M"}${f(x(i))},${f(y(p.y))}`).join(" ");
  // The dashed half starts at the last actual point, so the line is continuous.
  const aheadPath = ahead.length
    ? `M${f(joinX)},${f(y(last.y))} ` + ahead.map((p, i) => `L${f(x(points.length + i))},${f(y(p.y))}`).join(" ")
    : "";
  const hasBand = ahead.some((p) => p.lo != null && p.hi != null);
  const bandPath = hasBand
    ? `M${f(joinX)},${f(y(last.y))} ` +
      ahead.map((p, i) => `L${f(x(points.length + i))},${f(y(p.hi ?? p.y))}`).join(" ") +
      " " +
      [...ahead].reverse().map((p, i) => `L${f(x(total - 1 - i))},${f(y(p.lo ?? p.y))}`).join(" ") +
      " Z"
    : "";

  const svg = (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} preserveAspectRatio="none" role="img" aria-label={`${points.length} points, last ${last.y}`}>
      <path d={`${histPath} L${f(joinX)},${H} L0,${H} Z`} fill={c.fill} />
      {bandPath && <path d={bandPath} fill={c.band} opacity={0.7} />}
      {reference != null && (
        <line x1={0} y1={y(reference)} x2={W} y2={y(reference)} stroke={c.reference} strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      <path d={histPath} fill="none" stroke={c.line} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
      {aheadPath && (
        <path d={aheadPath} fill="none" stroke={c.dashed} strokeWidth={1.5} strokeDasharray="3 2.5" vectorEffect="non-scaling-stroke" />
      )}
      {ahead.length > 0 && (
        <line x1={joinX} y1={2} x2={joinX} y2={H - 2} stroke={c.join} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      )}
      {end === "dot" && <circle cx={joinX} cy={y(last.y)} r={3} fill={c.dashed} />}
      {readout && pick != null && (
        <>
          <line x1={x(pick)} y1={0} x2={x(pick)} y2={H} stroke={c.reference} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <circle cx={x(pick)} cy={y(pointAt(pick).y)} r={3.5} fill="white" stroke={c.dashed} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
  if (!readout) return svg;

  function pointAt(i: number): SparkPick {
    return i < points.length ? { ...points[i]!, ahead: false } : { ...ahead[i - points.length]!, ahead: true };
  }
  // The nearest day to the pointer. A touch keeps its pick after the finger
  // lifts, so a phone can read it; a mouse lets go when it leaves.
  const choose = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
    setPick(Math.round(frac * (total - 1)));
  };
  const leftPct = pick != null ? (pick / (total - 1)) * 100 : 0;
  return (
    <div
      className="relative cursor-crosshair touch-pan-y select-none"
      onPointerMove={choose}
      onPointerDown={choose}
      onPointerLeave={(e) => e.pointerType === "mouse" && setPick(null)}
    >
      {svg}
      {pick != null && (
        <div
          className="pointer-events-none absolute -top-1 z-10 whitespace-nowrap rounded-md bg-soil-900/90 px-2 py-1 text-[11px] text-white shadow"
          style={{ left: `${leftPct}%`, transform: `translate(${leftPct > 70 ? "-100%" : leftPct < 30 ? "0" : "-50%"}, -100%)` }}
        >
          {readout(pointAt(pick))}
        </div>
      )}
    </div>
  );
}
