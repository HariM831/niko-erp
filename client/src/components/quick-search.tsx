import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, formatMoney } from "../api";
import { StatusBadge } from "./status-badge";

/**
 * The search box that sits above a document list, with the dropdown that
 * previews what the term has found.
 *
 * It searches the list it belongs to and nothing else: on Bills it finds
 * bills, on Invoices invoices. The dropdown is a preview capped at ten rows —
 * pressing Enter without picking one filters the list itself, which is not
 * capped, so a term matching four hundred bills shows all four hundred.
 */

/** Ten, as Zoho does. Enough to recognise the record, short enough to scan. */
const PREVIEW_ROWS = 10;

/** dd/mm/yyyy, matching the list the dropdown sits over rather than api.ts's long form. */
const shortDate = (d: string) => {
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}/${m}/${y}` : d;
};

interface Preview {
  name: string;
  amount: string | null;
  number: string;
  date: string;
  status: string | null;
}

/**
 * The nine lists name their columns differently — a bill is dated billDate and
 * totals `total`, a payment is dated paymentDate and totals `amount`. Rather
 * than make every caller describe its own shape, the preview reads whichever
 * of the known names the row happens to carry.
 */
function preview(row: Record<string, unknown>): Preview {
  const first = (...keys: string[]) => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return null;
  };
  return {
    // Documents name their contact; the master lists (customers, vendors,
    // items) are their own subject and carry a display name instead. An expense
    // often has no vendor at all, so it is identified by the account it hit,
    // and a journal by its narration.
    name:
      first("contactName", "displayName", "expenseAccountName", "name", "narration") ?? "—",
    amount: first("total", "amount"),
    number: first("number", "entryNumber") ?? "",
    date:
      first(
        "billDate",
        "invoiceDate",
        "expenseDate",
        "paymentDate",
        "creditDate",
        "creditNoteDate",
        "orderDate",
        "entryDate",
      ) ?? "",
    status: first("status"),
  };
}

interface QuickSearchProps {
  /** Plural module name, e.g. "Bills" — used in the placeholder. */
  title: string;
  endpoint: string;
  /** Extra params for the active saved view, so the preview respects it. */
  params?: Record<string, string>;
  /** The committed term; the list is filtered by this. */
  value: string;
  onChange: (term: string) => void;
  rowPath?: (row: Record<string, unknown>) => string;
  onOpen?: (row: Record<string, unknown>) => void;
}

export function QuickSearch({
  title,
  endpoint,
  params,
  value,
  onChange,
  rowPath,
  onOpen,
}: QuickSearchProps) {
  const [, navigate] = useLocation();
  const [term, setTerm] = useState(value);
  const [debounced, setDebounced] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The committed term can change from outside — the advanced search clears it.
  useEffect(() => setTerm(value), [value]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(t);
  }, [term]);

  /** Zoho focuses its search on "/". Not while the user is typing elsewhere. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const url = useMemo(() => {
    const p = new URLSearchParams(params ?? {});
    p.set("search", debounced);
    p.set("limit", String(PREVIEW_ROWS));
    return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${p.toString()}`;
  }, [endpoint, params, debounced]);

  const { data, isFetching } = useQuery({
    queryKey: ["quick-search", endpoint, params, debounced],
    queryFn: () => api<Record<string, unknown>[]>(url),
    enabled: debounced.trim().length > 0,
  });

  const rows = debounced.trim() ? (data ?? []) : [];
  const showing = open && debounced.trim().length > 0;

  const choose = (row: Record<string, unknown>) => {
    setOpen(false);
    if (onOpen) onOpen(row);
    else if (rowPath) navigate(rowPath(row));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => {
        const n = rows.length;
        if (!n) return -1;
        return e.key === "ArrowDown" ? (i + 1) % n : (i <= 0 ? n : i) - 1;
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // A highlighted row opens that record; otherwise the term filters the list.
      if (active >= 0 && rows[active]) choose(rows[active]!);
      else {
        setOpen(false);
        onChange(term);
      }
    }
  };

  return (
    <div className="relative" ref={boxRef}>
      <div className="flex items-center rounded border border-gray-300 bg-white focus-within:border-brand-500">
        <span className="pl-2 text-gray-400" aria-hidden>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
            <path d="M15.85 15.14l-4.59-4.59a6.365 6.365 0 001.54-4.16C12.8 2.87 9.93 0 6.4 0S0 2.87 0 6.4s2.87 6.4 6.4 6.4c1.59 0 3.04-.58 4.16-1.54l4.59 4.59a.485.485 0 00.7 0c.2-.2.2-.51 0-.71zM1 6.4C1 3.42 3.42 1 6.4 1s5.4 2.42 5.4 5.4-2.42 5.4-5.4 5.4S1 9.38 1 6.4z" />
          </svg>
        </span>
        <input
          ref={inputRef}
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={`Search in ${title} ( / )`}
          aria-label={`Search in ${title}`}
          className="w-64 bg-transparent px-2 py-1.5 text-[13px] outline-none"
        />
        {term && (
          <button
            onClick={() => {
              setTerm("");
              onChange("");
              setOpen(false);
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="px-2 text-gray-400 hover:text-gray-600"
          >
            ×
          </button>
        )}
      </div>

      {/* Anchored left: the box sits at the left of the top bar, so a
          right-anchored panel would hang off the screen under the sidebar. */}
      {showing && (
        <ul className="absolute left-0 top-9 z-30 max-h-96 w-[26rem] overflow-y-auto rounded-lg border bg-white py-1 shadow-lg">
          {rows.length === 0 && (
            <li className="px-3 py-3 text-center text-[13px] text-gray-500">
              {isFetching ? "Searching…" : "No results found"}
            </li>
          )}
          {rows.map((row, i) => {
            const p = preview(row);
            return (
              <li key={String(row.id ?? i)}>
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(row)}
                  className={`block w-full cursor-pointer px-3 py-2 text-left ${
                    i === active ? "bg-brand-50" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[13px] font-semibold text-gray-800" title={p.name}>
                      {p.name}
                    </span>
                    {p.amount !== null && (
                      <span className="shrink-0 text-[13px] font-semibold text-gray-800 tabular-nums">
                        {formatMoney(p.amount)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-3">
                    <span className="truncate text-[11px] text-gray-500">
                      {p.number}
                      {p.date && <span className="ml-2">{shortDate(p.date)}</span>}
                    </span>
                    {p.status && <StatusBadge status={p.status} />}
                  </div>
                </button>
              </li>
            );
          })}
          {rows.length === PREVIEW_ROWS && (
            <li className="border-t px-3 py-1.5 text-[11px] text-gray-500">
              Showing the first {PREVIEW_ROWS} — press Enter to see every match
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
