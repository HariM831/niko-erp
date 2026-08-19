/**
 * Houses — the sheds, grouped by the site they stand on.
 *
 * Two facts about a shed that look like one and are not: WHERE it stands and
 * WHO owns it. All six sheds stand at Nalbari; Nandamuri and Luit own two each
 * and the rest are ours. Owner is what decides billing — feed delivered to a
 * Luit shed is a sale to Luit, and its eggs are a purchase from them — so it
 * cannot be inferred from the site, and the site cannot be inferred from it.
 *
 * Beyond those, only what else holds still: the type and the controller. Bird
 * count and feed on hand are readings — they move every day, they belong on the
 * screens that produce them, and putting them on a settings form invites
 * somebody to type over a measurement.
 */
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { ApiError, api } from "../api";
import { HOUSE_PURPOSE_LABELS, HOUSE_PURPOSES, type HousePurpose } from "@shared/schema/farms";
import { Banner, EmptyRow, SettingsHeader, SettingsTable } from "../components/settings-ui";

interface House {
  id: string;
  code: string;
  name: string | null;
  purpose: HousePurpose;
  displayOrder: number;
  bhDeviceId: string | null;
  isActive: boolean;
  locationId: string;
  locationName: string;
  ownerId: string | null;
  /** Null when the shed is ours; the screen shows our own name instead. */
  ownerName: string | null;
}

interface Context {
  sites: Array<{ id: string; code: string; name: string }>;
  owners: Array<{ id: string; name: string }>;
  ourName: string;
}

export function FarmHousesSection() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    locationId: "",
    ownerId: "",
    code: "",
    purpose: "lay" as HousePurpose,
    bhDeviceId: "",
  });

  const { data: houses } = useQuery<House[]>({
    queryKey: ["farm-houses"],
    queryFn: () => api("/api/farms/houses"),
  });
  const { data: ctx } = useQuery<Context>({
    queryKey: ["farm-context"],
    queryFn: () => api("/api/farms/context"),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["farm-houses"] });
    void qc.invalidateQueries({ queryKey: ["feed-transfer-context"] });
  };

  const create = useMutation({
    mutationFn: () =>
      api("/api/farms/houses", {
        method: "POST",
        body: {
          locationId: form.locationId,
          // Empty means ours, which is stored as no owner at all.
          ownerId: form.ownerId || null,
          code: form.code.trim(),
          purpose: form.purpose,
          bhDeviceId: form.bhDeviceId.trim() || null,
        },
      }),
    onSuccess: () => {
      setAdding(false);
      setForm({ locationId: "", ownerId: "", code: "", purpose: "lay", bhDeviceId: "" });
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not add that house"),
  });

  const toggle = useMutation({
    mutationFn: (h: House) =>
      api(`/api/farms/houses/${h.id}`, { method: "PATCH", body: { isActive: !h.isActive } }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not change that"),
  });

  // Grouped by site, because that is the thing you walk around. Owner varies
  // within a site — Nalbari carries sheds belonging to three companies — so it
  // is a column, not a heading.
  const bySite = (houses ?? []).reduce<Record<string, House[]>>((acc, h) => {
    (acc[h.locationName] = acc[h.locationName] ?? []).push(h);
    return acc;
  }, {});

  return (
    <div>
      <SettingsHeader
        title="Houses"
        description="The sheds at each site, who owns each one, what it is for, and the controller fitted to it. Owner decides who gets billed for feed and who the eggs are bought from. Bird counts and feed on hand are not here — they change daily and live on the screens that record them."
      />
      {error && <Banner tone="error">{error}</Banner>}

      <div className="mb-3">
        <button onClick={() => setAdding((v) => !v)} className="btn-secondary flex items-center gap-1">
          <Plus size={14} /> New house
        </button>
      </div>

      {adding && (
        <div className="card mb-4 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div>
              <label className="label-required">Site *</label>
              <select
                value={form.locationId}
                onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value }))}
                className="input"
              >
                <option value="">Choose…</option>
                {ctx?.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Owner</label>
              <select
                value={form.ownerId}
                onChange={(e) => setForm((f) => ({ ...f, ownerId: e.target.value }))}
                className="input"
              >
                <option value="">{ctx?.ourName ?? "Us"}</option>
                {ctx?.owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label-required">Code *</label>
              <input
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                placeholder="L6"
                className="input"
              />
            </div>
            <div>
              <label className="label-required">Type *</label>
              <select
                value={form.purpose}
                onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value as HousePurpose }))}
                className="input"
              >
                {HOUSE_PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {HOUSE_PURPOSE_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Controller</label>
              <input
                value={form.bhDeviceId}
                onChange={(e) => setForm((f) => ({ ...f, bhDeviceId: e.target.value }))}
                placeholder="Big Herdsman id"
                className="input"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => create.mutate()}
              disabled={!form.locationId || !form.code.trim() || create.isPending}
              className="btn-primary whitespace-nowrap"
            >
              {create.isPending ? "Adding…" : "Add house"}
            </button>
            <button onClick={() => setAdding(false)} className="btn-ghost">
              Cancel
            </button>
            <span className="text-[11px] text-gray-500">
              Its feed store is created with it — a house that cannot hold feed is not a house.
            </span>
          </div>
        </div>
      )}

      <SettingsTable
        columns={[
          { label: "House" },
          { label: "Owner" },
          { label: "Type" },
          { label: "Controller" },
          { label: "", width: "80px" },
        ]}
      >
        {!houses?.length && <EmptyRow colSpan={5}>No houses yet.</EmptyRow>}
        {Object.entries(bySite).map(([site, list]) => (
          // The key belongs on the fragment, not on the header row inside it —
          // a table cannot take a wrapper element, so the group IS the fragment.
          <Fragment key={site}>
            <tr>
              <td colSpan={5} className="bg-gray-50 px-3 py-1.5 text-[12px] font-semibold text-gray-600">
                {site}
              </td>
            </tr>
            {list.map((h) => (
              <tr key={h.id} className={`border-b border-gray-100 ${h.isActive ? "" : "opacity-50"}`}>
                <td className="px-3 py-2">
                  <span className="font-medium text-gray-900">{h.code}</span>
                  {h.name && <span className="ml-2 text-gray-500">{h.name}</span>}
                </td>
                <td className="px-3 py-2">
                  {h.ownerName ? (
                    <span className="text-gray-900">{h.ownerName}</span>
                  ) : (
                    <span className="text-gray-400">{ctx?.ourName ?? "Us"}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-600">{HOUSE_PURPOSE_LABELS[h.purpose]}</td>
                <td className="px-3 py-2 font-mono text-[12px] text-gray-500">
                  {h.bhDeviceId ?? "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => toggle.mutate(h)}
                    className="text-[12px] text-gray-400 hover:text-gray-800"
                  >
                    {h.isActive ? "Retire" : "Restore"}
                  </button>
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </SettingsTable>
    </div>
  );
}
