import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

interface FieldOption {
  id: string;
  label: string;
  isActive: boolean;
}

interface FieldDef {
  id: string;
  label: string;
  dataType: string;
  isMandatory: boolean;
  isActive: boolean;
  helpText: string | null;
  maxLength: number | null;
  lookupEntity: string | null;
  options: FieldOption[];
}

/** Field id → value, the shape the server's saveCustomFieldValues expects. */
export type CustomFieldValues = Record<string, unknown>;

const COLUMN_CLASS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
};

/** Where a lookup field gets its choices, keyed by the entity it points at. */
const LOOKUP_SOURCES: Record<string, { url: string; label: (r: never) => string }> = {
  contact: { url: "/api/contacts", label: (r: { displayName: string }) => r.displayName },
  item: { url: "/api/items", label: (r: { name: string }) => r.name },
  location: { url: "/api/locations", label: (r: { name: string }) => r.name },
  account: {
    url: "/api/accounting/accounts",
    label: (r: { code: string; name: string }) => `${r.code} · ${r.name}`,
  },
} as never;

function LookupSelect({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const source = field.lookupEntity ? LOOKUP_SOURCES[field.lookupEntity] : undefined;
  const { data } = useQuery({
    queryKey: ["lookup", field.lookupEntity],
    queryFn: () => api<Array<Record<string, string>>>(source!.url),
    enabled: !!source,
  });
  if (!source) return <p className="text-[12px] text-red-600">Misconfigured lookup</p>;
  return (
    <select
      value={(value as string) ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="input"
    >
      <option value="">—</option>
      {(data ?? []).map((r) => (
        <option key={r.id} value={r.id}>
          {(source.label as (x: unknown) => string)(r)}
        </option>
      ))}
    </select>
  );
}

/** Several master-data records, kept in the order they were picked. */
function LookupMultiSelect({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const source = field.lookupEntity ? LOOKUP_SOURCES[field.lookupEntity] : undefined;
  const { data } = useQuery({
    queryKey: ["lookup", field.lookupEntity],
    queryFn: () => api<Array<Record<string, string>>>(source!.url),
    enabled: !!source,
  });
  if (!source) return <p className="text-[12px] text-red-600">Misconfigured lookup</p>;
  const chosen = Array.isArray(value) ? (value as string[]) : [];
  const label = (r: Record<string, string>) => (source.label as (x: unknown) => string)(r);

  return (
    <div>
      {chosen.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {chosen.map((id) => {
            const r = (data ?? []).find((x) => x.id === id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2 py-0.5 text-[12px]"
              >
                {r ? label(r) : "(deleted)"}
                <button
                  onClick={() => onChange(chosen.filter((c) => c !== id))}
                  className="text-gray-400 hover:text-red-600"
                  aria-label="Remove"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <select
        value=""
        onChange={(e) => e.target.value && onChange([...chosen, e.target.value])}
        className="input"
      >
        <option value="">Add…</option>
        {(data ?? [])
          .filter((r) => !chosen.includes(r.id ?? ""))
          .map((r) => (
            <option key={r.id} value={r.id}>
              {label(r)}
            </option>
          ))}
      </select>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const cls = "input";
  switch (field.dataType) {
    case "textarea":
      return (
        <textarea
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className={cls}
        />
      );
    case "checkbox":
      return (
        <label className="flex h-9 cursor-pointer items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          Yes
        </label>
      );
    case "date":
      return (
        <input
          type="date"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        />
      );
    case "datetime":
      return (
        <input
          type="datetime-local"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        />
      );
    case "dropdown":
      return (
        <select
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cls}
        >
          <option value="">—</option>
          {field.options
            .filter((o) => o.isActive)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
        </select>
      );
    case "multiselect": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1.5">
          {field.options
            .filter((o) => o.isActive)
            .map((o) => (
              <label key={o.id} className="flex cursor-pointer items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={chosen.includes(o.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...chosen, o.id]
                        : chosen.filter((id) => id !== o.id),
                    )
                  }
                />
                {o.label}
              </label>
            ))}
        </div>
      );
    }
    case "lookup":
      return <LookupSelect field={field} value={value} onChange={onChange} />;
    case "multiselect_lookup":
      return <LookupMultiSelect field={field} value={value} onChange={onChange} />;
    case "autonumber":
      // Issued by the server on save, so there is nothing to type. Showing a
      // predicted number would be a promise a concurrent save could break.
      return (
        <div className="flex h-9 items-center text-[13px] text-gray-500">
          {value ? (
            <span className="font-medium tabular-nums text-gray-800">{String(value)}</span>
          ) : (
            "Assigned on save"
          )}
        </div>
      );
    default:
      // text, email, url, phone, number, decimal, amount, percent
      return (
        <input
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          maxLength={field.maxLength ?? undefined}
          inputMode={
            ["number", "decimal", "amount", "percent"].includes(field.dataType)
              ? "decimal"
              : undefined
          }
          className={cls}
        />
      );
  }
}

/**
 * The custom fields block on a create/edit form. Renders nothing at all when
 * the module has no active fields, so a form is unchanged until someone
 * actually defines one.
 */
export function CustomFieldsBlock({
  entity,
  value,
  onChange,
  columns = 3,
}: {
  entity: string;
  value: CustomFieldValues;
  onChange: (v: CustomFieldValues) => void;
  columns?: number;
}) {
  const { data } = useQuery({
    queryKey: ["custom-fields", entity],
    queryFn: () => api<FieldDef[]>(`/api/custom-fields?entity=${entity}`),
  });
  const fields = (data ?? []).filter((f) => f.isActive);
  if (!fields.length) return null;

  return (
    <div className="mb-6">
      <h3 className="mb-2 text-[13px] font-medium text-[#212529]">Additional Information</h3>
      {/* Static classes — Tailwind scans source text, so an interpolated
          `grid-cols-${n}` would never be generated. */}
      <div className={`grid max-w-3xl gap-4 ${COLUMN_CLASS[columns] ?? COLUMN_CLASS[3]}`}>
        {fields.map((f) => (
          <div key={f.id} className={f.dataType === "textarea" ? "col-span-2" : ""}>
            <label className={f.isMandatory ? "label-required" : "label"}>
              {f.label}
              {f.isMandatory ? " *" : ""}
            </label>
            <FieldInput
              field={f}
              value={value[f.id]}
              onChange={(v) => onChange({ ...value, [f.id]: v })}
            />
            {f.helpText && <p className="mt-1 text-[11px] text-gray-400">{f.helpText}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Read-only rendering for a detail page. */
export function CustomFieldsDisplay({
  values,
}: {
  values?: Array<{ fieldId: string; label: string; display: string }>;
}) {
  if (!values?.length) return null;
  return (
    <div className="mb-6">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        Additional Information
      </h3>
      <div className="grid max-w-3xl grid-cols-3 gap-x-8 gap-y-3">
        {values.map((v) => (
          <div key={v.fieldId}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {v.label}
            </div>
            <div className="mt-0.5 text-[13px]">{v.display || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
