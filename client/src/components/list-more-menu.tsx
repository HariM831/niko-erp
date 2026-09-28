import { isValidElement, type ReactNode, useEffect, useRef, useState } from "react";
import { localYmd } from "../lib/utils";

/**
 * The ⋯ at the top right of a list, as Zoho's: Sort by ▸, Export ▸, Refresh List.
 *
 * It was a button with nothing behind it on every list in niko. Zoho's carries
 * five entries on the bill list — Sort by, Import, Export, Preferences and
 * Refresh List. Import and Preferences are left out rather than drawn dead:
 * niko has no importer or list preferences behind them, and a menu entry that
 * does nothing is the complaint this replaces.
 */

export interface MoreMenuColumn {
  key: string;
  header: string;
  sortable: boolean;
}

export function ListMoreMenu({
  columns,
  sort,
  onSort,
  onExport,
  onRefresh,
  exportDisabled,
}: {
  columns: MoreMenuColumn[];
  sort: { key: string; dir: "asc" | "desc" } | null;
  onSort: (key: string) => void;
  onExport: () => void;
  onRefresh: () => void;
  exportDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** Which flyout is out. Opened on hover like Zoho's, and on tap for a phone. */
  const [sub, setSub] = useState<"sort" | "export" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setSub(null);
  }, [open]);

  const sortable = columns.filter((c) => c.sortable);
  const item = "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-brand-50";
  const flyout = "absolute right-full top-0 mr-1 w-52 rounded-lg border bg-white py-1 shadow-lg";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md border px-2 py-1.5 text-[13px] text-gray-500 hover:bg-gray-50"
        title="More Actions"
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border bg-white py-1 shadow-lg">
          {sortable.length > 0 && (
            <div className="relative" onMouseEnter={() => setSub("sort")}>
              <button type="button" className={item} onClick={() => setSub((s) => (s === "sort" ? null : "sort"))}>
                Sort by <span className="text-gray-400">›</span>
              </button>
              {sub === "sort" && (
                <div role="menu" className={flyout}>
                  {sortable.map((c) => {
                    const active = sort?.key === c.key;
                    return (
                      <button
                        key={c.key}
                        type="button"
                        role="menuitem"
                        className={`${item} ${active ? "bg-brand-50 font-medium text-brand-700" : ""}`}
                        onClick={() => {
                          onSort(c.key);
                          setOpen(false);
                        }}
                      >
                        {c.header}
                        {active && <span className="text-[11px]">{sort!.dir === "asc" ? "▲" : "▼"}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <div className="relative" onMouseEnter={() => setSub("export")}>
            <button type="button" className={item} onClick={() => setSub((s) => (s === "export" ? null : "export"))}>
              Export <span className="text-gray-400">›</span>
            </button>
            {sub === "export" && (
              <div role="menu" className={flyout}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={exportDisabled}
                  className={`${item} disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-transparent`}
                  onClick={() => {
                    onExport();
                    setOpen(false);
                  }}
                >
                  Export Current View
                </button>
              </div>
            )}
          </div>
          <div onMouseEnter={() => setSub(null)}>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                onRefresh();
                setOpen(false);
              }}
            >
              Refresh List
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The words a cell shows, for a CSV. A column's render returns markup — a
 * link, a badge, a formatted figure — so this walks the element tree for its
 * text. Where a column can be sorted, its sort value is the cleaner figure
 * (an amount as a number, not "₹1,23,456.00") and is used instead.
 */
export function cellText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(cellText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; status?: unknown; label?: unknown };
    if (props.children != null) return cellText(props.children);
    // A badge takes its word as a prop, not as children.
    if (typeof props.label === "string") return props.label;
    if (typeof props.status === "string") return props.status;
  }
  return "";
}

/** Rows to a CSV Excel opens as UTF-8, downloaded under the list's name and today's date. */
export function downloadCsv(title: string, headers: string[], rows: Array<Array<string | number>>) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title} ${localYmd()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
