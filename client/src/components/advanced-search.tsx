import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useQuery } from "@tanstack/react-query";
import { SearchSelect } from "./search-select";
import { AccountSelect, bankNodes, type AccountNode } from "./account-select";
import { matchesTerm } from "../lib/utils";
import { DateInput } from "./date-input";

/**
 * Field-by-field search, laid out the way Zoho's "Advanced Search" dialog is:
 * a label on the left of each box, two columns of them, ranges as two boxes
 * with a dash between, and Search / Cancel centred at the foot.
 *
 * One difference, on purpose: Zoho's dialog opens with a "Search [module]"
 * picker that jumps to another module's list. niko's is tied to the page it is
 * opened from, because access is granted per page — a search box must not be
 * a side door into a list the user was never given.
 *
 * The quick search matches text; this is where the rest lives — the ranges a
 * substring cannot express. "36841" is not a sensible substring of 36,841.00,
 * so a total is asked for as a range here rather than matched as a string.
 *
 * Only fields the module actually has are offered. Zoho's bill search carries
 * GST treatment, place of supply, TCS and projects; niko has none of those by
 * design, so they are absent rather than present and inert.
 */

export type FieldKind =
  | "text"
  | "dateRange"
  | "numberRange"
  | "select"
  | "radio"
  | "contact"
  | "account"
  | "item"
  | "employee";

export interface FieldOption {
  value: string;
  label: string;
  /** A line under a radio choice, as Zoho explains "Transactions" vs "Statement". */
  hint?: string;
}

export interface SearchField {
  /** Query parameter. Ranges append From/To or Min/Max. */
  key: string;
  label: string;
  kind: FieldKind;
  /** For "select" and "radio". A bare string is its own label, underscores read as spaces. */
  options?: (string | FieldOption)[];
  /** For "radio": the choice held when nothing has been picked. */
  defaultValue?: string;
  /** For "contact": which side to list. */
  contactType?: "customer" | "vendor";
  /**
   * For "account": which accounts to offer. "bank" lists niko's bank and cash
   * registers (Paid Through, Deposit To); otherwise the chart, narrowed by
   * `accountTypes` when given (e.g. ["expense"]).
   */
  accountSource?: "chart" | "bank";
  accountTypes?: string[];
  /** For "item": only items in these categories. */
  itemCategories?: string[];
  /** Spans both columns — a radio group, a long text. */
  wide?: boolean;
}

export type Criteria = Record<string, string>;

/** The option list a select or radio offers, labels filled in. */
export function fieldOptions(f: SearchField): FieldOption[] {
  return (f.options ?? []).map((o) =>
    typeof o === "string" ? { value: o, label: o.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) } : o,
  );
}

interface Props {
  title: string;
  fields: SearchField[];
  initial: Criteria;
  onApply: (c: Criteria) => void;
  onClose: () => void;
}

/** The app's own box (index.css `.input`), so the dialog matches every form. */
const INPUT = "input min-w-0";

function ContactPicker({
  value,
  onChange,
  type,
}: {
  value: string;
  onChange: (v: string) => void;
  type: "customer" | "vendor";
}) {
  const { data } = useQuery({
    queryKey: ["contacts", type],
    queryFn: () => api<{ id: string; displayName: string }[]>(`/api/contacts?type=${type}`),
  });
  return (
    <SearchSelect
      value={value || null}
      onChange={(id) => onChange(id ?? "")}
      options={(data ?? []).map((c) => ({ id: c.id, label: c.displayName }))}
      placeholder={type === "customer" ? "Select customer" : "Select vendor"}
      buttonClassName={INPUT}
    />
  );
}

function AccountPicker({ value, onChange, field }: { value: string; onChange: (v: string) => void; field: SearchField }) {
  const bank = field.accountSource === "bank";
  const chart = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<AccountNode[]>("/api/accounting/accounts"),
    enabled: !bank,
  });
  const banks = useQuery({
    queryKey: ["/api/banking/accounts"],
    queryFn: () => api<Parameters<typeof bankNodes>[0]>("/api/banking/accounts"),
    enabled: bank,
  });
  const nodes = bank ? bankNodes(banks.data) : chart.data;
  const types = field.accountTypes;
  return (
    <AccountSelect
      value={value}
      onChange={onChange}
      accounts={nodes}
      // A search reaches old postings too, so retired accounts stay findable.
      include={(a) => !types || types.includes(a.type) || types.includes(a.subtype ?? "")}
      placeholder="Select an account"
      allowClear
      buttonClassName={INPUT}
    />
  );
}

