import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  Badge,
  Banner,
  Chip,
  EmptyRow,
  Modal,
  NameCell,
  RowAction,
  RowActions,
  SettingsHeader,
  SettingsTable,
} from "../components/settings-ui";

interface Location {
  id: string;
  code: string;
  name: string;
  type: string;
  isPrimary: boolean;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  pincode: string | null;
  phone: string | null;
  inCharge: string | null;
  notes: string | null;
  isActive: boolean;
}

const TYPES = [
  { key: "farm", label: "Farm" },
  { key: "feed_mill", label: "Feed Mill" },
  { key: "warehouse", label: "Warehouse" },
  { key: "office", label: "Office" },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.key, t.label]));

export function LocationsSection() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Location | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["locations"],
    queryFn: () => api<Location[]>("/api/locations"),
  });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const remove = (l: Location) => {
    if (!confirm(`Delete "${l.name}"?`)) return;
    act(() => api(`/api/locations/${l.id}`, { method: "DELETE" }));
  };

  return (
    <div>
      <SettingsHeader
        title="Locations"
        actions={
          <button onClick={() => setEditing("new")} className="btn-primary">
            + New Location
          </button>
        }
      />

      {error && <Banner tone="error">{error}</Banner>}

      <SettingsTable
        columns={[
          { label: "Name", width: "w-72" },
          { label: "Code", width: "w-24" },
          { label: "Type", width: "w-32" },
          { label: "Address" },
          { label: "Status", width: "w-28" },
          { label: "", align: "right", width: "w-32" },
        ]}
      >
        {isLoading && <EmptyRow colSpan={6}>Loading…</EmptyRow>}
        {rows?.length === 0 && (
          <EmptyRow colSpan={6}>
            No locations yet. Add your farms and the feed mill — the first one becomes the
            default for new transactions.
          </EmptyRow>
        )}
        {rows?.map((l) => (
          <tr key={l.id} className="s-row">
            <td className="s-td">
              <NameCell
                name={l.name}
                onClick={() => setEditing(l)}
                sub={l.inCharge}
                after={l.isPrimary ? <Chip>Primary</Chip> : null}
              />
            </td>
            <td className="s-td font-medium text-gray-700">{l.code}</td>
            <td className="s-td text-gray-600">{TYPE_LABEL[l.type] ?? l.type}</td>
            <td className="s-td text-gray-600">
              {[l.city, l.state].filter(Boolean).join(", ") || "—"}
            </td>
            <td className="s-td">
              {l.isActive ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Inactive</Badge>}
            </td>
            <td className="s-td">
              <RowActions>
                <RowAction onClick={() => setEditing(l)}>Edit</RowAction>
                {!l.isPrimary && (
                  <RowAction
                    onClick={() =>
                      act(() =>
                        api(`/api/locations/${l.id}`, {
                          method: "PATCH",
                          body: { isPrimary: true },
                        }),
                      )
                    }
                  >
                    Make primary
                  </RowAction>
                )}
                {!l.isPrimary && (
                  <RowAction tone="danger" onClick={() => remove(l)}>
                    Delete
                  </RowAction>
                )}
              </RowActions>
            </td>
          </tr>
        ))}
      </SettingsTable>

      {editing && (
        <LocationEditor
          location={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}

function LocationEditor({
  location,
  onClose,
  onDone,
}: {
  location: Location | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    code: location?.code ?? "",
    name: location?.name ?? "",
    type: location?.type ?? "farm",
    addressLine1: location?.addressLine1 ?? "",
    addressLine2: location?.addressLine2 ?? "",
    city: location?.city ?? "",
    state: location?.state ?? "",
    stateCode: location?.stateCode ?? "",
    pincode: location?.pincode ?? "",
    phone: location?.phone ?? "",
    inCharge: location?.inCharge ?? "",
    notes: location?.notes ?? "",
    isActive: location?.isActive ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const body = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v === "" ? undefined : v]),
    );
    try {
      if (location) {
        await api(`/api/locations/${location.id}`, { method: "PATCH", body });
      } else {
        await api("/api/locations", { method: "POST", body });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={location ? `Edit ${location.name}` : "New Location"}
      onClose={onClose}
      width="w-[640px]"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !form.name.trim() || !form.code.trim()}
            className="btn-primary"
          >
            {location ? "Save" : "Create Location"}
          </button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}

      <div className="grid grid-cols-6 gap-4">
        <div className="col-span-4">
          <label className="label-required">Location Name *</label>
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            className="input"
          />
        </div>
        <div className="col-span-2">
          <label className="label-required">Code *</label>
          <input
            value={form.code}
            onChange={(e) => set({ code: e.target.value.toUpperCase() })}
            placeholder="BH"
            className="input"
          />
        </div>

        <div className="col-span-2">
          <label className="label-required">Type *</label>
          <select
            value={form.type}
            onChange={(e) => set({ type: e.target.value })}
            className="input"
          >
            {TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label className="label">In Charge</label>
          <input
            value={form.inCharge}
            onChange={(e) => set({ inCharge: e.target.value })}
            className="input"
          />
        </div>
        <div className="col-span-2">
          <label className="label">Phone</label>
          <input
            value={form.phone}
            onChange={(e) => set({ phone: e.target.value })}
            className="input"
          />
        </div>

        <div className="col-span-6">
          <label className="label">Address</label>
          <input
            value={form.addressLine1}
            onChange={(e) => set({ addressLine1: e.target.value })}
            className="input"
          />
        </div>
        <div className="col-span-6">
          <input
            value={form.addressLine2}
            onChange={(e) => set({ addressLine2: e.target.value })}
            className="input"
          />
        </div>

        <div className="col-span-2">
          <label className="label">City</label>
          <input value={form.city} onChange={(e) => set({ city: e.target.value })} className="input" />
        </div>
        <div className="col-span-2">
          <label className="label">State</label>
          <input
            value={form.state}
            onChange={(e) => set({ state: e.target.value })}
            className="input"
          />
        </div>
        <div className="col-span-2">
          <label className="label">Pincode</label>
          <input
            value={form.pincode}
            onChange={(e) => set({ pincode: e.target.value })}
            className="input"
          />
        </div>

        <div className="col-span-6">
          <label className="label">Notes</label>
          <input
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
            className="input"
          />
        </div>

        {location && (
          <div className="col-span-6">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => set({ isActive: e.target.checked })}
              />
              Active
            </label>
            {location.isPrimary && (
              <p className="mt-1 text-[12px] text-gray-500">
                This is the primary location, so it cannot be deactivated. Promote another one
                first.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
