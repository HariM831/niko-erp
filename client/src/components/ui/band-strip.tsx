/**
 * `BandStrip` — a reading on a min / warn / max track.
 *
 * Coloured stretches of an axis, ticks under it, and a marker where the
 * reading sits. The material quality spec drew the first one to show pass,
 * warning and reject as widths; a QC entry at the weighbridge, a nutrient
 * requirement in the formulator and a stock level against its reorder point
 * are the same picture. One of the six shared shapes in
 * docs/ui-visuals-plan.md.
 *
 * The strip knows nothing about what the bands mean — which way a "min"
 * parameter fails, what a reorder level is. The caller works that out and
 * hands over spans in axis units; this only draws.
 */
export type BandTone = "pass" | "warn" | "fail" | "neutral";

export interface Band {
  from: number;
  to: number;
  tone: BandTone;
}

export interface BandTick {
  at: number;
  /** Defaults to the number itself. */
  label?: string;
  tone?: BandTone;
}

const BAND: Record<BandTone, string> = {
  pass: "bg-green-200",
  warn: "bg-amber-200",
  fail: "bg-red-200",
  neutral: "bg-gray-200",
};
const TICK: Record<BandTone, string> = {
  pass: "text-green-700",
  warn: "text-amber-700",
  fail: "text-red-700",
  neutral: "text-gray-500",
};

export function BandStrip({
  lo,
  hi,
  bands,
  ticks = [],
  marker,
  markerLabel,
  unit = "",
  ends = true,
  compact = false,
  className = "",
}: {
  lo: number;
  hi: number;
  bands: Band[];
  ticks?: BandTick[];
  /** The reading, in axis units. */
  marker?: number | null;
  /** Its label in the tick row, only when given — a reading already shown beside the strip (the QC input) would only collide with the limits. */
  markerLabel?: string;
  /** Appended to the right-hand end label only — repeating it on every tick crowds the strip. */
  unit?: string;
  /** Show lo and hi at the ends of the tick row. */
  ends?: boolean;
  /** A thin strip with no tick row, for a table cell; the caller puts the figures in a title. */
  compact?: boolean;
  className?: string;
}) {
  const h = compact ? "h-1.5" : "h-2.5";
  if (!(hi > lo)) {
    return <div className={`${h} rounded bg-gray-100 ${className}`} />;
  }
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const hasMarker = marker != null && Number.isFinite(marker);

  return (
    <div className={className}>
      <div className={`relative ${h} overflow-hidden rounded bg-gray-100`}>
        {bands
          .filter((b) => b.to > b.from)
          .map((b, i) => (
            <div
              key={i}
              className={`absolute inset-y-0 ${BAND[b.tone]}`}
              style={{ left: `${pct(b.from)}%`, width: `${pct(b.to) - pct(b.from)}%` }}
            />
          ))}
        {hasMarker && (
          <div
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-gray-800"
            style={{ left: `${pct(marker)}%` }}
            aria-hidden
          />
        )}
      </div>
      {/* Only the ends of the axis carry the unit — repeating it on every tick
          crowds four labels into a bar that is often 300px wide. */}
      {!compact && (
      <div className="relative mt-0.5 h-4 text-[10px] text-gray-400">
        {ends && <span className="absolute left-0">{lo}</span>}
        {ticks.map((t, i) => (
          <span
            key={i}
            className={`absolute -translate-x-1/2 whitespace-nowrap ${TICK[t.tone ?? "neutral"]}`}
            style={{ left: `${pct(t.at)}%` }}
          >
            {t.label ?? t.at}
          </span>
        ))}
        {hasMarker && markerLabel != null && (
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap font-semibold text-gray-800"
            style={{ left: `${pct(marker)}%`, top: 0 }}
          >
            {markerLabel}
          </span>
        )}
        {ends && (
          <span className="absolute right-0">
            {hi}
            {unit}
          </span>
        )}
      </div>
      )}
    </div>
  );
}
