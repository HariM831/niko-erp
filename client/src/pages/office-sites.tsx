/**
 * Gates & Weighbridges — the physical places a truck passes through.
 *
 * Both tables were empty until this screen existed, which meant gate-in captured
 * a GPS fix and compared it to nothing, and a weight was entered against no
 * platform. Reference data with no way to enter it is the same as a missing
 * feature, just harder to notice.
 *
 * Coordinates are optional. A gate works the moment it has a name; without a
 * latitude and longitude the geofence simply does not apply, and the screen says
 * so rather than leaving someone to wonder why nothing is ever out of range.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, Scale } from "lucide-react";
import { ApiError, api } from "../api";
import { Banner, EmptyRow, SettingsHeader, SettingsTable } from "../components/settings-ui";

interface Gate {
  id: string;
  name: string;
  locationId: string;
  locationName: string | null;
  latitude: string | null;
  longitude: string | null;
  radiusM: number;
  isActive: boolean;
  receipts: number;
}

interface Weighbridge {
  id: string;
  name: string;
  locationId: string;
  locationName: string | null;
  capacityKg: string | null;
  isActive: boolean;
  weighings: number;
}

interface Sites {
  gates: Gate[];
  weighbridges: Weighbridge[];
}

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

export function OfficeSitesSection() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [adding, setAdding] = useState<"gate" | "weighbridge" | null>(null);

  const { data } = useQuery<Sites>({
    queryKey: ["office-sites"],
    queryFn: () => api("/api/office-sites"),
  });
  const { data: locations } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["locations-for-sites"],
    queryFn: () => api("/api/locations"),
  });

  const after = (msg: string) => {
    setSaved(msg);
    setError(null);
    setAdding(null);
    void qc.invalidateQueries({ queryKey: ["office-sites"] });
  };
  const onError = (e: unknown) => setError(e instanceof ApiError ? e.message : "Could not save");

  const toggle = useMutation({
    mutationFn: (v: { kind: "gates" | "weighbridges"; id: string; isActive: boolean }) =>
      api(`/api/office-sites/${v.kind}/${v.id}`, { method: "PATCH", body: { isActive: v.isActive } }),
    onSuccess: (_r, v) => after(v.isActive ? "Back in service" : "Taken out of service"),
    onError,
  });

  return (
    <div>
      <SettingsHeader
        title="Gates & Weighbridges"
      />
      {saved && <Banner tone="success">{saved}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      {/* ─────────────── Gates ─────────────── */}
      <div className="mb-2 mt-5 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-[#212529]">
          <MapPin size={15} /> Gates
        </h3>
        <button onClick={() => setAdding(adding === "gate" ? null : "gate")} className="btn-secondary flex items-center gap-1">
          <Plus size={14} /> Add gate
        </button>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[600px]">
          <SettingsTable
            columns={[
              { label: "Gate", width: "w-[26%]" },
              { label: "Location", width: "w-[24%]" },
              { label: "Geofence" },
              { label: "Used", align: "right", width: "w-[12%]" },
              { label: "", align: "right", width: "w-[12%]" },
            ]}
          >
            {!data?.gates.length && (
              <EmptyRow colSpan={5}>
                No gates yet — gate-in records a GPS fix but has nothing to measure it against.
              </EmptyRow>
            )}
            {data?.gates.map((g) => (
              <tr key={g.id} className={`border-b border-[#ece3d5] ${g.isActive ? "" : "text-gray-400"}`}>
                <td className="px-3 py-2 text-[13px] font-medium">
                  {g.name}
                  {!g.isActive && <span className="ml-1.5 text-[11px]">out of service</span>}
                </td>
                <td className="px-3 py-2 text-[12px] text-gray-600">{g.locationName ?? "—"}</td>
                <td className="px-3 py-2 text-[12px] text-gray-600">
                  {g.latitude && g.longitude ? (
                    <>
                      {Number(g.latitude).toFixed(5)}, {Number(g.longitude).toFixed(5)}
                      <span className="ml-1.5 text-gray-400">within {g.radiusM} m</span>
                    </>
                  ) : (
                    <span className="text-amber-700">No coordinates — geofence does not apply</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-[12px] tabular-nums text-gray-500">
                  {g.receipts === 0 ? "—" : `${g.receipts} receipt${g.receipts === 1 ? "" : "s"}`}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => toggle.mutate({ kind: "gates", id: g.id, isActive: !g.isActive })}
                    className="text-[11px] text-gray-400 hover:text-gray-800"
                  >
                    {g.isActive ? "Take out" : "Restore"}
                  </button>
                </td>
              </tr>
            ))}
          </SettingsTable>
        </div>
      </div>

      {adding === "gate" && (
        <GateForm locations={locations ?? []} onDone={after} onError={onError} onCancel={() => setAdding(null)} />
      )}

      {/* ──────────── Weighbridges ──────────── */}
      <div className="mb-2 mt-8 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-[#212529]">
          <Scale size={15} /> Weighbridges
        </h3>
        <button
          onClick={() => setAdding(adding === "weighbridge" ? null : "weighbridge")}
          className="btn-secondary flex items-center gap-1"
        >
          <Plus size={14} /> Add weighbridge
        </button>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          <SettingsTable
            columns={[
              { label: "Weighbridge", width: "w-[30%]" },
              { label: "Location", width: "w-[28%]" },
              { label: "Capacity" },
              { label: "Used", align: "right", width: "w-[14%]" },
              { label: "", align: "right", width: "w-[12%]" },
            ]}
          >
            {!data?.weighbridges.length && (
              <EmptyRow colSpan={5}>
                No weighbridges yet — a weight is recorded without saying which platform read it.
              </EmptyRow>
            )}
            {data?.weighbridges.map((w) => (
              <tr key={w.id} className={`border-b border-[#ece3d5] ${w.isActive ? "" : "text-gray-400"}`}>
                <td className="px-3 py-2 text-[13px] font-medium">
                  {w.name}
                  {!w.isActive && <span className="ml-1.5 text-[11px]">out of service</span>}
                </td>
                <td className="px-3 py-2 text-[12px] text-gray-600">{w.locationName ?? "—"}</td>
                <td className="px-3 py-2 text-[12px] text-gray-600">
                  {w.capacityKg ? (
                    `${Number(w.capacityKg).toLocaleString("en-IN")} kg`
                  ) : (
                    <span className="text-gray-400">No ceiling checked</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-[12px] tabular-nums text-gray-500">
                  {w.weighings === 0 ? "—" : `${w.weighings} weighing${w.weighings === 1 ? "" : "s"}`}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => toggle.mutate({ kind: "weighbridges", id: w.id, isActive: !w.isActive })}
                    className="text-[11px] text-gray-400 hover:text-gray-800"
                  >
                    {w.isActive ? "Take out" : "Restore"}
                  </button>
                </td>
              </tr>
            ))}
          </SettingsTable>
        </div>
      </div>

      {adding === "weighbridge" && (
        <WeighbridgeForm
          locations={locations ?? []}
          onDone={after}
          onError={onError}
          onCancel={() => setAdding(null)}
        />
      )}

      <p className="mt-6 max-w-2xl text-[11px] text-gray-500">
        Neither is ever deleted. A gate that admitted two hundred trucks is named on two hundred
        receipts, so it goes out of service instead — off tomorrow's list, still readable on
        yesterday's records.
      </p>
    </div>
  );
}

