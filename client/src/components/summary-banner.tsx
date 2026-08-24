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
    <div className="relative overflow-hidden bg-gradient-to-br from-yolk-400 via-yolk-500 to-yolk-600 px-6 py-5 text-white">
      <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-white/10" />
      <div className="relative flex flex-wrap items-end justify-between gap-x-10 gap-y-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-yolk-50/80">{primary.label}</div>
          <div className="text-[28px] font-extrabold leading-tight tabular-nums">{primary.value}</div>
        </div>
        {secondary.length > 0 && (
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            {secondary.map((s) => (
              <div key={s.label}>
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-yolk-50/75">{s.label}</div>
                <div className="flex items-center gap-1.5 text-[15px] font-bold tabular-nums">
                  {s.alert && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-300" />}
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
