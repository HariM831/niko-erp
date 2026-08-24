/**
 * Devices — the phones at the gates and canteens.
 *
 * Pairing: mint a code here, type it on the phone; if the phone claims from an
 * unexpected install it lands in Pending requests for a human to approve.
 * Replacement codes carry targetDeviceId so the phone keeps its device row.
 * Staff PINs unlock/authorise on the devices; reason codes are the excuses a
 * device can offer for an override plate.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plus, RotateCw, X } from "lucide-react";
import { api } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Badge, Empty, ErrorBanner, Field, PageHeader, PillTabs, Spinner, Td, Th, timeAgo, useErr,
} from "../../components/payroll/ui";

interface DeviceRow {
  id: string;
  name: string;
  role: "gate" | "canteen";
  location: { id: string; code: string; name: string } | null;
  canteen: { id: string; name: string } | string | null;
  installId: string | null;
  deviceModel: string | null;
  appVersionCode: number | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}
interface PendingRequest {
  id: string;
  deviceName?: string;
  role?: "gate" | "canteen";
  deviceModel: string | null;
  osVersion: string | null;
  appVersionCode: number | null;
  latitude?: number | null;
  longitude?: number | null;
  requestedAt: string;
}
interface Canteen { id: string; code: string; name: string; isActive: boolean }
interface Location { id: string; code: string; name: string }
interface StaffPin { id: string; name: string; locationId: string; canteenId: string | null; canUnlock: boolean; canAuthorise: boolean; isActive: boolean }
interface ReasonCode { id: string; code: string; label: string; requiresText: boolean; isActive: boolean; displayOrder: number }

function useCountdown(target: string | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);
  if (!target) return "";
  const secs = Math.max(0, Math.round((new Date(target).getTime() - now) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

type Tab = "registry" | "pins" | "reasons";

export function PayrollDevicesPage() {
  const [tab, setTab] = useState<Tab>("registry");
  const reqQ = useQuery({
    queryKey: ["device", "pair-requests"],
    queryFn: () => api<PendingRequest[]>("/api/device/pair/requests"),
    refetchInterval: 30_000,
  });
  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Devices" sub="The phones at the gates and canteens, their PINs, and the reason codes they can offer." />
      <PillTabs
        tabs={[
          { key: "registry", label: "Registry", count: reqQ.data?.length },
          { key: "pins", label: "Staff PINs" },
          { key: "reasons", label: "Reason codes" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "registry" && <RegistryTab pending={reqQ.data ?? []} pendingLoading={reqQ.isLoading} />}
      {tab === "pins" && <PinsTab />}
      {tab === "reasons" && <ReasonsTab />}
    </div>
  );
}

/* ── Registry + pairing ────────────────────────────────────────────────── */
function RegistryTab({ pending, pendingLoading }: { pending: PendingRequest[]; pendingLoading: boolean }) {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const devicesQ = useQuery({ queryKey: ["device", "devices"], queryFn: () => api<DeviceRow[]>("/api/device/devices") });
  const [pairOpen, setPairOpen] = useState<{ replace?: DeviceRow } | null>(null);
  const [rotated, setRotated] = useState<{ name: string; token: string } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["device"] });
  const decideM = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" }) =>
      api(`/api/device/pair/requests/${id}/${action}`, { method: "POST" }),
    onSuccess: invalidate,
    onError: fail,
  });
  const revokeM = useMutation({
    mutationFn: (id: string) => api(`/api/device/devices/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: fail,
  });
  const rotateM = useMutation({
    mutationFn: (d: DeviceRow) => api<{ token: string }>(`/api/device/devices/${d.id}/rotate-token`, { method: "POST" }),
    onSuccess: (data, d) => { invalidate(); setRotated({ name: d.name, token: data.token }); },
    onError: fail,
  });

  const canteenName = (d: DeviceRow) => (typeof d.canteen === "string" ? d.canteen : d.canteen?.name) ?? null;
  const devices = [...(devicesQ.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />

      {/* Pending requests first — they are the thing waiting on a human */}
      {(pendingLoading || pending.length > 0) && (
        <div className="mb-4">
          <h2 className="mb-2 text-[14px] font-semibold">Pending pairing requests</h2>
          <div className="table-surface">
            {pendingLoading ? (
              <Spinner />
            ) : (
              <table className="w-full">
                <thead className="table-head">
                  <tr><Th>Device</Th><Th>Model</Th><Th>OS / app</Th><Th>Requested</Th><Th /></tr>
                </thead>
                <tbody>
                  {pending.map((r) => (
                    <tr key={r.id} className="table-row">
                      <Td className="font-medium">{r.deviceName ?? "—"} {r.role && <Badge tone="blue">{r.role}</Badge>}</Td>
                      <Td>{r.deviceModel ?? "—"}</Td>
                      <Td className="tabular-nums">{r.osVersion ?? "—"}{r.appVersionCode != null && ` · v${r.appVersionCode}`}</Td>
                      <Td>{timeAgo(r.requestedAt)}</Td>
                      <Td right>
                        <span className="flex justify-end gap-1">
                          <button className="btn-secondary !text-emerald-700" disabled={decideM.isPending} onClick={() => decideM.mutate({ id: r.id, action: "approve" })}>
                            <Check size={13} /> Approve
                          </button>
                          <button className="btn-ghost text-red-600" disabled={decideM.isPending} onClick={() => decideM.mutate({ id: r.id, action: "reject" })}>
                            <X size={13} /> Reject
                          </button>
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Registered devices</h2>
        <button className="btn-primary" onClick={() => setPairOpen({})}><Plus size={14} /> Pair a device</button>
      </div>
      <div className="table-surface overflow-x-auto">
        {devicesQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Name</Th><Th>Role</Th><Th>Location</Th><Th>Canteen</Th><Th>Model</Th><Th right>App</Th><Th>Last seen</Th><Th /></tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className={`table-row ${d.revokedAt ? "opacity-50" : ""}`}>
                  <Td className="font-medium">{d.name} {d.revokedAt && <Badge tone="red">revoked</Badge>}</Td>
                  <Td><Badge tone={d.role === "gate" ? "blue" : "gray"}>{d.role}</Badge></Td>
                  <Td>{d.location?.name ?? "—"}</Td>
                  <Td>{canteenName(d) ?? "—"}</Td>
                  <Td>{d.deviceModel ?? "—"}</Td>
                  <Td right>{d.appVersionCode != null ? `v${d.appVersionCode}` : "—"}</Td>
                  <Td>{timeAgo(d.lastSeenAt)}</Td>
                  <Td right>
                    {!d.revokedAt && (
                      <span className="flex justify-end gap-1">
                        <button className="btn-ghost" title="Replacement code — the phone keeps this device row" onClick={() => setPairOpen({ replace: d })}>Replace</button>
                        <button className="btn-ghost" title="Rotate token" disabled={rotateM.isPending} onClick={() => rotateM.mutate(d)}><RotateCw size={13} /></button>
                        <button className="btn-ghost text-red-600" onClick={() => revokeM.mutate(d.id)}>Revoke</button>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
              {!devices.length && <tr><Td colSpan={8}><Empty>No devices paired yet.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {pairOpen && <PairDialog replace={pairOpen.replace} onClose={() => setPairOpen(null)} />}

      {rotated && (
        <Dialog open onOpenChange={(v) => !v && setRotated(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>New token for {rotated.name}</DialogTitle></DialogHeader>
            <p className="text-[13px] text-gray-600">Shown once — enter it on the device now.</p>
            <div className="mt-2 flex items-center gap-2 rounded-md bg-gray-50 p-3">
              <code className="flex-1 break-all text-[13px]">{rotated.token}</code>
              <button className="btn-ghost" onClick={() => void navigator.clipboard.writeText(rotated.token)}><Copy size={14} /></button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function PairDialog({ replace, onClose }: { replace?: DeviceRow; onClose: () => void }) {
  const { err, setErr, fail } = useErr();
  const locQ = useQuery({ queryKey: ["locations"], queryFn: () => api<Location[]>("/api/locations") });
  const canteensQ = useQuery({ queryKey: ["canteen", "canteens"], queryFn: () => api<Canteen[]>("/api/canteen/canteens") });
  const [form, setForm] = useState({
    deviceName: replace ? replace.name : "",
    role: (replace?.role ?? "gate") as "gate" | "canteen",
    locationId: replace?.location?.id ?? "",
    canteenId: (replace && typeof replace.canteen !== "string" && replace.canteen?.id) || "",
  });
  const [result, setResult] = useState<{ code: string; expiresAt: string } | null>(null);
  const countdown = useCountdown(result?.expiresAt ?? null);

  const mint = useMutation({
    mutationFn: () =>
      api<{ code: string; expiresAt: string }>("/api/device/pair/codes", {
        method: "POST",
        body: {
          deviceName: form.deviceName.trim(),
          role: form.role,
          locationId: form.locationId,
          canteenId: form.role === "canteen" ? form.canteenId || null : null,
          targetDeviceId: replace?.id,
        },
      }),
    onSuccess: setResult,
    onError: fail,
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{replace ? `Replace ${replace.name}` : "Pair a device"}</DialogTitle>
        </DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        {!result ? (
          <>
            <div className="space-y-2">
              <Field label="Device name" required>
                <input className="input" value={form.deviceName} onChange={(e) => setForm({ ...form, deviceName: e.target.value })} placeholder="e.g. Main gate phone" disabled={!!replace} />
              </Field>
              <Field label="Role" required>
                <div className="flex rounded-md bg-gray-100 p-0.5 text-[13px]">
                  {(["gate", "canteen"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      disabled={!!replace}
                      onClick={() => setForm({ ...form, role: r })}
                      className={`flex-1 rounded px-2 py-1 capitalize ${form.role === r ? "bg-white font-medium shadow-sm" : "text-gray-500"}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Location" required>
                <select className="input" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} disabled={!!replace}>
                  <option value="">—</option>
                  {(locQ.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
              {form.role === "canteen" && (
                <Field label="Canteen" required>
                  <select className="input" value={form.canteenId} onChange={(e) => setForm({ ...form, canteenId: e.target.value })} disabled={!!replace}>
                    <option value="">—</option>
                    {(canteensQ.data ?? []).filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
              )}
              {replace && (
                <p className="text-[12px] text-gray-500">
                  The new phone takes over this device row — workers and history stay put. A replacement never moves sites.
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="btn-primary"
                disabled={mint.isPending || !form.deviceName.trim() || !form.locationId || (form.role === "canteen" && !form.canteenId)}
                onClick={() => mint.mutate()}
              >
                Generate code
              </button>
            </div>
          </>
        ) : (
          <div className="text-center">
            <p className="text-[13px] text-gray-600">Type this code on the phone:</p>
            <div className="my-3 text-4xl font-bold tracking-[0.3em] tabular-nums">{result.code}</div>
            <p className="text-[13px] text-gray-500">
              Expires in <span className="font-semibold tabular-nums">{countdown}</span>
            </p>
            <p className="mt-2 text-[12px] text-gray-400">
              If the phone reports "pending", approve it under Pending pairing requests.
            </p>
            <button className="btn-primary mt-4" onClick={onClose}>Done</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── Staff PINs ────────────────────────────────────────────────────────── */
function PinsTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const pinsQ = useQuery({ queryKey: ["device", "pins"], queryFn: () => api<StaffPin[]>("/api/device/pins") });
  const locQ = useQuery({ queryKey: ["locations"], queryFn: () => api<Location[]>("/api/locations") });
  const canteensQ = useQuery({ queryKey: ["canteen", "canteens"], queryFn: () => api<Canteen[]>("/api/canteen/canteens") });
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", locationId: "", canteenId: "", pin: "", canUnlock: true, canAuthorise: false });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["device", "pins"] });
  const createM = useMutation({
    mutationFn: () =>
      api("/api/device/pins", {
        method: "POST",
        body: { ...form, canteenId: form.canteenId || null },
      }),
    onSuccess: () => { invalidate(); setAddOpen(false); setForm({ name: "", locationId: "", canteenId: "", pin: "", canUnlock: true, canAuthorise: false }); },
    onError: fail,
  });
  const patchM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/api/device/pins/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
    onError: fail,
  });

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] text-gray-500">PINs unlock a device and authorise override plates. The PIN itself is never shown again.</p>
        <button className="btn-primary" onClick={() => setAddOpen(true)}><Plus size={14} /> Add PIN</button>
      </div>
      <div className="table-surface">
        {pinsQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Name</Th><Th>Location</Th><Th>Canteen</Th><Th>Can unlock</Th><Th>Can authorise</Th><Th /></tr>
            </thead>
            <tbody>
              {(pinsQ.data ?? []).map((p) => (
                <tr key={p.id} className={`table-row ${p.isActive ? "" : "opacity-50"}`}>
                  <Td className="font-medium">{p.name} {!p.isActive && <Badge tone="red">revoked</Badge>}</Td>
                  <Td>{locQ.data?.find((l) => l.id === p.locationId)?.name ?? "—"}</Td>
                  <Td>{canteensQ.data?.find((c) => c.id === p.canteenId)?.name ?? "any"}</Td>
                  <Td>
                    <input type="checkbox" checked={p.canUnlock} disabled={!p.isActive} onChange={(e) => patchM.mutate({ id: p.id, body: { canUnlock: e.target.checked } })} />
                  </Td>
                  <Td>
                    <input type="checkbox" checked={p.canAuthorise} disabled={!p.isActive} onChange={(e) => patchM.mutate({ id: p.id, body: { canAuthorise: e.target.checked } })} />
                  </Td>
                  <Td right>
                    {p.isActive && (
                      <button className="btn-ghost text-red-600" onClick={() => patchM.mutate({ id: p.id, body: { isActive: false } })}>Revoke</button>
                    )}
                  </Td>
                </tr>
              ))}
              {!pinsQ.data?.length && <tr><Td colSpan={6}><Empty>No staff PINs.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={(v) => !v && setAddOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add staff PIN</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Field label="Name" required><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Location" required>
              <select className="input" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                <option value="">—</option>
                {(locQ.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Canteen" hint="Leave empty for any canteen at the location">
              <select className="input" value={form.canteenId} onChange={(e) => setForm({ ...form, canteenId: e.target.value })}>
                <option value="">Any</option>
                {(canteensQ.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="PIN" required hint="4–6 digits; stored hashed, never shown again">
              <input className="input tabular-nums" inputMode="numeric" maxLength={6} value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })} />
            </Field>
            <div className="flex gap-4 text-[13px]">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.canUnlock} onChange={(e) => setForm({ ...form, canUnlock: e.target.checked })} /> Can unlock</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.canAuthorise} onChange={(e) => setForm({ ...form, canAuthorise: e.target.checked })} /> Can authorise</label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setAddOpen(false)}>Cancel</button>
            <button className="btn-primary" disabled={createM.isPending || !form.name.trim() || !form.locationId || form.pin.length < 4} onClick={() => createM.mutate()}>Add</button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── Reason codes ──────────────────────────────────────────────────────── */
function ReasonsTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const listQ = useQuery({ queryKey: ["device", "reason-codes"], queryFn: () => api<ReasonCode[]>("/api/device/reason-codes") });
  const [form, setForm] = useState({ code: "", label: "", requiresText: false });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["device", "reason-codes"] });
  const createM = useMutation({
    mutationFn: () => api("/api/device/reason-codes", { method: "POST", body: { ...form, code: form.code.trim().toUpperCase().replace(/\s+/g, "_") } }),
    onSuccess: () => { invalidate(); setForm({ code: "", label: "", requiresText: false }); },
    onError: fail,
  });
  const patchM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/api/device/reason-codes/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
    onError: fail,
  });

  const rows = [...(listQ.data ?? [])].sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code));

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Code"><input className="input w-40 uppercase" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="LOST_TOKEN" /></Field>
        <Field label="Label"><input className="input w-64" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="What the operator sees" /></Field>
        <label className="flex h-8 items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={form.requiresText} onChange={(e) => setForm({ ...form, requiresText: e.target.checked })} /> Requires a note
        </label>
        <button className="btn-primary" disabled={createM.isPending || !form.code.trim() || !form.label.trim()} onClick={() => createM.mutate()}>
          <Plus size={14} /> Add
        </button>
      </div>
      <div className="table-surface">
        {listQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head"><tr><Th>Code</Th><Th>Label</Th><Th>Requires note</Th><Th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`table-row ${r.isActive ? "" : "opacity-50"}`}>
                  <Td className="tabular-nums">{r.code}</Td>
                  <Td>{r.label}</Td>
                  <Td>
                    <input type="checkbox" checked={r.requiresText} onChange={(e) => patchM.mutate({ id: r.id, body: { requiresText: e.target.checked } })} />
                  </Td>
                  <Td right>
                    <button className="btn-ghost" onClick={() => patchM.mutate({ id: r.id, body: { isActive: !r.isActive } })}>
                      {r.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </Td>
                </tr>
              ))}
              {!rows.length && <tr><Td colSpan={4}><Empty>No reason codes — devices can only serve verified plates.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
