/**
 * A dropdown you can type into.
 *
 * A plain `<select>` holding 481 vendors is a list you scroll for twenty
 * seconds with a lorry waiting, and the browser's own type-ahead only matches
 * from the first letter — useless for "M/S Abdul Store" when what the operator
 * remembers is "Abdul". This sorts alphabetically and filters on any part of
 * the name.
 *
 * Deliberately its own component rather than a fourth hand-rolled filter box:
 * Gate In, this screen and anywhere else picking from a long list should
 * behave identically, because an operator who learns one has learnt them all.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFloatingPanel } from "./floating";
import { Check, ChevronDown, X } from "lucide-react";
import { matchesTerms } from "@shared/search";

export interface Choice {
  id: string;
  label: string;
  /** A second line — a code, a category, whatever tells two alike apart. */
  sub?: string | null;
}

/**
 * A shortlist pinned above the rest: the few rows this form is almost
 * certainly after. With `collapseOthers` the full list stays out of the way
 * until something is typed — two recent joiners, not two among a hundred.
 */
export interface PinnedGroup {
  heading: string;
  ids: string[];
  /** A word beside each pinned row: "joined 4 Aug". */
  meta?: (id: string) => string | null;
  collapseOthers?: boolean;
}

export function SearchSelect({
  value,
  onChange,
  options,
  placeholder = "Search…",
  disabled,
  allowClear = true,
  keepOrder = false,
  pinned,
  className,
  buttonClassName,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  options: Choice[];
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  /** Leave the options in the order given, where that order means something. */
  keepOrder?: boolean;
  pinned?: PinnedGroup;
  className?: string;
  /** Replaces the usual input look — for a picker sitting bare in a table cell. */
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { style: panelStyle, host } = useFloatingPanel(open, boxRef);

  const sorted = useMemo(
    () => (keepOrder ? options : [...options].sort((a, b) => a.label.localeCompare(b.label, "en-IN"))),
    [options, keepOrder],
  );

  // Pinned rows first, in the order they were given; nobody listed twice.
  const { matches, pinnedCount } = useMemo(() => {
    // Any part of the name or the second line, every word typed — see
    // shared/search.ts for why it is not fuzzy.
    const hit = (o: Choice) => matchesTerms(`${o.sub ?? ""} ${o.label}`, query);
    const byId = new Map(sorted.map((o) => [o.id, o]));
    const top = (pinned?.ids ?? []).map((id) => byId.get(id)).filter((o): o is Choice => !!o && hit(o));
    const topIds = new Set(top.map((o) => o.id));
    const rest = pinned?.collapseOthers && !query.trim() ? [] : sorted.filter((o) => !topIds.has(o.id) && hit(o));
    return { matches: [...top, ...rest], pinnedCount: top.length };
  }, [sorted, query, pinned]);

  const selected = options.find((o) => o.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!boxRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
    setCursor(0);
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 text-left disabled:bg-gray-50 ${buttonClassName ?? "input"}`}
      >
        <span className={`truncate ${selected ? "text-gray-900" : "text-gray-400"}`}>
          {selected?.label ?? placeholder}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {selected && allowClear && (
            <X
              className="h-3.5 w-3.5 text-gray-400 hover:text-gray-700"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          )}
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        </span>
      </button>

      {open && panelStyle && host && createPortal(
        <div ref={panelRef} style={panelStyle} className="rounded-lg border border-gray-200 bg-white shadow-lg">
          <input
            ref={inputRef}
            // The list mounts a beat after opening (it is placed first), so the
            // box focuses itself rather than waiting on the open effect.
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, matches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const hit = matches[cursor];
                if (hit) pick(hit.id);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Type to filter…"
            className="w-full border-b border-gray-100 px-3 py-2 text-[13px] outline-none"
          />
          <div className="max-h-64 overflow-y-auto py-1">
            {matches.length === 0 && (
              <div className="px-3 py-3 text-center text-[12px] text-gray-400">
                {query.trim() ? <>Nothing matches “{query.trim()}”.</> : "Nothing to choose from."}
              </div>
            )}
            {pinned?.collapseOthers && !query.trim() && (
              <div className="px-3 pb-1 text-[11px] text-gray-400">Type to search everyone else.</div>
            )}
            {matches.slice(0, 200).map((o, i) => (
              <div key={o.id}>
              {pinned && pinnedCount > 0 && i === 0 && (
                <div className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase text-gray-400">{pinned.heading}</div>
              )}
              {pinned && pinnedCount > 0 && i === pinnedCount && (
                <div className="mt-1 border-t border-gray-100 px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase text-gray-400">Everyone</div>
              )}
              <button
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(o.id)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] ${
                  i === cursor ? "bg-brand-50" : ""
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-gray-900">{o.label}</span>
                  {o.sub && <span className="block truncate text-[11px] text-gray-400">{o.sub}</span>}
                </span>
                {i < pinnedCount && pinned?.meta?.(o.id) && (
                  <span className="shrink-0 text-[11px] text-gray-500">{pinned.meta(o.id)}</span>
                )}
                {o.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
              </button>
              </div>
            ))}
            {matches.length > 200 && (
              <div className="px-3 py-1.5 text-[11px] text-gray-400">
                {matches.length - 200} more — keep typing to narrow it.
              </div>
            )}
          </div>
        </div>,
        host,
      )}
    </div>
  );
}
