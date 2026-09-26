import { type ReactNode, useMemo, useState } from "react";

/**
 * Sorting a table by clicking its headers, as Zoho Books does it.
 *
 * `ListPage` had this first and most of niko's lists are ListPages. The rest —
 * the activity log, the chart of accounts, fixed assets, stock, the receipts
 * book, the employee roster — are hand-built tables that predate it or need a
 * shape it does not offer, and rewriting them onto ListPage to gain a sort
 * would be a far larger change than they deserve. So the sort lives here, in
 * three pieces any table can take: the comparator, the state, and the header.
 *
 * Read off books.zoho.in on 26 Sep 2026, not remembered:
 *
 *   - Only the SORTED column shows a marker, and the marker is a stacked pair
 *     of 5px carets — the one matching the direction near-black, the other in
 *     the accent colour.
 *   - A header you have not clicked shows nothing at all, not even on hover.
 *     The pointer cursor is the whole affordance.
 *   - The header label does not change colour when it becomes the sorted one.
 *   - First click ascending, second descending, and no third state that puts
 *     it back.
 */

/** What a column sorts on. Null or "" means nothing on file. */
export type SortValue = string | number | null | undefined;

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

/**
 * Compare two values for one column, honouring the direction.
 *
 * Nothing on file sinks to the bottom whichever way the arrow points —
 * reversing a sort should not open on a screenful of dashes.
 */
export function compareBy(a: SortValue, b: SortValue, dir: "asc" | "desc"): number {
  const ea = a == null || a === "";
  const eb = b == null || b === "";
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
  const cmp =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : // numeric:true so "L2" sorts before "L10" and a bill number ending 9
        // sorts before one ending 10; sensitivity:"base" so a lower-case name
        // is not exiled below the upper-case ones.
        String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return dir === "desc" ? -cmp : cmp;
}

/** The sorted column's marker: a stacked pair of carets, one of them live. */
export function SortCarets({ dir }: { dir: "asc" | "desc" }) {
  const on = "fill-gray-900";
  const off = "fill-brand-500";
  return (
    <span aria-hidden className="inline-flex shrink-0 flex-col leading-none">
      <svg viewBox="0 0 10 6" className={`h-[5px] w-[5px] ${dir === "asc" ? on : off}`}>
        <path d="M5 0L10 6H0z" />
      </svg>
      <svg viewBox="0 0 10 6" className={`h-[5px] w-[5px] ${dir === "desc" ? on : off}`}>
        <path d="M5 6L0 0h10z" />
      </svg>
    </span>
  );
}

/**
 * Hold the sort, and hand back the rows in that order.
 *
 * `sorts` maps a column key to the value that column sorts on. It reads the
 * ROW, not the rendered cell: a cell showing "₹1,23,456.00" or a phone number
 * that falls back through three fields sorts nothing like its own text.
 *
 * Until a header is clicked the rows come back exactly as they arrived, which
 * is the order the screen was designed around — newest first, or by name.
 */
/**
 * The sort, without the sorting — for a table that must order its rows
 * itself, such as a tree whose children may not leave their parent.
 */
export function useSortState() {
  const [sort, setSort] = useState<SortState | null>(null);
  /** First click sorts ascending; the next reverses it. */
  const toggle = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  return { sort, toggle, setSort };
}

export function useSortedRows<T>(
  rows: T[] | undefined,
  sorts: Record<string, (row: T) => SortValue>,
) {
  const { sort, toggle, setSort } = useSortState();

  const sorted = useMemo(() => {
    if (!rows) return rows;
    const pick = sort && sorts[sort.key];
    if (!pick || !sort) return rows;
    return [...rows].sort((a, b) => compareBy(pick(a), pick(b), sort.dir));
  }, [rows, sort, sorts]);

  return { rows: sorted, sort, toggle, setSort };
}

/**
 * A sortable header cell for a hand-built table.
 *
 * Kept as its own component rather than something the hook returns: a
 * component built fresh on each render is a new type to React, which would
 * unmount the header — and so drop keyboard focus — on the very click that
 * sorted it.
 */
export function SortTh({
  k,
  sort,
  toggle,
  children,
  className = "",
  align = "left",
  title,
  colSpan,
}: {
  /** This column's key in the `sorts` map. */
  k: string;
  sort: SortState | null;
  toggle: (key: string) => void;
  children: ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  /** Tooltip; defaults to "Sort by <header>" when the header is plain text. */
  title?: string;
  colSpan?: number;
}) {
  const active = sort?.key === k;
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "";
  return (
    <th className={className} colSpan={colSpan} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button
        type="button"
        onClick={() => toggle(k)}
        title={title ?? (typeof children === "string" ? `Sort by ${children}` : "Sort")}
        className={`inline-flex w-full items-center gap-1.5 font-[inherit] ${justify}`}
      >
        {children}
        {active && <SortCarets dir={sort!.dir} />}
      </button>
    </th>
  );
}
