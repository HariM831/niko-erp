import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { AdvancedSearch, type Criteria, type SearchField } from "./advanced-search";
import { useSearchContext } from "./search-context";

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
  /**
   * Fields offered by Advanced Search. Omitted means the module has none yet,
   * and only the quick search shows.
   */
  searchFields?: SearchField[];
  /**
   * Render the table in sections. Rows are bucketed by the returned label and
   * each bucket gets a full-width header row; `groupOrder` fixes the sequence
   * (unlisted labels follow, alphabetically). Within a bucket the server's
   * ordering is preserved.
   */
  groupBy?: (row: T) => string;
  groupOrder?: string[];
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
  groupBy,
  groupOrder,
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
  searchFields,
}: ListPageProps<T>) {
  const [, navigate] = useLocation();
  const [activeView, setActiveView] = useState(0);
  const [viewsOpen, setViewsOpen] = useState(false);
  /** Group labels folded shut. Session state only — reopens on reload. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The term is owned by the top bar's search box, which is where it is typed.
  const { register, term: search } = useSearchContext();
  const [criteria, setCriteria] = useState<Criteria>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
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

  const viewParams = views?.[activeView]?.params ?? {};
  // Point the top bar's search box at this list. Keyed on the module and the
  // saved view rather than on the handlers, which are new closures every render
  // and would re-register — and so clear the term — on every keystroke.
  const viewKey = JSON.stringify(viewParams);
  const handlersRef = useRef({ rowPath, handleRow });
  handlersRef.current = { rowPath, handleRow };
  useEffect(() => {
    register({
      title,
      endpoint,
      params: JSON.parse(viewKey) as Record<string, string>,
      rowPath: handlersRef.current.rowPath
        ? (row) => handlersRef.current.rowPath!(row as T)
        : undefined,
      onOpen: handlersRef.current.handleRow
        ? (row) => handlersRef.current.handleRow!(row as T)
        : undefined,
    });
    return () => register(null);
  }, [register, title, endpoint, viewKey]);
  const params = new URLSearchParams(viewParams);
  if (search) params.set("search", search);
  for (const [k, v] of Object.entries(criteria)) params.set(k, v);
  const qs = params.toString();
  const url = qs ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}${qs}` : endpoint;

  const { data, isLoading, error } = useQuery({
    queryKey: [endpoint, views?.[activeView]?.label ?? "all", search, criteria],
    queryFn: () => api<T[]>(url),
  });
  const criteriaCount = Object.keys(criteria).length;

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
          {searchFields && (
            <button
              onClick={() => setAdvancedOpen(true)}
              className={`whitespace-nowrap rounded border px-2 py-1.5 text-[13px] ${
                criteriaCount
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-gray-300 text-gray-600 hover:bg-gray-50"
              }`}
            >
              Advanced{criteriaCount ? ` (${criteriaCount})` : ""}
            </button>
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
              {(groupBy
                ? [...data].sort((a, b) => {
                    const ga = groupBy(a);
                    const gb = groupBy(b);
                    if (ga === gb) return 0;
                    const ia = groupOrder?.indexOf(ga) ?? -1;
                    const ib = groupOrder?.indexOf(gb) ?? -1;
                    if (ia !== -1 || ib !== -1) {
                      return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
                    }
                    return ga.localeCompare(gb);
                  })
                : data
              ).flatMap((row, i, arr) => {
                const group = groupBy?.(row);
                const isCollapsed = group != null && collapsed.has(group);
                const header =
                  groupBy && (i === 0 || groupBy(arr[i - 1]!) !== group) ? (
                    <tr key={`g:${group}`}>
                      <td
                        colSpan={columns.length + 1}
                        onClick={() =>
                          setCollapsed((c) => {
                            const next = new Set(c);
                            if (next.has(group!)) next.delete(group!);
                            else next.add(group!);
                            return next;
                          })
                        }
                        className="cursor-pointer select-none border-b border-[#ebeaf2] bg-gray-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-100"
                      >
                        <span className="mr-1.5 inline-block w-3 text-gray-400">
                          {isCollapsed ? "▸" : "▾"}
                        </span>
                        {group}
                        <span className="ml-2 font-normal normal-case text-gray-400">
                          {arr.filter((r) => groupBy(r) === group).length}
                        </span>
                      </td>
                    </tr>
                  ) : null;
                if (isCollapsed) return header ? [header] : [];
                const k = rowKey(row);
                return [
                  header,
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
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        )}
      </div>

      {advancedOpen && searchFields && (
        <AdvancedSearch
          title={title}
          fields={searchFields}
          initial={criteria}
          onClose={() => setAdvancedOpen(false)}
          onApply={(c) => {
            setCriteria(c);
            setAdvancedOpen(false);
          }}
        />
      )}
    </div>
  );
}

// StatusBadge lives in its own module; re-exported so existing imports still resolve.
export { StatusBadge } from "./status-badge";