function ItemPicker({ value, onChange, field }: { value: string; onChange: (v: string) => void; field: SearchField }) {
  const { data } = useQuery({
    queryKey: ["/api/items", "advanced-search"],
    queryFn: () =>
      api<{ id: string; name: string; sku?: string | null; category?: string | null }[]>("/api/items?limit=5000"),
  });
  const cats = field.itemCategories;
  const options = useMemo(
    () =>
      (data ?? [])
        .filter((i) => !cats || (i.category && cats.includes(i.category)))
        .map((i) => ({ id: i.id, label: i.name, sub: i.sku || null })),
    [data, cats],
  );
  return (
    <SearchSelect
      value={value || null}
      onChange={(id) => onChange(id ?? "")}
      options={options}
      placeholder="Select an item"
      buttonClassName={INPUT}
    />
  );
}

function EmployeePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useQuery({
    queryKey: ["payroll", "employees", ""],
    queryFn: () => api<{ id: string; name: string; empCode: string }[]>("/api/payroll/employees"),
  });
  return (
    <SearchSelect
      value={value || null}
      onChange={(id) => onChange(id ?? "")}
      options={(data ?? []).map((e) => ({ id: e.id, label: e.name, sub: e.empCode }))}
      placeholder="Select an employee"
      buttonClassName={INPUT}
    />
  );
}

