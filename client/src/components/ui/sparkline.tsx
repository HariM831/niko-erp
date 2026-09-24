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
}: {
  points: SparkPoint[];
  ahead?: SparkAhead[];
  reference?: number | null;
  end?: "dot" | "none";
  colors?: Partial<SparkColors>;
  className?: string;
  empty?: string;
}) {
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

  return (
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
    </svg>
  );
}