interface FormProps {
  locations: Array<{ id: string; name: string }>;
  onDone: (msg: string) => void;
  onError: (e: unknown) => void;
  onCancel: () => void;
}

function GateForm({ locations, onDone, onError, onCancel }: FormProps) {
  const [f, setF] = useState({ name: "", locationId: locations[0]?.id ?? "", latitude: "", longitude: "", radiusM: "200" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      api("/api/office-sites/gates", {
        method: "POST",
        body: {
          name: f.name.trim(),
          locationId: f.locationId,
          latitude: orNull(f.latitude),
          longitude: orNull(f.longitude),
          radiusM: Number(f.radiusM) || 200,
        },
      }),
    onSuccess: () => onDone(`${f.name.trim()} added`),
    onError,
  });

  // One coordinate without the other cannot place a gate, so the server refuses
  // it. Checked here too, to say so before the round trip.
  const lopsided = !!orNull(f.latitude) !== !!orNull(f.longitude);

  return (
    <div className="mt-3 max-w-2xl rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label-required">Gate name *</label>
          <input value={f.name} onChange={set("name")} placeholder="Main Gate" className="input" />
        </div>
        <div>
          <label className="label-required">Location *</label>
          <select value={f.locationId} onChange={set("locationId")} className="input">
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Latitude</label>
          <input value={f.latitude} onChange={set("latitude")} inputMode="decimal" placeholder="26.44521" className="input" />
        </div>
        <div>
          <label className="label">Longitude</label>
          <input value={f.longitude} onChange={set("longitude")} inputMode="decimal" placeholder="91.44127" className="input" />
        </div>
        <div>
          <label className="label">Geofence radius (m)</label>
          <input value={f.radiusM} onChange={set("radiusM")} inputMode="numeric" className="input" />
        </div>
      </div>

      {lopsided && (
        <p className="mt-2 text-[12px] text-red-600">
          A gate needs both coordinates, or neither — one alone cannot place it.
        </p>
      )}
      <p className="mt-2 text-[11px] text-gray-500">
        Coordinates are optional. Stand at the gate and read them off a phone when convenient; until
        then the gate works and the geofence stays off.
      </p>

      <div className="mt-3 flex gap-2">
        <button
          className="btn-primary"
          disabled={!f.name.trim() || !f.locationId || lopsided || create.isPending}
          onClick={() => create.mutate()}
        >
          Add gate
        </button>
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function WeighbridgeForm({ locations, onDone, onError, onCancel }: FormProps) {
  const [f, setF] = useState({ name: "", locationId: locations[0]?.id ?? "", capacityKg: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      api("/api/office-sites/weighbridges", {
        method: "POST",
        body: { name: f.name.trim(), locationId: f.locationId, capacityKg: orNull(f.capacityKg) },
      }),
    onSuccess: () => onDone(`${f.name.trim()} added`),
    onError,
  });

  return (
    <div className="mt-3 max-w-2xl rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label-required">Weighbridge name *</label>
          <input value={f.name} onChange={set("name")} placeholder="Platform 1" className="input" />
        </div>
        <div>
          <label className="label-required">Location *</label>
          <select value={f.locationId} onChange={set("locationId")} className="input">
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Capacity (kg)</label>
          <input value={f.capacityKg} onChange={set("capacityKg")} inputMode="decimal" placeholder="60000" className="input" />
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        Capacity is the sanity ceiling on an entered weight — a 60-tonne platform cannot read 600
        tonnes, and a typo that says it should be caught at the cabin.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          className="btn-primary"
          disabled={!f.name.trim() || !f.locationId || create.isPending}
          onClick={() => create.mutate()}
        >
          Add weighbridge
        </button>
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
