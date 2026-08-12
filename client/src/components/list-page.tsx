import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

export interface ListView {
  label: string;
  /** Extra query params for this saved view, e.g. { status: "draft" }. */
  params: Record<string, string>;
}

interface ListPageProps<T> {
  title: string;
  endpoint: string;
  columns: Column<T>[];
  views?: ListView[];
  searchPlaceholder?: string;
  newLabel?: string;
  /** Route for the create form; renders the "+ New" button when set. */
  newPath?: string;
  onNew?: () => void;
  onRowClick?: (row: T) => void;
  /** Route to open when a row is clicked. */
  rowPath?: (row: T) => string;
  rowKey: (row: T) => string;
  /** Highlighted row (used by the split view). */
  activeKey?: string;
  compact?: boolean;
  /** Optional content rendered between the header and the table, e.g. a stats banner. */
  banner?: ReactNode;
  /** Extra buttons placed before "+ New" in the header, e.g. "Upload Bill". */
  extraActions?: ReactNode;
}

/**
 * Books-style list view: "All <Title> ▾" saved-view dropdown, a "+ New"
 * primary action, checkbox column, and a compact full-width table.
 */
export function ListPage<T>({
  title,
  endpoint,
  columns,
  views,
  searchPlaceholder,
  newLabel,
  newPath,
  onNew,
  onRowClick,
  rowPath,
  rowKey,
  activeKey,
  compact,
  banner,
  extraActions,
}: ListPageProps<T>) {
  const [, navigate] = useLocation();
  const [activeView, setActiveView] = useState(0);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const viewsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (viewsRef.current && !viewsRef.current.contains(e.target as Node)) setViewsOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const handleNew = onNew ?? (newPath ? () => navigate(newPath) : undefined);
  const handleRow = onRowClick ?? (rowPath ? (row: T) => navigate(rowPath(row)) : undefined);

  const params = new URLSearchParams(views?.[activeView]?.params ?? {});
  if (search) params.set("search", search);
  const qs = params.toString();
  const url = qs ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}${qs}` : endpoint;

  const { data, isLoading, error } = useQuery({
    queryKey: [endpoint, views?.[activeView]?.label ?? "all", search],
    queryFn: () => api<T[]>(url),
  });

  const allSelected = !!data?.length && data.every((r) => selected.has(rowKey(r)));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(data?.map(rowKey) ?? []));
  const toggleOne = (k: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const viewLabel = views?.[activeView]?.label ?? "All";
  const cellPad = compact ? "px-3 py-2" : "px-4 py-2.5";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between bg-white px-5 py-3">
        <div className="relative" ref={viewsRef}>
          <button
            onClick={() => views && setViewsOpen((o) => !o)}
            className="flex items-center gap-1.5 text-lg font-semibold text-gray-800"
          >
            {viewLabel === "All" ? `All ${title}` : `${viewLabel} ${title}`}
            {views && <span className="text-xs text-brand-500">▼</span>}
          </button>
          {viewsOpen && views && (
            <div className="absolute left-0 top-9 z-20 w-52 rounded-lg border bg-white py-1 shadow-lg">
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Default Filters
              </div>
              {views.map((v, i) => (
                <button
                  key={v.label}
                  onClick={() => {
                    setActiveView(i);
                    setViewsOpen(false);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-[13px] capitalize hover:bg-brand-50 ${
                    i === activeView ? "bg-brand-50 font-medium text-brand-700" : ""
                  }`}
                >
                  {v.label === "All" ? `All ${title}` : v.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {searchPlaceholder && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="input w-52"
            />
          )}
          {extraActions}
          {handleNew && (
            <button
              onClick={handleNew}
              className="btn-primary"
            >
              + New
            </button>
          )}
          <button className="rounded-md border px-2 py-1.5 text-[13px] text-gray-500 hover:bg-gray-50" title="More">
            ⋯
          </button>
        </div>
      </header>

      {banner}

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </div>
        ) : !data?.length ? (
          <div className="p-12 text-center text-sm text-gray-500">
            No records yet.
            {handleNew && (
              <button onClick={handleNew} className="ml-1 text-brand-600 hover:underline">
                Create the first one
              </button>
            )}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="sticky top-0 z-10 bg-[#f9f9fb] text-left text-[11px] font-semibold uppercase text-[#6c718a]">
              <tr>
                <th className={`w-9 border-b border-[#ebeaf2] ${cellPad}`}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-brand-500" />
                </th>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={`border-b border-[#ebeaf2] font-semibold ${cellPad} ${c.align === "right" ? "text-right" : ""}`}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const k = rowKey(row);
                return (
                  <tr
                    key={k}
                    onClick={() => handleRow?.(row)}
                    className={`transition-colors duration-100 ${handleRow ? "cursor-pointer" : ""} ${
                      activeKey === k ? "bg-brand-50" : "bg-white hover:bg-gray-50"
                    }`}
                  >
                    <td
                      className={`border-b border-[#ebeaf2] ${cellPad}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(k)}
                        onChange={() => toggleOne(k)}
                        className="accent-brand-500"
                      />
                    </td>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={`border-b border-[#ebeaf2] ${cellPad} ${c.align === "right" ? "text-right tabular-nums" : ""}`}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Colored status text (uppercase, no pill) with due/overdue awareness. */
const STATUS_TEXT: Record<string, string> = {
  draft: "text-gray-500",
  sent: "text-blue-600",
  open: "text-blue-600",
  confirmed: "text-blue-600",
  issued: "text-blue-600",
  accepted: "text-green-600",
  paid: "text-green-600",
  closed: "text-green-600",
  billed: "text-green-600",
  invoiced: "text-green-600",
  posted: "text-green-600",
  partially_paid: "text-amber-600",
  partially_billed: "text-amber-600",
  declined: "text-red-600",
  void: "text-gray-400",
  cancelled: "text-red-600",
  reversed: "text-red-600",
  expired: "text-gray-400",
  overdue: "text-orange-600",
  matched: "text-green-600",
  unmatched: "text-blue-600",
  excluded: "text-gray-400",
};

export function StatusBadge({ status, dueDate }: { status: string; dueDate?: string }) {
  let label = status.replace(/_/g, " ");
  let cls = STATUS_TEXT[status] ?? "text-gray-500";
  if ((status === "sent" || status === "open") && dueDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (dueDate < today) {
      label = "overdue";
      cls = STATUS_TEXT.overdue!;
    } else if (dueDate === today) {
      label = "due today";
      cls = STATUS_TEXT.overdue!;
    }
  }
  return (
    <span className={`text-[11px] font-semibold uppercase tracking-wide ${cls}`}>{label}</span>
  );
}
