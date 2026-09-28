import { useEffect, useRef, useState } from "react";

/**
 * Zoho's list pager: "Total Count: View" on the left, "25 per page ▾" and
 * "‹ 1 - 25 ›" on the right, in a bar under the table.
 *
 * Lists drew every row they were sent — 2,136 bills, 10,535 journals — in one
 * table, so a list was slow to open and the row you wanted was a long scroll
 * away. The rows are all in the browser already (the lists filter and sort
 * there), so paging is only a matter of which slice is drawn.
 *
 * Zoho hides the total behind "View" because counting costs it a query; here it
 * costs nothing, but the bar reads as Zoho's does and the number is one click.
 */

export const PAGE_SIZES = [10, 25, 50, 100, 200] as const;
const DEFAULT_SIZE = 25;

/**
 * Rows per page, remembered per list in this browser — Zoho keeps it per
 * module, and someone who reads bills 200 at a time may still want contacts in
 * 25s. Storage can be absent or refuse (a private window), so every touch is
 * guarded and the default stands in.
 */
export function usePerPage(listKey: string): [number, (n: number) => void] {
  const storageKey = `niko.perPage.${listKey}`;
  const [perPage, setPerPageState] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(storageKey));
      return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_SIZE;
    } catch {
      return DEFAULT_SIZE;
    }
  });
  const setPerPage = (n: number) => {
    setPerPageState(n);
    try {
      localStorage.setItem(storageKey, String(n));
    } catch {
      /* not remembered; the choice still holds for this visit */
    }
  };
  return [perPage, setPerPage];
}

/**
 * Paging for a hand-built table — the lists that are not ListPages (the
 * activity log, gate receipts, stock) take the same bar in two lines:
 *
 *   const { pageRows, pager } = usePagedRows(rows, "Activity Log", [filters, sort]);
 *   …map pageRows…  {pager && <ListPager {...pager} />}
 *
 * `resetOn` is whatever changes which rows the table holds or their order; a
 * change goes back to page one. `pager` is null when there is nothing to page.
 */
export function usePagedRows<T>(rows: T[] | undefined, listKey: string, resetOn: unknown[] = []) {
  const [perPage, setPerPage] = usePerPage(listKey);
  const [page, setPage] = useState(1);
  const resetKey = JSON.stringify(resetOn);
  useEffect(() => setPage(1), [resetKey, perPage]);
  const total = rows?.length ?? 0;
  const shown = Math.min(page, Math.max(1, Math.ceil(total / perPage)));
  return {
    pageRows: rows?.slice((shown - 1) * perPage, shown * perPage) ?? [],
    pager: total ? { total, page: shown, perPage, onPage: setPage, onPerPage: setPerPage } : null,
  };
}

export function ListPager({
  total,
  page,
  perPage,
  onPage,
  onPerPage,
}: {
  total: number;
  /** 1-based. */
  page: number;
  perPage: number;
  onPage: (page: number) => void;
  onPerPage: (perPage: number) => void;
}) {
  const [showCount, setShowCount] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menuOpen]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  const first = total ? (page - 1) * perPage + 1 : 0;
  const last = Math.min(total, page * perPage);
  const arrow = "flex h-6 w-6 items-center justify-center rounded text-brand-600 hover:bg-gray-100 disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-transparent";

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-[#ece3d5] bg-white px-3 py-2 text-[13px] sm:px-5">
      <div className="text-gray-700">
        <span className="font-semibold">Total Count:</span>{" "}
        {showCount ? (
          <span className="tabular-nums">{total.toLocaleString("en-IN")}</span>
        ) : (
          <button type="button" onClick={() => setShowCount(true)} className="text-brand-600 hover:underline">
            View
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 rounded-md border border-gray-200 px-1 py-0.5">
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            className="flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 text-gray-700 hover:bg-gray-100"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-gray-400" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm6.3 3.3-1.2-.2a5 5 0 0 1-.4 1l.7 1-1.4 1.4-1-.7a5 5 0 0 1-1 .4l-.2 1.2H6.2L6 12.7a5 5 0 0 1-1-.4l-1 .7-1.4-1.4.7-1a5 5 0 0 1-.4-1l-1.2-.2V7.2L2.9 7a5 5 0 0 1 .4-1l-.7-1L4 3.6l1 .7a5 5 0 0 1 1-.4l.2-1.2h2.6l.2 1.2a5 5 0 0 1 1 .4l1-.7L12.4 5l-.7 1a5 5 0 0 1 .4 1l1.2.2v1.6Z"
              />
            </svg>
            {perPage} per page
          </button>
          {menuOpen && (
            <div
              role="listbox"
              className="absolute bottom-full right-0 z-30 mb-1 w-36 rounded-lg border bg-white py-1 shadow-lg"
            >
              {PAGE_SIZES.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="option"
                  aria-selected={n === perPage}
                  onClick={() => {
                    onPerPage(n);
                    setMenuOpen(false);
                  }}
                  className={`block w-full px-3 py-1.5 text-left hover:bg-brand-50 ${
                    n === perPage ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700"
                  }`}
                >
                  {n} per page
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="mx-0.5 h-4 w-px bg-gray-200" />
        <button type="button" className={arrow} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          ‹
        </button>
        <span className="whitespace-nowrap px-1 font-semibold tabular-nums text-gray-800">
          {first} - {last}
        </span>
        <button type="button" className={arrow} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          ›
        </button>
      </div>
    </div>
  );
}
