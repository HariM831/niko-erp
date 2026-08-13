import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  Badge,
  Banner,
  EmptyRow,
  Modal,
  NameCell,
  RowAction,
  RowActions,
  SettingsTable,
} from "../components/settings-ui";

export interface CustomFieldOption {
  id: string;
  label: string;
  isActive: boolean;
}

export interface CustomField {
  id: string;
  entity: string;
  label: string;
  dataType: string;
  isMandatory: boolean;
  showInPdf: boolean;
  isActive: boolean;
  helpText: string | null;
  maxLength: number | null;
  minValue: string | null;
  maxValue: string | null;
  lookupEntity: string | null;
  options: CustomFieldOption[];
  usageCount: number;
}

/** Zoho's data type list, minus the three deferred to a later phase. */
export const DATA_TYPES: Array<{ key: string; label: string }> = [
  { key: "text", label: "Text Box (Single Line)" },
  { key: "textarea", label: "Text Box (Multi-line)" },
  { key: "email", label: "Email" },
  { key: "url", label: "URL" },
  { key: "phone", label: "Phone" },
  { key: "number", label: "Number" },
  { key: "decimal", label: "Decimal" },
  { key: "amount", label: "Amount" },
  { key: "percent", label: "Percent" },
  { key: "date", label: "Date" },
  { key: "datetime", label: "Date and Time" },
  { key: "checkbox", label: "Check Box" },
  { key: "dropdown", label: "Dropdown" },
  { key: "multiselect", label: "Multi-select" },
  { key: "lookup", label: "Lookup" },
];

const TYPE_LABEL = Object.fromEntries(DATA_TYPES.map((t) => [t.key, t.label]));
const NEEDS_OPTIONS = ["dropdown", "multiselect"];

interface EntityMeta {
  entities: Array<{ key: string; label: string; plural: string }>;
  lookupTargets: string[];
  maxPerEntity: number;
}

export function CustomFieldsTab({ entity }: { entity: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: meta } = useQuery({
    queryKey: ["custom-field-entities"],
    queryFn: () => api<EntityMeta>("/api/custom-fields/entities"),
  });
  const { data: fields, isLoading } = useQuery({
    queryKey: ["custom-fields", entity],
    queryFn: () => api<CustomField[]>(`/api/custom-fields?entity=${entity}`),
  });

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["custom-fields"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  const remove = (f: CustomField) => {
    if (!confirm(`Delete the "${f.label}" field?`)) return;
    void run(() => api(`/api/custom-fields/${f.id}`, { method: "DELETE" }));
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-6">
        <p className="max-w-2xl text-[13px] text-gray-500">
          Information that doesn&rsquo;t fit an existing field. Custom fields are recorded on the
          document and never reach the ledger — anything you want to slice the profit and loss by
          belongs in Reporting Tags instead.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-[12px] text-gray-500">
            {fields?.length ?? 0}/{meta?.maxPerEntity ?? 25}
          </span>
          <button onClick={() => setAdding(true)} className="btn-primary">
            + New Field
          </button>
        </div>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <SettingsTable
        columns={[
          { label: "Field Name" },
          { label: "Data Type", width: "w-52" },
          { label: "Mandatory", width: "w-28" },
          { label: "Show in PDF", width: "w-28" },
          { label: "Status", width: "w-28" },
          { label: "", align: "right", width: "w-28" },
        ]}
      >
        {isLoading && <EmptyRow colSpan={6}>Loading…</EmptyRow>}
        {fields?.length === 0 && (
          <EmptyRow colSpan={6}>
            Do you have information that doesn&rsquo;t go under any existing field? Create one.
          </EmptyRow>
        )}
        {fields?.map((f) => (
          <tr key={f.id} className="s-row">
            <td className="s-td">
              <NameCell
                name={f.label}
                onClick={() => setEditing(f)}
                sub={
                  f.dataType === "lookup"
                    ? `Looks up a ${f.lookupEntity}`
                    : NEEDS_OPTIONS.includes(f.dataType)
                      ? f.options.map((o) => o.label).join(", ")
                      : f.helpText
                }
              />
            </td>
            <td className="s-td text-gray-600">{TYPE_LABEL[f.dataType] ?? f.dataType}</td>
            <td className="s-td text-gray-600">{f.isMandatory ? "Yes" : "No"}</td>
            <td className="s-td text-gray-600">{f.showInPdf ? "Yes" : "No"}</td>
            <td className="s-td">
              {f.isActive ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Inactive</Badge>}
            </td>
            <td className="s-td">
              <RowActions>
                <RowAction
                  onClick={() =>
                    void run(() =>
                      api(`/api/custom-fields/${f.id}`, {
                        method: "PATCH",
                        body: { isActive: !f.isActive },
                      }),
                    )
                  }
                >
                  {f.isActive ? "Deactivate" : "Activate"}
                </RowAction>
                {f.usageCount === 0 && (
                  <RowAction tone="danger" onClick={() => remove(f)}>
                    Delete
                  </RowAction>
                )}
              </RowActions>
            </td>
          </tr>
        ))}
      </SettingsTable>

      {(adding || editing) && meta && (
        <FieldModal
          entity={entity}
          field={editing}
          lookupTargets={meta.lookupTargets}
          entityLabels={Object.fromEntries(meta.entities.map((e) => [e.key, e.label]))}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onDone={() => {
            setAdding(false);
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["custom-fields"] });
          }}
        />
      )}
    </div>
  );
}

