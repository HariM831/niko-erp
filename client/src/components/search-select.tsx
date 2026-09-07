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
import { Check, ChevronDown, X } from "lucide-react";

export interface Choice {
  id: string;
  label: string;
  /** A second line — a code, a category, whatever tells two alike apart. */
  sub?: string | null;
}

export function SearchSelect({
  value,
  onChange,
  options,
  placeholder = "Search…",
  disabled,
  allowClear = true,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  options: Choice[];
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(
    () => [...options].sort((a, b) => a.label.localeCompare(b.label, "en-IN")),
    [options],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    // Any part of the name, not just the start — see the note above.
    return sorted.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || (o.sub ?? "").toLowerCase().includes(q),
    );
  }, [sorted, query]);

  const selected = options.find((o) => o.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
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
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="input flex items-center justify-between gap-2 text-left disabled:bg-gray-50"
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

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
          <input
            ref={inputRef}
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
                Nothing matches “{query}”.
              </div>
            )}
            {matches.slice(0, 200).map((o, i) => (
              <button
                key={o.id}
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
                {o.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
              </button>
            ))}
            {matches.length > 200 && (
              <div className="px-3 py-1.5 text-[11px] text-gray-400">
                {matches.length - 200} more — keep typing to narrow it.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
