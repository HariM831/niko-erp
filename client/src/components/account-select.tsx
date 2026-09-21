/**
 * Picking an account from the chart, the way Zoho does it.
 *
 * A search box on top, then the accounts as a tree: grouped under their kind
 * (Expense, Cost Of Goods Sold, Other Expense…), each one a bullet, a
 * sub-account indented under its parent. The tree is the point — "Insurance
 * Expenses" with its three insurers beneath it says which one you mean in a
 * way a flat list of 200 names cannot.
 *
 * Typing narrows it by the rule every search in niko follows (matchesTerm:
 * words from their start, numbers anywhere), and keeps each match's parents in
 * view so a hit is still read in its place. A header account (isGroup) is
 * shown for the shape but cannot be picked: nothing posts to it.
 *
 * The same component wherever an account is picked, so an accountant who
 * learns it once has learnt it everywhere.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { matchesTerm } from "../lib/utils";

export interface AccountNode {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
  parentId?: string | null;
  isGroup?: boolean;
  isActive?: boolean;
}

/** Zoho's headings, in Zoho's order. */
const KIND_LABEL: Record<string, string> = {
  other_current_asset: "Other Current Asset",
  cash: "Cash",
  bank: "Bank",
  accounts_receivable: "Accounts Receivable",
  stock: "Stock",
  fixed_asset: "Fixed Asset",
  other_asset: "Other Asset",
  other_current_liability: "Other Current Liability",
  accounts_payable: "Accounts Payable",
  credit_card: "Credit Card",
  non_current_liability: "Non Current Liability",
  other_liability: "Other Liability",
  equity: "Equity",
  income: "Income",
  other_income: "Other Income",
  expense: "Expense",
  cost_of_goods_sold: "Cost Of Goods Sold",
  other_expense: "Other Expense",
};
const KIND_ORDER = Object.keys(KIND_LABEL);
const TYPE_LABEL: Record<string, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  income: "Income",
  expense: "Expense",
};
const kindOf = (a: AccountNode) => a.subtype ?? a.type;
const kindLabel = (k: string) => KIND_LABEL[k] ?? TYPE_LABEL[k] ?? k;
const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? KIND_ORDER.length : i;
};

type Row =
  | { kind: "heading"; key: string; label: string }
  | { kind: "account"; key: string; a: AccountNode; depth: number; pickable: boolean };

