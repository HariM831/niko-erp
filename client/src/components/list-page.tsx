import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { AdvancedButton, AdvancedSearch, criteriaCount as countCriteria, type Criteria, type SearchField } from "./advanced-search";
import { useSearchContext } from "./search-context";
import { SortCarets, compareBy } from "./sortable-table";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
  /**
   * Cap this column's width, in rem, so a long value ellipses instead of
   * pushing the columns after it off the screen.
   *
   * Needed on desktop, not just a phone: the vendor list ran to 1,272px in a
   * 1,212px window because a phone column took 300px and an email 256, and the
   * payables figure — the one column the list exists for — sat behind a
   * sideways scroll. A capped value still identifies the row; a figure you
   * cannot see does not.
   *
   * It has to be a block INSIDE the cell. `max-width` on a `td` is not honoured
   * by the automatic table algorithm — setting it made the same table 1,455px
   * wide, because the browser read it as a sizing hint and grew the short
   * columns to match.
   */
  clamp?: number;
  /**
   * What this column sorts on. Giving it makes the header clickable; leaving
   * it out leaves the header as plain text, which is how Zoho treats a column
   * it cannot order by.
   *
   * It reads the ROW, not the rendered cell: the Phone column falls back
   * through three fields and the balance column renders "₹1,23,456.00", and
   * neither of those sorts the way its text does. Return a number for a
   * number — "9" before "10" — and null or "" for nothing on file.
   */
  sort?: (row: T) => string | number | null | undefined;
  /**
   * Keep this column on a phone held upright.
   *
   * Mark the ones that let someone recognise a row — for a bill that is the
   * date, the number, who it is from and how much. Position is no guide: a bill
   * list has Reference Number third and the amount ninth, and it is the amount
   * people are looking for. If no column on a list is marked, the first
   * `portraitCols` are kept instead.
   */
  portrait?: boolean;
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
  /**
   * Filter as the top-bar search is typed (the default). False brings back the
   * ten-row preview that waits for Enter.
   */
  liveSearch?: boolean;
  /**
   * How many columns survive on a phone held upright. Default 3.
   *
   * These lists run to 22 columns and 1,266px. They scroll, so nothing is
   * unreachable, but finding one figure means dragging through a dozen screens.
   * Portrait keeps the columns that say which row this is; turning the phone
   * gives the rest. Set it per page — the useful count is however many it takes
   * to identify a row, which for a bill is date, number and vendor.
   */
  portraitCols?: number;
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
  liveSearch = true,
  portraitCols,
  banner,
  extraActions,
  searchFields,
}: ListPageProps<T>) {
  // A list that names its portrait columns gets exactly those; one that does not
  // falls back to keeping the first few.
  const namedPortrait = columns.some((c) => c.portrait);
  const shownInPortrait = namedPortrait
    ? columns.filter((c) => c.portrait).length
    : (portraitCols ?? 3);

  /**
   * Which column soaks up the width the hidden ones leave behind.
   *
   * A fixed table divides by column COUNT, and display:none leaves the slot
   * there — so the Items list, ten columns of which eight are hidden, gave its
   * NAME 29px and clipped every row to nothing. Dates, document numbers and
   * figures are sized deliberately (see the portrait block in index.css); the
   * unsized column is the elastic one, and it takes the remainder.
   *
   * ONLY when it is alone in being unsized. A width:100% column beats plain
   * auto columns in fixed layout, so on the vendors list the name took all
   * 365px and Contact Person and Phone stood at ZERO width — three columns
   * chosen for portrait, one drawn. With no fill declared, the unsized columns
   * split the leftover evenly instead, which is the fair default for peers.
   */
  const unsizedPortrait = columns.filter(
    (c) => c.portrait && c.align !== "right" && c.key !== "date" && c.key !== "number",
  );
  const fillKey = unsizedPortrait.length === 1 ? unsizedPortrait[0]?.key : undefined;

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
  /**
   * Which column the list is ordered by, and which way. Null means the order
   * the server sent, which is the one the list was designed around — a bill
   * list newest first, a contact list by name. Clicking a header the first
   * time sorts ascending, clicking it again reverses; there is no third click
   * that puts it back, because Zoho has none either.
   *
   * Session state, deliberately: a sort is something you do to read one
   * answer, not a setting you keep.
   */
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
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
      live: liveSearch,
    });
    return () => register(null);
  }, [register, title, endpoint, viewKey, liveSearch]);
  const params = new URLSearchParams(viewParams);
  if (search) params.set("search", search);
  for (const [k, v] of Object.entries(criteria)) params.set(k, v);
  const qs = params.toString();
  const url = qs ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}${qs}` : endpoint;

  const { data, isLoading, error } = useQuery({
    queryKey: [endpoint, views?.[activeView]?.label ?? "all", search, criteria],
    queryFn: () => api<T[]>(url),
    // A live search refetches on every key; holding the last rows until the
    // next arrive stops the table blanking to "Loading…" between letters.
    placeholderData: liveSearch ? keepPreviousData : undefined,
  });
  const criteriaCount = countCriteria(criteria);

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

  /**
   * The rows in the order they are drawn: groups first, then the sort.
   *
   * Grouping wins over sorting — a Feed Mill row cannot leave its group
   * because somebody sorted by amount — so the group comparator runs first
   * and the chosen column only breaks ties inside a group. On an ungrouped
   * list, which is most of them, there is nothing to break.
   *
   * Sorting happens here rather than on the server because the server sends
   * the whole list in one response, and a column like the balance is worked
   * out in JS after the query: there is nothing back there to order by.
   */
  const sortCol = sort && columns.find((c) => c.key === sort.key && c.sort);
  const ordered = (() => {
    if (!data) return data;
    if (!groupBy && !sortCol) return data;
    const byGroup = (a: T, b: T) => {
      if (!groupBy) return 0;
      const ga = groupBy(a);
      const gb = groupBy(b);
      if (ga === gb) return 0;
      const ia = groupOrder?.indexOf(ga) ?? -1;
      const ib = groupOrder?.indexOf(gb) ?? -1;
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      return ga.localeCompare(gb);
    };
    const bySort = (a: T, b: T) => {
      if (!sortCol?.sort) return 0;
      const va = sortCol.sort(a);
      const vb = sortCol.sort(b);
      return compareBy(va, vb, sort!.dir);
    };
    return [...data].sort((a, b) => byGroup(a, b) || bySort(a, b));
  })();

  /** First click sorts ascending; the next reverses it. */
  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return (
    <div className="flex h-full flex-col">
      {/*
        Wraps rather than squeezes. At 375px the title, Advanced, an extra
        action, + New and the overflow button were all fighting for one row:
        "All Bills" broke across two lines and every button lost its padding.
        The title takes the row it needs and the actions drop beneath it.
      */}
      <header className="page-header flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-3 py-2.5 sm:px-5 sm:py-3">
        <div className="relative" ref={viewsRef}>
          <button
            onClick={() => views && setViewsOpen((o) => !o)}
            className="flex items-center gap-1.5 whitespace-nowrap text-base font-semibold text-gray-800 sm:text-lg"
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
        <div className="flex flex-1 items-center justify-end gap-1.5 sm:flex-none sm:gap-2">
          {searchFields && (
            <AdvancedButton count={criteriaCount} onOpen={() => setAdvancedOpen(true)} onClear={() => setCriteria({})} />
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
          // Named columns win; the positional fallback only runs when a list has
          // not said which of its columns matter. +1 there for the checkbox,
          // which is column one and always stays.
          <table
            className={`list-table w-full border-separate border-spacing-0 text-[13px] ${
              namedPortrait ? "" : `pcols-${Math.min(6, Math.max(2, (portraitCols ?? 3) + 1))}`
            }`}
          >
            <thead className="table-head sticky top-0 z-10">
              <tr>
                <th className={`w-9 border-b border-[#ece3d5] ${cellPad} ${namedPortrait ? "col-portrait-hide" : ""}`}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-brand-500" />
                </th>
                {columns.map((c) => {
                  const active = sort?.key === c.key && !!c.sort;
                  return (
                    <th
                      key={c.key}
                      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                      className={`col-${c.key} ${c.key === fillKey ? "col-fill" : ""} border-b border-[#ece3d5] font-semibold ${cellPad} ${c.align === "right" ? "text-right" : ""} ${
                        namedPortrait && !c.portrait ? "col-portrait-hide" : ""
                      }`}
                    >
                      {c.sort ? (
                        // A button, not a clickable th: the header has to be
                        // reachable by keyboard, and a sort is an action.
                        <button
                          type="button"
                          onClick={() => toggleSort(c.key)}
                          title={`Sort by ${c.header}`}
                          className={`inline-flex w-full items-center gap-1.5 font-semibold ${
                            c.align === "right" ? "justify-end" : ""
                          }`}
                        >
                          {c.header}
                          {active && <SortCarets dir={sort!.dir} />}
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {(ordered ?? []).flatMap((row, i, arr) => {
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
                        className="cursor-pointer select-none border-b border-[#ece3d5] bg-gray-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-100"
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
                      className={`border-b border-[#ece3d5] ${cellPad} ${namedPortrait ? "col-portrait-hide" : ""}`}
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
                        className={`col-${c.key} ${c.key === fillKey ? "col-fill" : ""} border-b border-[#ece3d5] ${cellPad} ${c.align === "right" ? "text-right tabular-nums" : ""} ${
                          namedPortrait && !c.portrait ? "col-portrait-hide" : ""
                        }`}
                      >
                        {c.clamp ? (
                          <span className="block truncate" style={{ maxWidth: `${c.clamp}rem` }}>
                            {c.render(row)}
                          </span>
                        ) : (
                          c.render(row)
                        )}
                      </td>
                    ))}
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        )}
        {/* Only worth saying when columns are actually being held back. */}
        {(data?.length ?? 0) > 0 && columns.length > shownInPortrait && (
          <div className="portrait-note">
            Showing {shownInPortrait} of {columns.length} columns — turn the phone for the rest.
          </div>
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

