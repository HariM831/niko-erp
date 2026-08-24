import { useEffect, useState } from "react";
import { api } from "../api";
import { useQuery } from "@tanstack/react-query";

/**
 * Field-by-field search, the way Zoho's "Advanced Search" works.
 *
 * The quick search matches text; this is where the rest lives — the ranges a
 * substring cannot express. An amount is the clearest case: "36841" is not a
 * sensible substring of 36,841.00, so a total is asked for as a range here
 * rather than matched as a string there.
 *
 * Only fields the module actually has are offered. Zoho's bill search carries
 * GST treatment, place of supply, TCS and projects; niko has none of those by
 * design, so they are absent rather than present and inert.
 */

export type FieldKind = "text" | "dateRange" | "numberRange" | "select" | "contact" | "account";

export interface SearchField {
  /** Query parameter. Ranges append From/To or Min/Max. */
  key: string;
  label: string;
  kind: FieldKind;
  /** For kind "select". */
  options?: string[];
  /** For kind "contact": which side to list. */
  contactType?: "customer" | "vendor";
}

export type Criteria = Record<string, string>;

interface Props {
  title: string;
  fields: SearchField[];
  initial: Criteria;
  onApply: (c: Criteria) => void;
  onClose: () => void;
}

const LABEL = "block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1";
const INPUT =
  "w-full rounded border border-gray-300 px-2 py-1.5 text-[13px] outline-none focus:border-brand-500";

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
    <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
      <option value="">All</option>
      {(data ?? []).map((c) => (
        <option key={c.id} value={c.id}>
          {c.displayName}
        </option>
      ))}
    </select>
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
    // what the user actually asked for and a shared link reads clearly.
    const out: Criteria = {};
    for (const [k, v] of Object.entries(values)) if (v.trim()) out[k] = v.trim();
    onApply(out);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 py-10">
      <div className="w-[46rem] rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-[15px] font-semibold text-gray-800">Search {title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-gray-400 hover:text-gray-600">
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-3 px-5 py-4">
          {fields.map((f) => (
            <div key={f.key}>
              <label className={LABEL}>{f.label}</label>
              {f.kind === "text" && (
                <input
                  value={values[f.key] ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={INPUT}
                />
              )}
              {f.kind === "select" && (
                <select
                  value={values[f.key] ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={INPUT}
                >
                  <option value="">All</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              )}
              {f.kind === "contact" && (
                <ContactPicker
                  value={values[f.key] ?? ""}
                  onChange={(v) => set(f.key, v)}
                  type={f.contactType ?? "vendor"}
                />
              )}
              {f.kind === "account" && (
                <input
                  value={values[f.key] ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder="Account name"
                  className={INPUT}
                />
              )}
              {f.kind === "dateRange" && (
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={values[`${f.key}From`] ?? ""}
                    onChange={(e) => set(`${f.key}From`, e.target.value)}
                    className={INPUT}
                  />
                  <span className="text-xs text-gray-400">to</span>
                  <input
                    type="date"
                    value={values[`${f.key}To`] ?? ""}
                    onChange={(e) => set(`${f.key}To`, e.target.value)}
                    className={INPUT}
                  />
                </div>
              )}
              {f.kind === "numberRange" && (
                <div className="flex items-center gap-2">
                  <input
                    inputMode="decimal"
                    placeholder="Min"
                    value={values[`${f.key}Min`] ?? ""}
                    onChange={(e) => set(`${f.key}Min`, e.target.value)}
                    className={INPUT}
                  />
                  <span className="text-xs text-gray-400">to</span>
                  <input
                    inputMode="decimal"
                    placeholder="Max"
                    value={values[`${f.key}Max`] ?? ""}
                    onChange={(e) => set(`${f.key}Max`, e.target.value)}
                    className={INPUT}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <button onClick={() => setValues({})} className="btn-secondary">
            Clear
          </button>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button onClick={apply} className="btn-primary">
            Search
          </button>
        </div>
      </div>
    </div>
  );
}
