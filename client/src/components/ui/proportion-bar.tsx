/**
 * `ProportionBar` — one strip, parts of a whole.
 *
 * Receivables by age, a shift by present / absent / not seen, today's eggs by
 * size, the yard by where the trucks stand. One of the six shared shapes in
 * docs/ui-visuals-plan.md.
 *
 * Segments keep the order they are given, so the same component is a
 * waterfall when the caller lists goods value → each deduction → net payable.
 * A segment too thin to read keeps a two-pixel presence rather than vanishing;
 * the legend carries every segment's label and figure whatever its width, so
 * colour is never the only thing saying what a part is.
 */
export type ProportionTone = "neutral" | "brand" | "success" | "warning" | "danger";

export interface ProportionSegment {
  label: string;
  value: number;
  /** The figure as the caller wants it read — "₹31.94 cr", "1,240 boxes". Defaults to the value. */
  display?: string;
  tone?: ProportionTone;
}

/* Neutral segments step through the soil ramp so neighbours differ. */
const NEUTRAL = ["bg-soil-200", "bg-soil-400", "bg-soil-600"];
const FILL: Record<Exclude<ProportionTone, "neutral">, string> = {
  brand: "bg-brand-500",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};
const DOT: Record<Exclude<ProportionTone, "neutral">, string> = FILL;

function fillClass(tone: ProportionTone | undefined, neutralIndex: number): string {
  if (!tone || tone === "neutral") return NEUTRAL[neutralIndex % NEUTRAL.length]!;
  return FILL[tone];
}

export function ProportionBar({
  segments,
  total,
  legend = "below",
  height = "md",
  onSegment,
  className = "",
}: {
  segments: ProportionSegment[];
  /** Defaults to the sum. Pass it when the strip should show a remainder as an empty gap. */
  total?: number;
  legend?: "below" | "inline" | "none";
  height?: "sm" | "md";
  /** Makes each segment a button — the list under an ageing bar filters to the bucket. */
  onSegment?: (segment: ProportionSegment) => void;
  className?: string;
}) {
  const sum = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const whole = total != null && total > sum ? total : sum;
  const h = height === "sm" ? "h-1.5" : "h-2.5";
  const described = segments.map((s) => `${s.label} ${s.display ?? s.value}`).join(", ");
  let neutral = 0;

  return (
    <div className={`min-w-0 ${className}`}>
      <div role="img" aria-label={described} title={described} className={`flex ${h} w-full overflow-hidden rounded-full bg-gray-100`}>
        {segments.map((s, i) => {
          const v = Math.max(0, s.value);
          if (v === 0) return null;
          const pct = whole > 0 ? (v / whole) * 100 : 0;
          const cls = fillClass(s.tone, s.tone && s.tone !== "neutral" ? neutral : neutral++);
          const inline = legend === "inline" && pct >= 12;
          const style = { width: `${pct}%`, minWidth: 2 };
          const body = inline ? (
            <span className="truncate px-1.5 text-[10px] font-semibold leading-none text-white/95">{s.label}</span>
          ) : null;
          return onSegment ? (
            <button
              key={i}
              type="button"
              onClick={() => onSegment(s)}
              className={`flex h-full items-center overflow-hidden ${cls} transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
              style={style}
              title={`${s.label} · ${s.display ?? s.value}`}
            >
              {body}
            </button>
          ) : (
            <div key={i} className={`flex h-full items-center overflow-hidden ${cls}`} style={style}>
              {body}
            </div>
          );
        })}
      </div>
      {legend === "below" && (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-tight">
          {segments.map((s, i) => {
            const dot = !s.tone || s.tone === "neutral" ? NEUTRAL[i % NEUTRAL.length] : DOT[s.tone];
            return (
              <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
                <span className="text-gray-500">{s.label}</span>
                <span className="font-semibold tabular-nums text-gray-800">{s.display ?? s.value}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