function FieldModal({
  entity,
  field,
  lookupTargets,
  entityLabels,
  onClose,
  onDone,
}: {
  entity: string;
  field: CustomField | null;
  lookupTargets: string[];
  entityLabels: Record<string, string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const editing = !!field;
  const [label, setLabel] = useState(field?.label ?? "");
  const [dataType, setDataType] = useState(field?.dataType ?? "text");
  const [isMandatory, setMandatory] = useState(field?.isMandatory ?? false);
  const [showInPdf, setShowInPdf] = useState(field?.showInPdf ?? false);
  const [helpText, setHelpText] = useState(field?.helpText ?? "");
  const [lookupEntity, setLookupEntity] = useState(field?.lookupEntity ?? lookupTargets[0] ?? "");
  const [optionText, setOptionText] = useState(
    field?.options.map((o) => o.label).join("\n") ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsOptions = NEEDS_OPTIONS.includes(dataType);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/custom-fields/${field!.id}`, {
          method: "PATCH",
          body: { label, isMandatory, showInPdf, helpText: helpText || undefined },
        });
      } else {
        await api("/api/custom-fields", {
          method: "POST",
          body: {
            entity,
            label,
            dataType,
            isMandatory,
            showInPdf,
            helpText: helpText || undefined,
            lookupEntity: dataType === "lookup" ? lookupEntity : undefined,
            options: needsOptions
              ? optionText.split("\n").map((s) => s.trim()).filter(Boolean)
              : undefined,
          },
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? `Edit ${field!.label}` : "New Field"}
      onClose={onClose}
      width="w-[560px]"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !label.trim() || (needsOptions && !editing && !optionText.trim())}
            className="btn-primary"
          >
            Save
          </button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}

      <div className="space-y-4">
        <div>
          <label className="label-required">Label Name *</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="input" autoFocus />
        </div>

        <div>
          <label className="label-required">Data Type *</label>
          <select
            value={dataType}
            disabled={editing}
            onChange={(e) => setDataType(e.target.value)}
            className="input disabled:bg-gray-50 disabled:text-gray-500"
          >
            {DATA_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          {editing && (
            <p className="mt-1 text-[12px] text-gray-500">
              The type cannot change once the field exists — values already recorded would have
              nowhere to live. Deactivate this one and add another instead.
            </p>
          )}
        </div>

        {dataType === "lookup" && !editing && (
          <div>
            <label className="label-required">Looks up *</label>
            <select
              value={lookupEntity}
              onChange={(e) => setLookupEntity(e.target.value)}
              className="input"
            >
              {lookupTargets.map((t) => (
                <option key={t} value={t}>
                  {entityLabels[t] ?? t}
                </option>
              ))}
            </select>
          </div>
        )}

        {needsOptions && !editing && (
          <div>
            <label className="label-required">Choices *</label>
            <textarea
              value={optionText}
              onChange={(e) => setOptionText(e.target.value)}
              rows={4}
              placeholder={"One per line\nGrade A\nGrade B"}
              className="input"
            />
          </div>
        )}

        <div>
          <label className="label">Help Text</label>
          <input
            value={helpText}
            onChange={(e) => setHelpText(e.target.value)}
            className="input"
            placeholder="Shown under the field on the form"
          />
        </div>

        <div>
          <span className="label">Is Mandatory</span>
          <div className="mt-1 flex gap-5">
            <label className="flex cursor-pointer items-center gap-1.5 text-[13px]">
              <input type="radio" checked={isMandatory} onChange={() => setMandatory(true)} /> Yes
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-[13px]">
              <input type="radio" checked={!isMandatory} onChange={() => setMandatory(false)} /> No
            </label>
          </div>
        </div>

        <div>
          <span className="label">Show in All PDFs</span>
          <div className="mt-1 flex gap-5">
            <label className="flex cursor-pointer items-center gap-1.5 text-[13px]">
              <input type="radio" checked={showInPdf} onChange={() => setShowInPdf(true)} /> Yes
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-[13px]">
              <input type="radio" checked={!showInPdf} onChange={() => setShowInPdf(false)} /> No
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}
