/**
 * `FractionBar` — how much of one thing.
 *
 * A filled share of a track: an invoice's paid part, a PO line's delivered
 * part, an advance repaid, a roster enrolled. One of the six shared shapes in
 * docs/ui-visuals-plan.md; Home's private progress bar was the first version
 * of it and now calls this with its own colours.
 *
 * `over` says what a value past the maximum means. "clip" (default) stops at
 * the end, for shares that cannot exceed the whole. "tail" draws the excess in
 * red past the 100% mark, for a truck that overruns its order line or a
 * budget overspent — the point of those bars is the overrun.
 */
export type FractionTone = "brand" | "success" | "warning" | "danger";

const FILL: Record<FractionTone, string> = {
  brand: "bg-brand-500",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

export function FractionBar({
  value,
  max,
  tone = "brand",
  over = "clip",
  label,
  height = "sm",
  classes,
  title,
  className = "",
}: {
  value: number;
  max: number;
  tone?: FractionTone;
  over?: "clip" | "tail";
  /** Text to the right of the track — the caller formats ("₹1.2 L of ₹4 L"). */
  label?: string;
  height?: "sm" | "md";
  /** A page with its own visual language (Home) overrides the track and fill. */
  classes?: { track?: string; fill?: string };
  /** Shown on hover when given; the accessible name is always "value of max". */
  title?: string;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 0;
  const v = Math.max(0, value);
  const overrun = safeMax > 0 && over === "tail" && v > safeMax;
  // With a tail the whole bar is the value, and the maximum is the mark inside it.
  const whole = overrun ? v : safeMax;
  const fillPct = whole > 0 ? Math.min(100, (Math.min(v, safeMax) / whole) * 100) : 0;
  const tailPct = overrun ? 100 - fillPct : 0;
  const h = height === "md" ? "h-2.5" : "h-1.5";

  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 ${className}`} title={title}>
      <div
        role="img"
        aria-label={title ?? `${value} of ${max}`}
        className={`flex ${h} min-w-0 flex-1 overflow-hidden rounded-full ${classes?.track ?? "bg-gray-100"}`}
      >
        <div className={`h-full rounded-full ${classes?.fill ?? FILL[tone]}`} style={{ width: `${fillPct}%` }} />
        {tailPct > 0 && <div className="h-full bg-destructive" style={{ width: `${tailPct}%` }} />}
      </div>
      {label && <span className="shrink-0 text-[11px] tabular-nums text-gray-500">{label}</span>}
    </div>
  );
}