export function AccountSelect({
  value,
  onChange,
  accounts,
  include,
  placeholder = "Select an account",
  disabled,
  allowClear = false,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  accounts: AccountNode[] | undefined;
  /** Which accounts belong in this picker, e.g. `(a) => a.type === "expense"`. */
  include: (a: AccountNode) => boolean;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pool = useMemo(
    () => (accounts ?? []).filter((a) => a.isActive !== false && include(a)),
    // `include` is usually an inline arrow; the pool only has to follow the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts],
  );

  const rows = useMemo<Row[]>(() => {
    const byId = new Map(pool.map((a) => [a.id, a]));
    const parentOf = (a: AccountNode) => (a.parentId && byId.has(a.parentId) ? a.parentId : null);
    const children = new Map<string | null, AccountNode[]>();
    for (const a of pool) {
      const p = parentOf(a);
      children.set(p, [...(children.get(p) ?? []), a]);
    }
    for (const list of children.values()) list.sort((x, y) => x.name.localeCompare(y.name, "en-IN"));

    // A search keeps every match and the parents above it, so a hit is read in its place.
    const q = query.trim();
    let visible: Set<string> | null = null;
    if (q) {
      visible = new Set();
      for (const a of pool) {
        if (!matchesTerm(q, [a.name, a.code])) continue;
        let cur: AccountNode | undefined = a;
        while (cur && !visible.has(cur.id)) {
          visible.add(cur.id);
          const p = parentOf(cur);
          cur = p ? byId.get(p) : undefined;
        }
      }
    }

    const out: Row[] = [];
    const walk = (a: AccountNode, depth: number) => {
      if (visible && !visible.has(a.id)) return;
      out.push({ kind: "account", key: a.id, a, depth, pickable: !a.isGroup });
      for (const c of children.get(a.id) ?? []) walk(c, depth + 1);
    };
    const roots = children.get(null) ?? [];
    const kinds = [...new Set(roots.map(kindOf))].sort((x, y) => kindRank(x) - kindRank(y));
    for (const k of kinds) {
      const start = out.length;
      out.push({ kind: "heading", key: `h:${k}`, label: kindLabel(k) });
      for (const r of roots.filter((a) => kindOf(a) === k)) walk(r, 0);
      if (out.length === start + 1) out.pop(); // nothing under this heading survived the search
    }
    return out;
  }, [pool, query]);

  const pickable = useMemo(
    () => rows.flatMap((r, i) => (r.kind === "account" && r.pickable ? [i] : [])),
    [rows],
  );
  const selected = pool.find((a) => a.id === value) ?? (accounts ?? []).find((a) => a.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Opening puts the cursor on the account already chosen, as Zoho does.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    inputRef.current?.focus();
    const at = rows.findIndex((r) => r.kind === "account" && r.a.id === value);
    setCursor(at >= 0 ? at : (pickable[0] ?? -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Typing moves the cursor to the first account that can be picked.
  useEffect(() => {
    if (open && query) setCursor(pickable[0] ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (cursor < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  const step = (dir: 1 | -1) => {
    if (!pickable.length) return;
    const at = pickable.indexOf(cursor);
    const next = at < 0 ? (dir > 0 ? 0 : pickable.length - 1) : Math.min(Math.max(at + dir, 0), pickable.length - 1);
    setCursor(pickable[next]!);
  };

  return (
    <div ref={boxRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`input flex w-full items-center justify-between gap-2 text-left disabled:bg-gray-50 disabled:text-gray-400 ${
          open ? "border-brand-500" : ""
        }`}
      >
        <span className={`truncate ${selected ? "text-gray-900" : "text-gray-400"}`}>
          {selected?.name ?? placeholder}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {selected && allowClear && !disabled && (
            <X
              className="h-3.5 w-3.5 text-gray-400 hover:text-gray-700"
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
            />
          )}
          <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="p-2">
            <div className="flex items-center gap-2 rounded-md border border-gray-300 px-2 focus-within:border-brand-500">
              <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    step(1);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    step(-1);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const r = rows[cursor];
                    if (r?.kind === "account" && r.pickable) pick(r.a.id);
                  } else if (e.key === "Escape") {
                    setOpen(false);
                  }
                }}
                placeholder="Search"
                className="w-full bg-transparent py-1.5 text-[13px] outline-none"
              />
            </div>
          </div>
          <div ref={listRef} className="max-h-72 overflow-y-auto pb-1">
            {!rows.length && (
              <div className="px-3 py-3 text-center text-[12px] text-gray-400">
                {query.trim() ? `No account matches “${query.trim()}”.` : "No accounts."}
              </div>
            )}
            {rows.map((r, i) =>
              r.kind === "heading" ? (
                <div key={r.key} className="px-3 pb-1 pt-2 text-[13px] font-semibold text-gray-800">
                  {r.label}
                </div>
              ) : (
                <button
                  key={r.key}
                  type="button"
                  data-row={i}
                  disabled={!r.pickable}
                  onMouseEnter={() => r.pickable && setCursor(i)}
                  onClick={() => r.pickable && pick(r.a.id)}
                  title={r.pickable ? `${r.a.code} · ${r.a.name}` : `${r.a.name} is a heading — pick an account under it`}
                  style={{ paddingLeft: 20 + r.depth * 16 }}
                  className={`flex w-full items-center justify-between gap-2 py-1.5 pr-3 text-left text-[13px] ${
                    !r.pickable
                      ? "cursor-default text-gray-500"
                      : i === cursor
                        ? "bg-brand-500 text-white"
                        : "text-gray-800"
                  }`}
                >
                  <span className="truncate">• {r.a.name}</span>
                  {r.a.id === value && <Check className={`h-3.5 w-3.5 shrink-0 ${i === cursor ? "text-white" : "text-brand-600"}`} />}
                </button>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
