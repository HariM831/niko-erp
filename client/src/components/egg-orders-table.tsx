/**
 * The day's orders, laid out the way the packing sheet lays them out: one row
 * per order, sizes as columns, a totals row summing each column.
 *
 * Shared by the calendar's day panel and the loading bay so the book reads
 * identically in both places. Only the size columns the listed orders use
 * appear; standing orders booked by count get an Unsized column.
 */
import type { ReactNode } from "react";

export const EGG_SIZES = ["small", "medium", "large", "xl", "jumbo", "dirty"] as const;
export type EggSize = (typeof EGG_SIZES)[number];
export const EGG_SIZE_LABEL: Record<EggSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xl: "XL",
  jumbo: "Jumbo",
  dirty: "Dirty",
};

export interface OrderLine {
  kind: "standing" | "spot";
  sourceId: string;
  customerId: string;
  customerName: string;
  city: string | null;
  boxes: number;
  sizes: Partial<Record<EggSize, number>> | null;
  spreadPerEgg: string;
  exception: { kind: string; reason: string | null } | null;
  voided: boolean;
  dispatch: { invoiceNumber: string; loadedBoxes: number } | null;
}

const fmt = (n: number) => n.toLocaleString("en-IN");
const numCls = "px-2 py-2.5 text-right tabular-nums";

export function isStruck(l: OrderLine) {
  return l.voided || l.exception?.kind === "skip";
}

export function EggOrdersTable({
  lines,
  title,
  empty,
  muted,
  actions,
}: {
  lines: OrderLine[];
  /** The footer's label, e.g. "Total" or "Struck off". */
  title: string;
  empty?: string;
  /** The struck-off table: dimmed, names crossed, no totals emphasis. */
  muted?: boolean;
  /** What a row can do — the caller decides (load, skip, edit, restore…). */
  actions?: (l: OrderLine) => ReactNode;
}) {
  if (!lines.length) {
    return empty ? (
      <p className="table-surface px-3 py-4 text-center text-sm text-muted-foreground">{empty}</p>
    ) : null;
  }

  const used = EGG_SIZES.filter((s) => lines.some((l) => l.sizes?.[s]));
  const anyUnsized = lines.some((l) => !l.sizes || !Object.keys(l.sizes).length);
  const cols: Array<{ key: string; label: string }> = [
    ...(anyUnsized ? [{ key: "any", label: "Unsized" }] : []),
    ...used.map((s) => ({ key: s, label: EGG_SIZE_LABEL[s] })),
  ];
  const cell = (l: OrderLine, key: string): number =>
    key === "any" ? (!l.sizes || !Object.keys(l.sizes).length ? l.boxes : 0) : (l.sizes?.[key as EggSize] ?? 0);
  const colTotal = (key: string) => lines.reduce((a, l) => a + cell(l, key), 0);
  const grand = lines.reduce((a, l) => a + l.boxes, 0);

  return (
    <div className={`table-surface overflow-x-auto ${muted ? "opacity-70" : ""}`}>
      <table className="w-full text-sm">
        <thead className="table-head">
          <tr>
            <th className="table-th text-left">Customer</th>
            {cols.map((c) => (
              <th key={c.key} className="table-th w-[4.5rem] text-right">
                {c.label}
              </th>
            ))}
            <th className="table-th w-20 text-right">Total</th>
            <th className="table-th w-20 text-right">Spread</th>
            <th className="table-th w-24" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const why = l.voided ? "voided" : l.exception?.kind === "skip" ? "skipped" : null;
            return (
              <tr key={`${l.kind}-${l.sourceId}`} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`whitespace-nowrap font-medium ${muted ? "line-through" : ""}`}>{l.customerName}</span>
                    <span
                      className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${
                        l.kind === "standing" ? "bg-info/10 text-info" : "bg-warning/10 text-warning"
                      }`}
                    >
                      {l.kind === "standing" ? "Standing" : "Spot"}
                    </span>
                    {l.exception?.kind === "qty_override" && (
                      <span className="rounded-full bg-warning/10 px-1.5 py-px text-[10px] font-semibold text-warning">Adjusted</span>
                    )}
                    {why && <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground">{why}</span>}
                  </div>
                  <div className="text-[11px] leading-tight text-muted-foreground">
                    {l.city ?? ""}
                    {l.dispatch && (
                      <span className="text-success">
                        {l.city ? " · " : ""}loaded {fmt(l.dispatch.loadedBoxes)} · {l.dispatch.invoiceNumber}
                      </span>
                    )}
                    {why === "skipped" && l.exception?.reason && (
                      <span className="italic">
                        {l.city ? " · " : ""}{l.exception.reason}
                      </span>
                    )}
                  </div>
                </td>
                {cols.map((c) => {
                  const v = cell(l, c.key);
                  return (
                    <td key={c.key} className={`${numCls} ${v ? "" : "text-muted-foreground/40"}`}>
                      {v ? fmt(v) : "·"}
                    </td>
                  );
                })}
                <td className={`${numCls} font-semibold`}>{fmt(l.boxes)}</td>
                <td className={`${numCls} text-xs text-muted-foreground`}>
                  {Number(l.spreadPerEgg) ? `+${Number(l.spreadPerEgg).toFixed(2)}` : "–"}
                </td>
                <td className="px-2 py-2.5 text-right">{actions?.(l)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className={`border-t-2 border-border bg-muted/40 ${muted ? "" : "font-semibold"}`}>
            <td className="px-3 py-2.5 text-xs uppercase tracking-wide text-muted-foreground">
              {title} · {lines.length} order{lines.length === 1 ? "" : "s"}
            </td>
            {cols.map((c) => (
              <td key={c.key} className={numCls}>
                {colTotal(c.key) ? fmt(colTotal(c.key)) : "·"}
              </td>
            ))}
            <td className={`${numCls} ${muted ? "" : "text-base"}`}>{fmt(grand)}</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
