/**
 * The gradient hero strip above a document list — one figure leads, the
 * rest sit lighter beside it, in the same varied-shade yolk language as
 * Home. Every list-page summary banner in the app is built from this one
 * component, so retuning the look (the gradient, the glow, the type scale)
 * happens once here rather than once per document type.
 *
 * A page only supplies numbers and labels — see PaymentSummaryBanner in
 * documents.tsx for the pattern: a small wrapper fetches its own summary
 * endpoint and hands the shaped stats to this component.
 */
export interface BannerStat {
  label: string;
  value: string;
  /** A small dot — reserve for a figure that is a real problem (overdue,
   *  past due date), never decoration. Most stats should leave this unset. */
  alert?: boolean;
}

export function SummaryBanner({ primary, secondary }: { primary: BannerStat; secondary: BannerStat[] }) {
  return (
    /*
     * A quiet strip, not a hero.
     *
     * This was a saturated gradient block with a glow and a decorative sun. On a
     * list whose job is to be read, a full-bleed orange band is the loudest
     * thing on screen and the rows underneath — the actual content — come second
     * to a number nobody asked to be shouted at.
     *
     * The warmth stays, as a wash rather than a fill: a pale tint, one hairline,
     * and the figure carried by weight and size instead of by contrast. The
     * accent survives in the rule under the lead number, so a themed palette
     * still shows through.
     *
     * Sizes step with the viewport, not with a breakpoint — at 375px the old
     * fixed sizes needed 423px in a 375px box and a crore-scale total lost its
     * last digits, which is the one thing the strip exists to show.
     */
    <div className="border-b border-yolk-200/70 bg-gradient-to-r from-yolk-100 via-yolk-50 to-transparent px-4 py-3.5 sm:px-6 sm:py-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="min-w-0">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-yolk-700/80">
            {primary.label}
          </div>
          <div className="mt-0.5 inline-block border-b-2 border-yolk-400 pb-0.5 text-[clamp(1.125rem,5.2vw,1.625rem)] font-extrabold leading-tight tabular-nums text-soil-900">
            {primary.value}
          </div>
        </div>
        {secondary.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-2">
            {secondary.map((s) => (
              <div key={s.label} className="min-w-0">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-soil-400">
                  {s.label}
                </div>
                <div
                  className={`mt-0.5 flex items-center gap-1.5 text-[clamp(0.875rem,3.6vw,1rem)] font-bold tabular-nums ${
                    s.alert ? "text-rose-600" : "text-soil-800"
                  }`}
                >
                  {s.alert && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />}
                  <span>{s.value}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
