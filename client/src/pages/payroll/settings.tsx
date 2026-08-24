/**
 * Payroll settings — the masters and the policy singleton.
 *
 *   Departments & designations
 *   Shifts (with weekly-off days)
 *   Holidays (recurring supported)
 *   Wage rate card (daily-wage roles)
 *   Statutory & policy (PF / ESI / PT slabs, hours, leave accrual, review score)
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, formatMoney } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Badge, Empty, ErrorBanner, Field, PageHeader, PillTabs, Spinner, Td, Th, dmy, istToday, num, useErr,
} from "../../components/payroll/ui";

interface Designation { id: string; name: string; displayOrder: number; isActive: boolean }
interface Department { id: string; name: string; isActive: boolean; designations: Designation[] }
interface WageRole { id: string; name: string; dailyRate: number | string; isActive: boolean; headcount?: number }
interface Shift { id: string; name: string; startTime: string; endTime: string; workingHours: number; weeklyOffDays: number[]; color: string; isActive: boolean }
interface Holiday { id: string; name: string; date: string; type: "national" | "regional" | "company"; isRecurring: boolean }
interface Settings {
  pfEmployeePct: number;
  pfEmployerPct: number;
  pfWageCeiling: number | string;
  esiEmployeePct: number;
  esiEmployerPct: number;
  esiGrossCeiling: number | string;
  ptSlabs: { upTo: number | null; amount: number }[];
  fullDayHours: number;
  halfDayHours: number;
  clPerMonth: number;
  clMaxConsecutive: number;
  slPerMonth: number;
  compOffValidityDays: number;
  reviewBelowScore: number;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Tab = "departments" | "shifts" | "holidays" | "rates" | "policy";

export function PayrollSettingsPage() {
  const [tab, setTab] = useState<Tab>("departments");
  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Payroll settings" sub="Masters and policy. Changing a rate or a slab affects only runs processed after the change." />
      <PillTabs
        tabs={[
          { key: "departments", label: "Departments & designations" },
          { key: "shifts", label: "Shifts" },
          { key: "holidays", label: "Holidays" },
          { key: "rates", label: "Wage rate card" },
          { key: "policy", label: "Statutory & policy" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "departments" && <DepartmentsTab />}
      {tab === "shifts" && <ShiftsTab />}
      {tab === "holidays" && <HolidaysTab />}
      {tab === "rates" && <RatesTab />}
      {tab === "policy" && <PolicyTab />}
    </div>
  );
}

/* ── Departments & designations ────────────────────────────────────────── */
function DepartmentsTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const listQ = useQuery({ queryKey: ["payroll", "departments"], queryFn: () => api<Department[]>("/api/payroll/departments") });
  const [newDept, setNewDept] = useState("");
  const [newDesig, setNewDesig] = useState<Record<string, string>>({});

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "departments"] });
  const addDept = useMutation({
    mutationFn: () => api("/api/payroll/departments", { method: "POST", body: { name: newDept.trim() } }),
    onSuccess: () => { invalidate(); setNewDept(""); },
    onError: fail,
  });
  const patchDept = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/api/payroll/departments/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
    onError: fail,
  });
  const addDesig = useMutation({
    mutationFn: (deptId: string) => api(`/api/payroll/departments/${deptId}/designations`, { method: "POST", body: { name: (newDesig[deptId] ?? "").trim() } }),
    onSuccess: (_d, deptId) => { invalidate(); setNewDesig((s) => ({ ...s, [deptId]: "" })); },
    onError: fail,
  });
  const patchDesig = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/api/payroll/designations/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
    onError: fail,
  });

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex items-end gap-2">
        <Field label="New department">
          <input className="input w-64" value={newDept} onChange={(e) => setNewDept(e.target.value)} />
        </Field>
        <button className="btn-primary" disabled={!newDept.trim() || addDept.isPending} onClick={() => addDept.mutate()}>
          <Plus size={14} /> Add
        </button>
      </div>
      {listQ.isLoading ? (
        <Spinner />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {(listQ.data ?? []).map((d) => (
            <div key={d.id} className={`card p-4 ${d.isActive ? "" : "opacity-60"}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[14px] font-semibold">{d.name} {!d.isActive && <Badge tone="gray">inactive</Badge>}</span>
                <button className="btn-ghost" onClick={() => patchDept.mutate({ id: d.id, body: { isActive: !d.isActive } })}>
                  {d.isActive ? "Deactivate" : "Activate"}
                </button>
              </div>
              <div className="space-y-1">
                {d.designations.sort((a, b) => a.displayOrder - b.displayOrder).map((g) => (
                  <div key={g.id} className="flex items-center justify-between text-[13px]">
                    <span className={g.isActive ? "" : "text-gray-400 line-through"}>{g.name}</span>
                    <button className="btn-ghost !py-0.5" onClick={() => patchDesig.mutate({ id: g.id, body: { isActive: !g.isActive } })}>
                      {g.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                ))}
                {!d.designations.length && <div className="text-[12px] text-gray-400">No designations.</div>}
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  className="input flex-1"
                  placeholder="New designation"
                  value={newDesig[d.id] ?? ""}
                  onChange={(e) => setNewDesig((s) => ({ ...s, [d.id]: e.target.value }))}
                />
                <button className="btn-secondary" disabled={!(newDesig[d.id] ?? "").trim() || addDesig.isPending} onClick={() => addDesig.mutate(d.id)}>
                  Add
                </button>
              </div>
            </div>
          ))}
          {!listQ.data?.length && <Empty>No departments yet.</Empty>}
        </div>
      )}
    </div>
  );
}

/* ── Shifts ────────────────────────────────────────────────────────────── */
function ShiftsTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const listQ = useQuery({ queryKey: ["payroll", "shifts"], queryFn: () => api<Shift[]>("/api/payroll/shifts") });
  const [editing, setEditing] = useState<Shift | "new" | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "shifts"] });
  const patchM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/api/payroll/shifts/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
    onError: fail,
  });

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-2 flex justify-end">
        <button className="btn-primary" onClick={() => setEditing("new")}><Plus size={14} /> New shift</button>
      </div>
      <div className="table-surface">
        {listQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Shift</Th><Th>Hours</Th><Th right>Working h</Th><Th>Weekly off</Th><Th /></tr>
            </thead>
            <tbody>
              {(listQ.data ?? []).map((s) => (
                <tr key={s.id} className={`table-row ${s.isActive ? "" : "opacity-50"}`}>
                  <Td>
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                      {s.name} {!s.isActive && <Badge tone="gray">inactive</Badge>}
                    </span>
                  </Td>
                  <Td className="tabular-nums">{s.startTime}–{s.endTime}</Td>
                  <Td right>{num(s.workingHours, 1)}</Td>
                  <Td>{s.weeklyOffDays.map((d) => DOW[d]).join(", ") || "none"}</Td>
                  <Td right>
                    <span className="flex justify-end gap-1">
                      <button className="btn-ghost" onClick={() => setEditing(s)}>Edit</button>
                      <button className="btn-ghost" onClick={() => patchM.mutate({ id: s.id, body: { isActive: !s.isActive } })}>
                        {s.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </span>
                  </Td>
                </tr>
              ))}
              {!listQ.data?.length && <tr><Td colSpan={5}><Empty>No shifts — every day resolves without a weekly off.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {editing && <ShiftDialog shift={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
    </div>
  );
}

function ShiftDialog({ shift, onClose, onSaved }: { shift: Shift | null; onClose: () => void; onSaved: () => void }) {
  const { err, setErr, fail } = useErr();
  const [form, setForm] = useState({
    name: shift?.name ?? "",
    startTime: shift?.startTime ?? "09:00",
    endTime: shift?.endTime ?? "18:00",
    workingHours: String(shift?.workingHours ?? 8),
    weeklyOffDays: shift?.weeklyOffDays ?? [0],
    color: shift?.color ?? "#3B82F6",
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, workingHours: Number(form.workingHours) || 8, name: form.name.trim() };
      return shift
        ? api(`/api/payroll/shifts/${shift.id}`, { method: "PATCH", body })
        : api("/api/payroll/shifts", { method: "POST", body });
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError: fail,
  });
  const toggleDay = (d: number) =>
    setForm((f) => ({
      ...f,
      weeklyOffDays: f.weeklyOffDays.includes(d) ? f.weeklyOffDays.filter((x) => x !== d) : [...f.weeklyOffDays, d].sort(),
    }));

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{shift ? `Edit ${shift.name}` : "New shift"}</DialogTitle></DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        <div className="space-y-2">
          <Field label="Name" required><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Start"><input type="time" className="input" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></Field>
            <Field label="End"><input type="time" className="input" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></Field>
            <Field label="Working h"><input type="number" step="0.5" className="input tabular-nums" value={form.workingHours} onChange={(e) => setForm({ ...form, workingHours: e.target.value })} /></Field>
          </div>
          <Field label="Weekly off days">
            <div className="flex gap-1">
              {DOW.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(i)}
                  className={`rounded px-2 py-1 text-[12px] font-medium ${form.weeklyOffDays.includes(i) ? "bg-brand-500 text-white" : "bg-gray-100 text-gray-600"}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Colour">
            <input type="color" className="h-8 w-16 cursor-pointer rounded border border-gray-200" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || !form.name.trim()} onClick={() => save.mutate()}>
            {shift ? "Save" : "Create"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Holidays ──────────────────────────────────────────────────────────── */
function HolidaysTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const [year, setYear] = useState(Number(istToday().slice(0, 4)));
  const listQ = useQuery({ queryKey: ["payroll", "holidays", year], queryFn: () => api<Holiday[]>(`/api/payroll/holidays?year=${year}`) });
  const [form, setForm] = useState({ name: "", date: "", type: "company" as Holiday["type"], isRecurring: false });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "holidays"] });
  const addM = useMutation({
    mutationFn: () => api("/api/payroll/holidays", { method: "POST", body: { ...form, name: form.name.trim() } }),
    onSuccess: () => { invalidate(); setForm({ name: "", date: "", type: "company", isRecurring: false }); },
    onError: fail,
  });
  const delM = useMutation({
    mutationFn: (id: string) => api(`/api/payroll/holidays/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: fail,
  });

  const rows = [...(listQ.data ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Year">
          <input type="number" className="input w-24 tabular-nums" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} />
        </Field>
        <Field label="Name"><input className="input w-52" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Date"><input type="date" className="input" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Type">
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Holiday["type"] })}>
            <option value="national">National</option>
            <option value="regional">Regional</option>
            <option value="company">Company</option>
          </select>
        </Field>
        <label className="flex h-8 items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={form.isRecurring} onChange={(e) => setForm({ ...form, isRecurring: e.target.checked })} /> Every year
        </label>
        <button className="btn-primary" disabled={addM.isPending || !form.name.trim() || !form.date} onClick={() => addM.mutate()}>
          <Plus size={14} /> Add
        </button>
      </div>
      <div className="table-surface">
        {listQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head"><tr><Th>Date</Th><Th>Holiday</Th><Th>Type</Th><Th>Recurring</Th><Th /></tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id} className="table-row">
                  <Td className="tabular-nums">{dmy(h.date)}</Td>
                  <Td className="font-medium">{h.name}</Td>
                  <Td className="capitalize">{h.type}</Td>
                  <Td>{h.isRecurring ? <Badge tone="blue">yearly</Badge> : "—"}</Td>
                  <Td right><button className="btn-ghost text-red-600" onClick={() => delM.mutate(h.id)}>Delete</button></Td>
                </tr>
              ))}
              {!rows.length && <tr><Td colSpan={5}><Empty>No holidays in {year}.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <p className="mt-2 text-[12px] text-gray-400">Punching in on a holiday makes the day present and comp-off eligible.</p>
    </div>
  );
}

/* ── Wage rate card ────────────────────────────────────────────────────── */
function RatesTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const listQ = useQuery({ queryKey: ["payroll", "wage-roles"], queryFn: () => api<WageRole[]>("/api/payroll/wage-roles") });
  const [form, setForm] = useState({ name: "", dailyRate: "" });
  const [editRate, setEditRate] = useState<Record<string, string>>({});

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "wage-roles"] });
  const addM = useMutation({
    mutationFn: () => api("/api/payroll/wage-roles", { method: "POST", body: { name: form.name.trim(), dailyRate: Number(form.dailyRate) } }),
    onSuccess: () => { invalidate(); setForm({ name: "", dailyRate: "" }); },
    onError: fail,
  });
  const patchM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/api/payroll/wage-roles/${id}`, { method: "PATCH", body }),
    onSuccess: () => { invalidate(); setEditRate({}); },
    onError: fail,
  });

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Role"><input className="input w-56" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Loader" /></Field>
        <Field label="Daily rate"><input type="number" className="input w-32 tabular-nums" value={form.dailyRate} onChange={(e) => setForm({ ...form, dailyRate: e.target.value })} /></Field>
        <button className="btn-primary" disabled={addM.isPending || !form.name.trim() || !(Number(form.dailyRate) > 0)} onClick={() => addM.mutate()}>
          <Plus size={14} /> Add role
        </button>
      </div>
      <div className="table-surface">
        {listQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head"><tr><Th>Role</Th><Th right>Daily rate</Th><Th right>Headcount</Th><Th /></tr></thead>
            <tbody>
              {(listQ.data ?? []).map((r) => (
                <tr key={r.id} className={`table-row ${r.isActive ? "" : "opacity-50"}`}>
                  <Td className="font-medium">{r.name} {!r.isActive && <Badge tone="gray">inactive</Badge>}</Td>
                  <Td right>
                    {editRate[r.id] !== undefined ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          type="number"
                          className="input w-24 tabular-nums"
                          value={editRate[r.id]}
                          onChange={(e) => setEditRate((s) => ({ ...s, [r.id]: e.target.value }))}
                          autoFocus
                        />
                        <button className="btn-secondary" onClick={() => patchM.mutate({ id: r.id, body: { dailyRate: Number(editRate[r.id]) } })}>Save</button>
                      </span>
                    ) : (
                      <button className="hover:underline" onClick={() => setEditRate({ [r.id]: String(Number(r.dailyRate)) })}>
                        {formatMoney(r.dailyRate)}
                      </button>
                    )}
                  </Td>
                  <Td right>{r.headcount ?? "—"}</Td>
                  <Td right>
                    <button className="btn-ghost" onClick={() => patchM.mutate({ id: r.id, body: { isActive: !r.isActive } })}>
                      {r.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </Td>
                </tr>
              ))}
              {!listQ.data?.length && <tr><Td colSpan={4}><Empty>No wage roles — daily-wage workers cannot be paid without one.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <p className="mt-2 text-[12px] text-gray-400">A rate change applies from the next processed run; confirmed runs keep the rate they paid.</p>
    </div>
  );
}

/* ── Statutory & policy ────────────────────────────────────────────────── */
function PolicyTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const setQ = useQuery({ queryKey: ["payroll", "settings"], queryFn: () => api<Settings>("/api/payroll/settings") });
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => {
    if (setQ.data && !form) setForm(setQ.data);
  }, [setQ.data, form]);

  const save = useMutation({
    mutationFn: () => api("/api/payroll/settings", { method: "PATCH", body: { ...form, pfWageCeiling: Number(form!.pfWageCeiling), esiGrossCeiling: Number(form!.esiGrossCeiling) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll", "settings"] }); },
    onError: fail,
  });

  if (setQ.isLoading || !form) return <Spinner />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f!, [k]: v }));
  const numInput = (k: keyof Settings, step = "0.01") => (
    <input
      type="number"
      step={step}
      className="input tabular-nums"
      value={String(form[k] ?? "")}
      onChange={(e) => set(k, Number(e.target.value) as never)}
    />
  );

  return (
    <div className="max-w-3xl">
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 text-[13px] font-semibold uppercase text-gray-400">Provident fund</h3>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Employee %">{numInput("pfEmployeePct")}</Field>
            <Field label="Employer %">{numInput("pfEmployerPct")}</Field>
            <Field label="Wage ceiling">{numInput("pfWageCeiling", "1")}</Field>
          </div>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-[13px] font-semibold uppercase text-gray-400">ESI</h3>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Employee %">{numInput("esiEmployeePct")}</Field>
            <Field label="Employer %">{numInput("esiEmployerPct")}</Field>
            <Field label="Gross ceiling">{numInput("esiGrossCeiling", "1")}</Field>
          </div>
        </div>
        <div className="card p-4 md:col-span-2">
          <h3 className="mb-2 text-[13px] font-semibold uppercase text-gray-400">Professional tax slabs</h3>
          <div className="space-y-1.5">
            {form.ptSlabs.map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-[13px]">
                <span className="text-gray-500">Gross up to</span>
                <input
                  type="number"
                  className="input w-32 tabular-nums"
                  placeholder="no limit"
                  value={s.upTo ?? ""}
                  onChange={(e) => {
                    const slabs = [...form.ptSlabs];
                    slabs[i] = { ...s, upTo: e.target.value === "" ? null : Number(e.target.value) };
                    set("ptSlabs", slabs);
                  }}
                />
                <span className="text-gray-500">→ PT</span>
                <input
                  type="number"
                  className="input w-24 tabular-nums"
                  value={s.amount}
                  onChange={(e) => {
                    const slabs = [...form.ptSlabs];
                    slabs[i] = { ...s, amount: Number(e.target.value) || 0 };
                    set("ptSlabs", slabs);
                  }}
                />
                <button className="btn-ghost text-red-600" onClick={() => set("ptSlabs", form.ptSlabs.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <button className="btn-secondary" onClick={() => set("ptSlabs", [...form.ptSlabs, { upTo: null, amount: 0 }])}>
              <Plus size={13} /> Add slab
            </button>
            <p className="text-[11px] text-gray-400">First slab whose "up to" covers the gross wins; empty "up to" means open-ended.</p>
          </div>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-[13px] font-semibold uppercase text-gray-400">Working day</h3>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Full day hours">{numInput("fullDayHours", "0.5")}</Field>
            <Field label="Half day hours">{numInput("halfDayHours", "0.5")}</Field>
          </div>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-[13px] font-semibold uppercase text-gray-400">Leave accrual</h3>
          <div className="grid grid-cols-2 gap-2">
            <Field label="CL per month">{numInput("clPerMonth", "0.5")}</Field>
            <Field label="CL max consecutive">{numInput("clMaxConsecutive", "1")}</Field>
            <Field label="SL per month">{numInput("slPerMonth", "0.5")}</Field>
            <Field label="Comp-off validity (days)">{numInput("compOffValidityDays", "1")}</Field>
          </div>
        </div>
        <div className="card p-4 md:col-span-2">
          <h3 className="mb-2 text-[13px] font-semibold uppercase text-gray-400">Gate review</h3>
          <div className="grid grid-cols-2 gap-2 md:w-1/2">
            <Field label="Keep punch photo below score" hint="Face matches under this score keep their photo for review">
              {numInput("reviewBelowScore")}
            </Field>
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save policy"}
        </button>
        {save.isSuccess && !save.isPending && <span className="text-[12px] text-emerald-600">Saved.</span>}
      </div>
    </div>
  );
}