/** One label-and-box row. Zoho's labels sit to the left, right-aligned. */
function Row({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-4 ${wide ? "lg:col-span-2" : ""}`}>
      <div className="text-[13px] text-gray-700 sm:w-36 sm:shrink-0 sm:pt-1.5 sm:text-right">{label}</div>
      <div className={`min-w-0 flex-1 ${wide ? "" : "sm:max-w-sm"}`}>{children}</div>
    </div>
  );
}

export function AdvancedSearch({ title, fields, initial, onApply, onClose }: Props) {
  const [values, setValues] = useState<Criteria>(initial);
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = () => {
    // Blank fields are dropped rather than sent empty, so the URL carries only
    // what the user actually asked for. A radio left on its default is no
    // filter either: "Transactions" is what the page shows anyway.
    const out: Criteria = {};
    for (const [k, v] of Object.entries(values)) {
      const f = fields.find((x) => x.key === k);
      if (f?.kind === "radio" && v === f.defaultValue) continue;
      if (v.trim()) out[k] = v.trim();
    }
    onApply(out);
  };

  const control = (f: SearchField) => {
    const v = values[f.key] ?? "";
    switch (f.kind) {
      case "text":
        return (
          <input
            value={v}
            onChange={(e) => set(f.key, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && apply()}
            className={INPUT}
          />
        );
      case "select":
        return (
          <SearchSelect
            value={v || null}
            onChange={(id) => set(f.key, id ?? "")}
            options={fieldOptions(f).map((o) => ({ id: o.value, label: o.label }))}
            placeholder="All"
            keepOrder
            buttonClassName={INPUT}
          />
        );
      case "radio": {
        const current = v || f.defaultValue || "";
        return (
          <div className="space-y-2 pt-1">
            {fieldOptions(f).map((o) => (
              <label key={o.value} className="flex cursor-pointer items-start gap-2 text-[13px]">
                <input
                  type="radio"
                  name={f.key}
                  checked={current === o.value}
                  onChange={() => set(f.key, o.value)}
                  className="mt-0.5 accent-brand-500"
                />
                <span>
                  <span className="text-gray-800">{o.label}</span>
                  {o.hint && current === o.value && (
                    <span className="mt-0.5 block text-[12px] text-gray-500">{o.hint}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        );
      }
      case "contact":
        return <ContactPicker value={v} onChange={(x) => set(f.key, x)} type={f.contactType ?? "vendor"} />;
      case "account":
        return <AccountPicker value={v} onChange={(x) => set(f.key, x)} field={f} />;
      case "item":
        return <ItemPicker value={v} onChange={(x) => set(f.key, x)} field={f} />;
      case "employee":
        return <EmployeePicker value={v} onChange={(x) => set(f.key, x)} />;
      case "dateRange":
        return (
          <div className="flex items-center gap-2">
            <DateInput
              value={values[`${f.key}From`] ?? ""}
              onChange={(e) => set(`${f.key}From`, e.target.value)}
              className={INPUT}
            />
            <span className="text-gray-400">-</span>
            <DateInput
              value={values[`${f.key}To`] ?? ""}
              onChange={(e) => set(`${f.key}To`, e.target.value)}
              className={INPUT}
            />
          </div>
        );
      case "numberRange":
        return (
          <div className="flex items-center gap-2">
            <input
              inputMode="decimal"
              value={values[`${f.key}Min`] ?? ""}
              onChange={(e) => set(`${f.key}Min`, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              className={INPUT}
            />
            <span className="text-gray-400">-</span>
            <input
              inputMode="decimal"
              value={values[`${f.key}Max`] ?? ""}
              onChange={(e) => set(`${f.key}Max`, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              className={INPUT}
            />
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-3 py-6 sm:py-16">
      {/* role=dialog so the pickers' lists portal in here and count as inside it. */}
      <div role="dialog" aria-label={`Search ${title}`} className="relative w-full max-w-[72rem] rounded-lg bg-white shadow-xl">
        <div className="flex items-center gap-4 border-b bg-gray-50 px-5 py-3 sm:px-8">
          <div className="text-[13px] text-gray-700 sm:w-36 sm:text-right">Search</div>
          <div className="input w-full max-w-xs text-gray-800">
            {title}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto text-2xl leading-none text-gray-500 hover:text-gray-800"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-1 gap-x-10 gap-y-4 px-5 py-6 sm:px-8 lg:grid-cols-2">
          {fields.map((f) => (
            <Row key={f.key} label={f.label} wide={f.wide || f.kind === "radio"}>
              {control(f)}
            </Row>
          ))}
        </div>

        <div className="flex justify-center gap-2 border-t px-5 py-4">
          <button onClick={apply} className="btn-primary">
            Search
          </button>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** How many fields a set of criteria fills — a range counts once. */
export function criteriaCount(c: Criteria): number {
  return new Set(Object.keys(c).map((k) => k.replace(/(From|To|Min|Max)$/, ""))).size;
}

/**
 * Advanced search's mark: a thin-lined magnifier with a solid four-point
 * sparkle in its lens and another above — search, with something extra. Drawn
 * on the 20px grid it is shown at, with fine strokes, so it stays sharp at
 * button size; at heavier weights the lens sparkle filled the glass into a
 * blot. Drawn here because the icon set has no such glyph.
 */
export function AdvancedSearchIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="8" cy="9" r="5.5" />
      <path d="M12 13l5.5 5.5" />
      <path d="M8 6.4Q8.3 8.7 10.6 9Q8.3 9.3 8 11.6Q7.7 9.3 5.4 9Q7.7 8.7 8 6.4Z" fill="currentColor" strokeWidth={0.5} />
      <path d="M16 0.8Q16.4 3.1 18.7 3.5Q16.4 3.9 16 6.2Q15.6 3.9 13.3 3.5Q15.6 3.1 16 0.8Z" fill="currentColor" strokeWidth={0.5} />
    </svg>
  );
}

/**
 * The header button that opens the dialog: the mark alone, in black, named
 * "Advanced search" for the tooltip and screen readers. Once criteria are
 * applied it is tinted with a count beside it, and an × drops them all.
 */
export function AdvancedButton({
  count,
  onOpen,
  onClear,
}: {
  count: number;
  onOpen: () => void;
  onClear: () => void;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded border text-[13px] ${
        count ? "border-brand-500 bg-brand-50 text-brand-700" : "border-gray-300 text-gray-900"
      }`}
    >
      <button
        onClick={onOpen}
        title="Advanced search"
        aria-label={count ? `Advanced search, ${count} applied` : "Advanced search"}
        className="flex items-center gap-1 px-2 py-1.5 hover:bg-gray-50/50"
      >
        <AdvancedSearchIcon />
        {count > 0 && (
          <span className="min-w-[1.1rem] rounded-full bg-brand-500 px-1 text-center text-[11px] font-semibold leading-[1.1rem] text-white">
            {count}
          </span>
        )}
      </button>
      {count > 0 && (
        <button onClick={onClear} title="Clear the advanced search" className="border-l border-brand-200 px-1.5 py-1.5 hover:text-brand-900">
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Advanced search for a page that is not a ListPage: the criteria, the button
 * that opens the dialog, and the dialog itself. The page decides what the
 * criteria do — send them to its endpoint as query parameters (spread
 * `criteria` into the URL and the query key), or, where the whole list is
 * already on the client, pass its rows through `filterRows`.
 *
 *   const adv = useAdvancedSearch("Batches", BATCH_SEARCH);
 *   …header: {adv.button}   …end of page: {adv.dialog}
 */
export function useAdvancedSearch(title: string, fields: SearchField[]) {
  const [criteria, setCriteria] = useState<Criteria>({});
  const [open, setOpen] = useState(false);
  return {
    criteria,
    setCriteria,
    active: Object.keys(criteria).length > 0,
    button: (
      <AdvancedButton count={criteriaCount(criteria)} onOpen={() => setOpen(true)} onClear={() => setCriteria({})} />
    ),
    dialog: open ? (
      <AdvancedSearch
        title={title}
        fields={fields}
        initial={criteria}
        onClose={() => setOpen(false)}
        onApply={(c) => {
          setCriteria(c);
          setOpen(false);
        }}
      />
    ) : null,
  };
}

/**
 * The same criteria applied on the client, for a list already loaded whole.
 *
 * `get(row, key)` returns the value a field tests — a string for text, select,
 * radio and pickers (an id, compared exactly), a "YYYY-MM-DD" for a date, a
 * number for an amount. Return an array to test several values (a row matches
 * if any does). A field `get` returns undefined for is not applied, so a page
 * can leave a field to its own logic.
 *
 * Text follows the quick search's rule (matchesTerm: words from their start,
 * numbers anywhere), so a box here behaves like the one in the top bar.
 */
export type RowValue = string | number | null | undefined;
export function filterRows<T>(
  rows: T[],
  fields: SearchField[],
  criteria: Criteria,
  get: (row: T, key: string) => RowValue | RowValue[] | undefined,
): T[] {
  const tests: ((row: T) => boolean)[] = [];
  const vals = (row: T, key: string): RowValue[] | undefined => {
    const v = get(row, key);
    return v === undefined ? undefined : Array.isArray(v) ? v : [v];
  };
  for (const f of fields) {
    if (f.kind === "dateRange" || f.kind === "numberRange") {
      const [a, b] = f.kind === "dateRange" ? ["From", "To"] : ["Min", "Max"];
      const lo = criteria[`${f.key}${a}`];
      const hi = criteria[`${f.key}${b}`];
      if (!lo && !hi) continue;
      const num = f.kind === "numberRange";
      tests.push((row) => {
        const vs = vals(row, f.key);
        if (vs === undefined) return true;
        return vs.some((x) => {
          if (x == null || x === "") return false;
          if (num) {
            const n = Number(x);
            return (!lo || n >= Number(lo)) && (!hi || n <= Number(hi));
          }
          const d = String(x).slice(0, 10);
          return (!lo || d >= lo) && (!hi || d <= hi);
        });
      });
      continue;
    }
    const want = criteria[f.key];
    if (!want) continue;
    tests.push((row) => {
      const vs = vals(row, f.key);
      if (vs === undefined) return true;
      if (f.kind === "text") return matchesTerm(want, vs.map((x) => (x == null ? "" : String(x))));
      return vs.some((x) => x != null && String(x) === want);
    });
  }
  return tests.length ? rows.filter((r) => tests.every((t) => t(r))) : rows;
}
