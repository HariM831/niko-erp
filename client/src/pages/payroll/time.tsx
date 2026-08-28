/**
 * Time — attendance in five tabs.
 *
 *   Calendar   one employee × one month, day cells with punches, click → override
 *   Team grid  every employee × every day, bulk override
 *   Leave      apply / approve, with the balance beside the decision
 *   Exceptions dangling `in` punches → insert the missing out or set the day
 *   Roster     current shift assignments
 *
 * The day statuses come from the server's resolver (punch > holiday > leave >
 * weekly off > absent); a manual override survives recomputes and is removed
 * with the × on the override dialog.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ALL_STATUSES, AttStatus, Avatar, Badge, Empty, EmployeeSelect, ErrorBanner, Field, MonthPicker, PageHeader, Pager, PillTabs,
  STATUS_LABEL, Spinner, StatusChip, StatusLegend, Td, Th, daysInMonth, dmy, fmtDateTime, fmtTime, istToday, num, pad2,
  statusTone, useEmployees, useErr, useMonth, usePaged, ymd,
} from "../../components/payroll/ui";

/* ── shared types ──────────────────────────────────────────────────────── */
interface DayCell { status: AttStatus; source: string; hours: number }
interface Totals { P: number; H: number; A: number; WO: number; HO: number; L: number; paid: number; lop: number }
interface Punch { id: string; type: "in" | "out"; punchedAt: string; method: string; matchScore: number | null; photoUrl: string | null; location: string | null }
interface EmployeeMonth {
  days: Record<string, DayCell & { punches: Punch[] }>;
  totals: Totals;
  shift: { id: string; name: string; startTime: string; endTime: string; weeklyOffDays: number[] } | null;
  leaves: { id: string; leaveType: string; fromDate: string; toDate: string; status: string }[];
}
interface MonthGrid {
  days: number[];
  employees: { id: string; empCode: string; name: string; department: string | null; days: Record<string, DayCell>; totals: Totals }[];
}
interface Leave {
  id: string; employeeId: string; name?: string; empCode?: string;
  leaveType: "CL" | "SL" | "CompOff"; fromDate: string; toDate: string; days: number; reason: string;
  status: string; compOffWorkDate: string | null; remarks: string | null; appliedAt: string;
}
interface Balance {
  CL: { earned: number; used: number; balance: number };
  SL: { earned: number; used: number; balance: number };
  CompOff: { earned: number; used: number; balance: number; expiring: { workDate: string; expiresOn: string }[] };
}
interface OpenPunch { id: string; employeeId: string; name?: string; empCode?: string; punchDate: string; punchedAt: string }
interface Assignment { id: string; employeeId: string; name?: string; empCode?: string; shiftId: string; shiftName?: string; shift?: { name: string }; effectiveFrom: string; effectiveTo: string | null }
interface Shift { id: string; name: string; startTime: string; endTime: string; weeklyOffDays: number[]; isActive: boolean; color: string }

const leaveName = (l: Leave) => l.name ?? "—";

type Tab = "calendar" | "grid" | "leave" | "exceptions" | "roster";

export function PayrollTimePage() {
  const [tab, setTab] = useState<Tab>("calendar");
  const openQ = useQuery({
    queryKey: ["payroll", "punches-open"],
    queryFn: () => api<OpenPunch[] | { rows: OpenPunch[] }>("/api/payroll/punches/open"),
    select: (d) => (Array.isArray(d) ? d : d.rows),
  });
  const pendingLeaveQ = useQuery({ queryKey: ["payroll", "leave", "pending"], queryFn: () => api<Leave[]>("/api/payroll/leave?status=pending") });

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Time" sub="Attendance, leave and shifts — resolved as punch > holiday > leave > weekly off > absent." />
      <PillTabs
        tabs={[
          { key: "calendar", label: "Calendar" },
          { key: "grid", label: "Team grid" },
          { key: "leave", label: "Leave", count: pendingLeaveQ.data?.length },
          { key: "exceptions", label: "Exceptions", count: openQ.data?.length },
          { key: "roster", label: "Roster" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "calendar" && <CalendarTab />}
      {tab === "grid" && <TeamGridTab />}
      {tab === "leave" && <LeaveTab />}
      {tab === "exceptions" && <ExceptionsTab />}
      {tab === "roster" && <RosterTab />}
    </div>
  );
}

/* ── Calendar ──────────────────────────────────────────────────────────── */
function CalendarTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const { year, month, setYear, setMonth } = useMonth();
  const empQ = useEmployees();
  const [employeeId, setEmployeeId] = useState("");
  const eff = employeeId || empQ.data?.[0]?.id || "";
  const [dayOpen, setDayOpen] = useState<number | null>(null);

  const calQ = useQuery({
    queryKey: ["payroll", "att-employee", eff, year, month],
    queryFn: () => api<EmployeeMonth>(`/api/payroll/attendance/employee/${eff}?year=${year}&month=${month}`),
    enabled: !!eff,
  });

  const recompute = useMutation({
    mutationFn: () => api("/api/payroll/attendance/recompute", { method: "POST", body: { year, month, employeeId: eff } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payroll", "att-employee"] }),
    onError: fail,
  });

  const total = daysInMonth(year, month);
  const firstDow = new Date(year, month - 1, 1).getDay();
  const today = istToday();
  const t = calQ.data?.totals;
  const emp = empQ.data?.find((e) => e.id === eff);

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <EmployeeSelect value={eff} onChange={setEmployeeId} className="w-64" placeholder="Employee" />
        <MonthPicker year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m); }} />
        <button className="btn-ghost" onClick={() => recompute.mutate()} disabled={recompute.isPending} title="Recompute the month from punches">
          <RefreshCw size={13} className={recompute.isPending ? "animate-spin" : ""} /> Recompute
        </button>
        <div className="ml-auto"><StatusLegend /></div>
      </div>

      {calQ.isLoading ? (
        <Spinner />
      ) : (
        <>
          {t && (
            <div className="mb-3 flex flex-wrap gap-4 text-[13px] tabular-nums">
              {(["P", "H", "A", "WO", "HO", "L"] as const).map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5">
                  <StatusChip status={k} small /> {num(t[k], 1)}
                </span>
              ))}
              <span className="font-semibold">Paid {num(t.paid, 1)}</span>
              <span className="text-red-600">LOP {num(t.lop, 1)}</span>
              {calQ.data?.shift && <span className="text-gray-500">Shift: {calQ.data.shift.name} ({calQ.data.shift.startTime}–{calQ.data.shift.endTime})</span>}
            </div>
          )}
          <div className="table-surface p-3">
            <div className="grid grid-cols-7 gap-1">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="py-1 text-center text-[11px] font-semibold uppercase text-gray-400">{d}</div>
              ))}
              {Array.from({ length: firstDow }).map((_, i) => <div key={`b${i}`} />)}
              {Array.from({ length: total }).map((_, i) => {
                const d = i + 1;
                const cell = calQ.data?.days[String(d)];
                const iso = ymd(year, month, d);
                const isToday = iso === today;
                const future = iso > today;
                return (
                  <button
                    key={d}
                    onClick={() => !future && setDayOpen(d)}
                    disabled={future}
                    className={`min-h-[64px] rounded-md border p-1.5 text-left transition ${
                      isToday ? "border-brand-400 ring-1 ring-brand-100" : "border-gray-100"
                    } ${future ? "opacity-40" : "hover:bg-gray-50"}`}
                  >
                    <div className="flex items-start justify-between">
                      <span className="text-[12px] font-medium tabular-nums text-gray-600">{d}</span>
                      {cell && <StatusChip status={cell.status} small />}
                    </div>
                    {cell && cell.punches?.length > 0 && (
                      <div className="mt-1 text-[10px] tabular-nums text-gray-500">
                        {fmtTime(cell.punches[0]!.punchedAt)}
                        {cell.punches.length > 1 && <> – {fmtTime(cell.punches[cell.punches.length - 1]!.punchedAt)}</>}
                      </div>
                    )}
                    {cell && cell.hours > 0 && <div className="text-[10px] tabular-nums text-gray-400">{num(cell.hours, 1)} h</div>}
                    {cell?.source === "manual" && <div className="text-[9px] font-medium uppercase text-amber-600">manual</div>}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {dayOpen != null && eff && (
        <DayDialog
          employeeId={eff}
          employeeName={emp?.name ?? ""}
          day={ymd(year, month, dayOpen)}
          cell={calQ.data?.days[String(dayOpen)] ?? null}
          onClose={() => setDayOpen(null)}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ["payroll", "att-employee"] });
            qc.invalidateQueries({ queryKey: ["payroll", "att-month"] });
          }}
        />
      )}
    </div>
  );
}

function DayDialog({ employeeId, employeeName, day, cell, onClose, onChanged }: {
  employeeId: string;
  employeeName: string;
  day: string;
  cell: (DayCell & { punches: Punch[] }) | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { err, setErr, fail } = useErr();
  const [status, setStatus] = useState<AttStatus>(cell?.status ?? "P");
  const [note, setNote] = useState("");

  const override = useMutation({
    mutationFn: () => api("/api/payroll/attendance/override", { method: "POST", body: { employeeId, day, status, note } }),
    onSuccess: () => { onChanged(); onClose(); },
    onError: fail,
  });
  const clear = useMutation({
    mutationFn: () => api("/api/payroll/attendance/override", { method: "DELETE", body: { employeeId, day } }),
    onSuccess: () => { onChanged(); onClose(); },
    onError: fail,
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{employeeName} · {dmy(day)}</DialogTitle></DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        {cell ? (
          <div className="mb-2 text-[13px] text-gray-600">
            Currently <StatusChip status={cell.status} small /> from <span className="font-medium">{cell.source}</span>
            {cell.hours > 0 && <> · {num(cell.hours, 1)} h worked</>}
          </div>
        ) : (
          <div className="mb-2 text-[13px] text-gray-400">No attendance row for this day yet.</div>
        )}
        {cell && cell.punches.length > 0 && (
          <div className="mb-3 space-y-1 rounded-md bg-gray-50 p-2 text-[12px]">
            {cell.punches.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <Badge tone={p.type === "in" ? "green" : "gray"}>{p.type.toUpperCase()}</Badge>
                <span className="tabular-nums">{fmtDateTime(p.punchedAt)}</span>
                <span className="text-gray-400">{p.method}{p.matchScore != null ? ` ${(p.matchScore * 100).toFixed(0)}%` : ""}</span>
                {p.photoUrl && <img src={p.photoUrl} alt="" className="ml-auto h-7 w-7 rounded object-cover" />}
              </div>
            ))}
          </div>
        )}
        <Field label="Set day to (manual override)">
          <div className="flex gap-1">
            {ALL_STATUSES.map((s) => (
              <button key={s} onClick={() => setStatus(s)} className={`rounded px-2 py-1 text-[12px] font-semibold ${status === s ? "bg-brand-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`} title={STATUS_LABEL[s]}>
                {s}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Note" className="mt-2">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the change" />
        </Field>
        <div className="mt-4 flex items-center justify-between">
          {cell?.source === "manual" ? (
            <button className="btn-ghost text-red-600" disabled={clear.isPending} onClick={() => clear.mutate()}>
              Remove override
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={override.isPending} onClick={() => override.mutate()}>Save override</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Team grid ─────────────────────────────────────────────────────────── */
function TeamGridTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const { year, month, setYear, setMonth } = useMonth();
  const [department, setDepartment] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDay, setBulkDay] = useState(istToday());
  const [bulkStatus, setBulkStatus] = useState<AttStatus>("P");
  const [bulkNote, setBulkNote] = useState("");

  const deptQ = useQuery({ queryKey: ["payroll", "departments"], queryFn: () => api<{ id: string; name: string }[]>("/api/payroll/departments") });
  const gridQ = useQuery({
    queryKey: ["payroll", "att-month", year, month, department],
    queryFn: () => api<MonthGrid>(`/api/payroll/attendance/month?year=${year}&month=${month}${department ? `&department=${encodeURIComponent(department)}` : ""}`),
  });

  const employees = useMemo(
    () => [...(gridQ.data?.employees ?? [])].sort((a, b) => a.empCode.localeCompare(b.empCode, undefined, { numeric: true })),
    [gridQ.data],
  );
  const paged = usePaged(employees);
  const days = gridQ.data?.days ?? [];
  const today = istToday();

  const bulk = useMutation({
    mutationFn: () => api("/api/payroll/attendance/bulk-override", {
      method: "POST",
      body: { day: bulkDay, status: bulkStatus, employeeIds: [...selected], note: bulkNote },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "att-month"] });
      setBulkOpen(false); setSelected(new Set()); setBulkNote("");
    },
    onError: fail,
  });

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MonthPicker year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m); }} />
        <select value={department} onChange={(e) => setDepartment(e.target.value)} className="input w-44">
          <option value="">All departments</option>
          {(deptQ.data ?? []).map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        {selected.size > 0 && (
          <button className="btn-primary" onClick={() => setBulkOpen(true)}>Set a day for {selected.size} selected</button>
        )}
        <div className="ml-auto"><StatusLegend /></div>
      </div>

      {gridQ.isLoading ? (
        <Spinner />
      ) : (
        <div className="table-surface overflow-x-auto">
          <table className="w-full">
            <thead className="table-head">
              <tr>
                <Th className="sticky left-0 z-10 bg-[#f9f9fb]">Employee</Th>
                {days.map((d) => {
                  const iso = ymd(year, month, d);
                  return (
                    <Th key={d} className={`!px-1 text-center ${iso === today ? "text-brand-600" : ""}`}>{pad2(d)}</Th>
                  );
                })}
                <Th right>P</Th>
                <Th right>H</Th>
                <Th right>A</Th>
                <Th right>Paid</Th>
              </tr>
            </thead>
            <tbody>
              {paged.page.map((e) => (
                <tr key={e.id} className="table-row">
                  <Td className="sticky left-0 z-10 whitespace-nowrap bg-white">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                      <span className="font-medium">{e.name}</span>
                      <span className="text-[11px] text-gray-400">{e.empCode}</span>
                    </label>
                  </Td>
                  {days.map((d) => (
                    <Td key={d} className="!px-0.5 text-center">
                      <StatusChip status={e.days[String(d)]?.status} small />
                    </Td>
                  ))}
                  <Td right>{num(e.totals.P, 1)}</Td>
                  <Td right>{num(e.totals.H, 1)}</Td>
                  <Td right className="text-red-600">{num(e.totals.A, 1)}</Td>
                  <Td right className="font-semibold">{num(e.totals.paid, 1)}</Td>
                </tr>
              ))}
              {!paged.page.length && <tr><Td colSpan={days.length + 5}><Empty>No employees.</Empty></Td></tr>}
            </tbody>
          </table>
          <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
        </div>
      )}

      <Dialog open={bulkOpen} onOpenChange={(v) => !v && setBulkOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Bulk override · {selected.size} employees</DialogTitle></DialogHeader>
          <Field label="Day">
            <input type="date" className="input" value={bulkDay} onChange={(e) => setBulkDay(e.target.value)} />
          </Field>
          <Field label="Status" className="mt-2">
            <div className="flex gap-1">
              {ALL_STATUSES.map((s) => (
                <button key={s} onClick={() => setBulkStatus(s)} className={`rounded px-2 py-1 text-[12px] font-semibold ${bulkStatus === s ? "bg-brand-500 text-white" : "bg-gray-100 text-gray-600"}`}>{s}</button>
              ))}
            </div>
          </Field>
          <Field label="Note" className="mt-2">
            <input className="input" value={bulkNote} onChange={(e) => setBulkNote(e.target.value)} />
          </Field>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setBulkOpen(false)}>Cancel</button>
            <button className="btn-primary" disabled={bulk.isPending} onClick={() => bulk.mutate()}>Apply</button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── Leave ─────────────────────────────────────────────────────────────── */
function LeaveTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const year = Number(istToday().slice(0, 4));
  const [status, setStatus] = useState("pending");
  const [applyOpen, setApplyOpen] = useState(false);
  const [decide, setDecide] = useState<{ leave: Leave; action: "approve" | "reject" } | null>(null);
  const [remarks, setRemarks] = useState("");

  const listQ = useQuery({
    queryKey: ["payroll", "leave", status, year],
    queryFn: () => api<Leave[]>(`/api/payroll/leave?year=${year}${status ? `&status=${status}` : ""}`),
  });
  const balQ = useQuery({
    queryKey: ["payroll", "leave-balance", decide?.leave.employeeId, year],
    queryFn: () => api<Balance>(`/api/payroll/leave/balance/${decide!.leave.employeeId}?year=${year}`),
    enabled: !!decide,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["payroll", "leave"] });
    qc.invalidateQueries({ queryKey: ["payroll", "att-month"] });
    qc.invalidateQueries({ queryKey: ["payroll", "att-employee"] });
  };
  const decideM = useMutation({
    mutationFn: ({ leave, action }: { leave: Leave; action: "approve" | "reject" }) =>
      api(`/api/payroll/leave/${leave.id}/${action}`, { method: "POST", body: { remarks } }),
    onSuccess: () => { invalidate(); setDecide(null); setRemarks(""); },
    onError: fail,
  });
  const removeM = useMutation({
    mutationFn: (id: string) => api(`/api/payroll/leave/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: fail,
  });

  const rows = listQ.data ?? [];
  const paged = usePaged(rows);

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="input w-36">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
        <button className="btn-primary ml-auto" onClick={() => setApplyOpen(true)}>Apply for leave</button>
      </div>

      <div className="table-surface overflow-x-auto">
        {listQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Employee</Th><Th>Type</Th><Th>From</Th><Th>To</Th><Th right>Days</Th><Th>Reason</Th><Th>Status</Th><Th /></tr>
            </thead>
            <tbody>
              {paged.page.map((l) => (
                <tr key={l.id} className="table-row">
                  <Td className="font-medium">{leaveName(l)}</Td>
                  <Td><Badge tone="blue">{l.leaveType}</Badge>{l.compOffWorkDate && <span className="ml-1 text-[11px] text-gray-400">worked {dmy(l.compOffWorkDate)}</span>}</Td>
                  <Td className="tabular-nums">{dmy(l.fromDate)}</Td>
                  <Td className="tabular-nums">{dmy(l.toDate)}</Td>
                  <Td right>{num(l.days, 1)}</Td>
                  <Td className="max-w-[240px] truncate" title={l.reason}>{l.reason}</Td>
                  <Td><Badge tone={statusTone(l.status)}>{l.status}</Badge>{l.remarks && <span className="ml-1 text-[11px] text-gray-400">{l.remarks}</span>}</Td>
                  <Td right>
                    {l.status === "pending" ? (
                      <span className="flex justify-end gap-1">
                        <button className="btn-ghost text-emerald-700" onClick={() => setDecide({ leave: l, action: "approve" })}>Approve</button>
                        <button className="btn-ghost text-red-600" onClick={() => setDecide({ leave: l, action: "reject" })}>Reject</button>
                      </span>
                    ) : (
                      <button className="btn-ghost text-red-600" onClick={() => removeM.mutate(l.id)}>Cancel</button>
                    )}
                  </Td>
                </tr>
              ))}
              {!paged.page.length && <tr><Td colSpan={8}><Empty>No leave applications.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>

      {applyOpen && <ApplyLeaveDialog onClose={() => setApplyOpen(false)} onSaved={invalidate} />}

      {decide && (
        <Dialog open onOpenChange={(v) => !v && setDecide(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{decide.action === "approve" ? "Approve" : "Reject"} {decide.leave.leaveType} · {leaveName(decide.leave)}</DialogTitle>
            </DialogHeader>
            <div className="text-[13px] text-gray-600">
              {dmy(decide.leave.fromDate)} – {dmy(decide.leave.toDate)} · {num(decide.leave.days, 1)} day{decide.leave.days === 1 ? "" : "s"}
            </div>
            {balQ.data && (
              <div className="mt-2 grid grid-cols-3 gap-2 rounded-md bg-gray-50 p-2 text-center text-[12px]">
                {(["CL", "SL", "CompOff"] as const).map((k) => (
                  <div key={k} className={decide.leave.leaveType === k ? "font-semibold" : ""}>
                    <div className="text-gray-400">{k}</div>
                    <div className="tabular-nums">{num(balQ.data[k].balance, 1)} left</div>
                  </div>
                ))}
              </div>
            )}
            <Field label="Remarks" className="mt-2">
              <input className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </Field>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setDecide(null)}>Cancel</button>
              <button
                className={decide.action === "approve" ? "btn-primary" : "btn-secondary text-red-600"}
                disabled={decideM.isPending}
                onClick={() => decideM.mutate(decide)}
              >
                {decide.action === "approve" ? "Approve" : "Reject"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function ApplyLeaveDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { err, setErr, fail } = useErr();
  const year = Number(istToday().slice(0, 4));
  const [form, setForm] = useState({ employeeId: "", leaveType: "CL" as Leave["leaveType"], fromDate: "", toDate: "", reason: "", compOffWorkDate: "" });
  const balQ = useQuery({
    queryKey: ["payroll", "leave-balance", form.employeeId, year],
    queryFn: () => api<Balance>(`/api/payroll/leave/balance/${form.employeeId}?year=${year}`),
    enabled: !!form.employeeId,
  });
  const days = useMemo(() => {
    if (!form.fromDate || !form.toDate) return 0;
    const a = new Date(`${form.fromDate}T00:00:00Z`).getTime();
    const b = new Date(`${form.toDate}T00:00:00Z`).getTime();
    return b < a ? 0 : Math.round((b - a) / 86400000) + 1;
  }, [form.fromDate, form.toDate]);

  const apply = useMutation({
    mutationFn: () => api("/api/payroll/leave", {
      method: "POST",
      body: {
        employeeId: form.employeeId,
        leaveType: form.leaveType,
        fromDate: form.fromDate,
        toDate: form.toDate,
        days,
        reason: form.reason,
        compOffWorkDate: form.leaveType === "CompOff" ? form.compOffWorkDate || null : null,
      },
    }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: fail,
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Apply for leave</DialogTitle></DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        <div className="space-y-2">
          <Field label="Employee" required>
            <EmployeeSelect value={form.employeeId} onChange={(v) => setForm({ ...form, employeeId: v })} />
          </Field>
          {balQ.data && (
            <div className="grid grid-cols-3 gap-2 rounded-md bg-gray-50 p-2 text-center text-[12px]">
              {(["CL", "SL", "CompOff"] as const).map((k) => (
                <div key={k}>
                  <div className="text-gray-400">{k}</div>
                  <div className="tabular-nums">{num(balQ.data[k].balance, 1)} left</div>
                </div>
              ))}
            </div>
          )}
          <Field label="Type" required>
            <select className="input" value={form.leaveType} onChange={(e) => setForm({ ...form, leaveType: e.target.value as Leave["leaveType"] })}>
              <option value="CL">Casual leave</option>
              <option value="SL">Sick leave</option>
              <option value="CompOff">Comp-off</option>
            </select>
          </Field>
          {form.leaveType === "CompOff" && (
            <Field label="Worked on (holiday / weekly off)" required hint="Must be a past day worked, within validity">
              <input type="date" className="input" value={form.compOffWorkDate} onChange={(e) => setForm({ ...form, compOffWorkDate: e.target.value })} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="From" required>
              <input type="date" className="input" value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} />
            </Field>
            <Field label="To" required>
              <input type="date" className="input" value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} />
            </Field>
          </div>
          {days > 0 && <div className="text-[12px] text-gray-500">{days} day{days === 1 ? "" : "s"}</div>}
          <Field label="Reason" required>
            <input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={apply.isPending || !form.employeeId || !form.fromDate || !form.toDate || !form.reason.trim() || days <= 0}
            onClick={() => apply.mutate()}
          >
            Apply
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Exceptions ────────────────────────────────────────────────────────── */
function ExceptionsTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const [resolving, setResolving] = useState<OpenPunch | null>(null);
  const [mode, setMode] = useState<"out" | "day">("out");
  const [outTime, setOutTime] = useState("18:00");
  const [dayStatus, setDayStatus] = useState<"P" | "H" | "A">("H");
  const [note, setNote] = useState("");

  const openQ = useQuery({
    queryKey: ["payroll", "punches-open"],
    queryFn: () => api<OpenPunch[] | { rows: OpenPunch[] }>("/api/payroll/punches/open"),
    select: (d) => (Array.isArray(d) ? d : d.rows),
  });

  const resolve = useMutation({
    mutationFn: (p: OpenPunch) =>
      api(`/api/payroll/punches/${p.id}/resolve`, {
        method: "POST",
        body: mode === "out"
          ? { outAt: new Date(`${p.punchDate}T${outTime}:00+05:30`).toISOString(), note }
          : { status: dayStatus, note },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "punches-open"] });
      qc.invalidateQueries({ queryKey: ["payroll", "att-month"] });
      qc.invalidateQueries({ queryKey: ["payroll", "att-employee"] });
      setResolving(null); setNote("");
    },
    onError: fail,
  });

  const rows = openQ.data ?? [];
  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <p className="mb-3 text-[13px] text-gray-500">
        Workers who punched in but never out. Enter the real out time, or set the day directly.
      </p>
      <div className="table-surface">
        {openQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head"><tr><Th>Employee</Th><Th>Day</Th><Th>In at</Th><Th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="table-row">
                  <Td className="font-medium">{p.name ?? p.empCode ?? "—"}</Td>
                  <Td className="tabular-nums">{dmy(p.punchDate)}</Td>
                  <Td className="tabular-nums">{fmtTime(p.punchedAt)}</Td>
                  <Td right><button className="btn-secondary" onClick={() => setResolving(p)}>Resolve</button></Td>
                </tr>
              ))}
              {!rows.length && <tr><Td colSpan={4}><Empty>No open punches. Clean sheet.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {resolving && (
        <Dialog open onOpenChange={(v) => !v && setResolving(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Resolve · {resolving.name ?? ""} {dmy(resolving.punchDate)}</DialogTitle>
            </DialogHeader>
            <div className="mb-2 flex rounded-md bg-gray-100 p-0.5 text-[13px]">
              <button className={`flex-1 rounded px-2 py-1 ${mode === "out" ? "bg-white font-medium shadow-sm" : "text-gray-500"}`} onClick={() => setMode("out")}>Insert out time</button>
              <button className={`flex-1 rounded px-2 py-1 ${mode === "day" ? "bg-white font-medium shadow-sm" : "text-gray-500"}`} onClick={() => setMode("day")}>Set the day</button>
            </div>
            {mode === "out" ? (
              <Field label="Out at (IST)">
                <input type="time" className="input" value={outTime} onChange={(e) => setOutTime(e.target.value)} />
              </Field>
            ) : (
              <Field label="Day status">
                <div className="flex gap-1">
                  {(["P", "H", "A"] as const).map((s) => (
                    <button key={s} onClick={() => setDayStatus(s)} className={`rounded px-3 py-1 text-[12px] font-semibold ${dayStatus === s ? "bg-brand-500 text-white" : "bg-gray-100 text-gray-600"}`}>{s}</button>
                  ))}
                </div>
              </Field>
            )}
            <Field label="Note" className="mt-2">
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. forgot to punch out" />
            </Field>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setResolving(null)}>Cancel</button>
              <button className="btn-primary" disabled={resolve.isPending} onClick={() => resolve.mutate(resolving)}>Save</button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/* ── Roster ────────────────────────────────────────────────────────────── */
function RosterTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const empQ = useEmployees();
  const shiftsQ = useQuery({ queryKey: ["payroll", "shifts"], queryFn: () => api<Shift[]>("/api/payroll/shifts") });
  const listQ = useQuery({
    queryKey: ["payroll", "shift-assignments", "active"],
    queryFn: () => api<Assignment[]>("/api/payroll/shift-assignments?active=1"),
  });
  const [form, setForm] = useState({ employeeId: "", shiftId: "", effectiveFrom: istToday() });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "shift-assignments"] });
  const assign = useMutation({
    mutationFn: () => api("/api/payroll/shift-assignments", { method: "POST", body: form }),
    onSuccess: () => { invalidate(); setForm({ ...form, employeeId: "" }); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/payroll/shift-assignments/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: fail,
  });

  const byEmp = new Map((listQ.data ?? []).map((a) => [a.employeeId, a]));
  const shiftById = new Map((shiftsQ.data ?? []).map((s) => [s.id, s]));
  const rows = (empQ.data ?? []).map((e) => ({ emp: e, a: byEmp.get(e.id) ?? null }));
  const paged = usePaged(rows);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Employee">
          <EmployeeSelect value={form.employeeId} onChange={(v) => setForm({ ...form, employeeId: v })} className="w-60" />
        </Field>
        <Field label="Shift">
          <select className="input w-56" value={form.shiftId} onChange={(e) => setForm({ ...form, shiftId: e.target.value })}>
            <option value="">—</option>
            {(shiftsQ.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
          </select>
        </Field>
        <Field label="From">
          <input type="date" className="input" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
        </Field>
        <button className="btn-primary" disabled={!form.employeeId || !form.shiftId || assign.isPending} onClick={() => assign.mutate()}>
          Assign
        </button>
      </div>

      <div className="table-surface">
        {listQ.isLoading || empQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head"><tr><Th>Employee</Th><Th>Shift</Th><Th>Hours</Th><Th>Weekly off</Th><Th>Since</Th><Th /></tr></thead>
            <tbody>
              {paged.page.map(({ emp, a }) => {
                const s = a ? shiftById.get(a.shiftId) : null;
                return (
                  <tr key={emp.id} className="table-row">
                    <Td>
                      <span className="flex items-center gap-2">
                        <Avatar name={emp.name} size="sm" />
                        <span className="font-medium">{emp.name}</span>
                        <span className="text-[11px] text-gray-400">{emp.empCode}</span>
                      </span>
                    </Td>
                    <Td>
                      {s ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                          {s.name}
                        </span>
                      ) : a ? (a.shiftName ?? a.shift?.name ?? "—") : <span className="text-gray-400">unassigned</span>}
                    </Td>
                    <Td className="tabular-nums">{s ? `${s.startTime}–${s.endTime}` : "—"}</Td>
                    <Td>{s ? s.weeklyOffDays.map((d) => DOW[d]).join(", ") || "none" : "—"}</Td>
                    <Td className="tabular-nums">{a ? dmy(a.effectiveFrom) : "—"}</Td>
                    <Td right>{a && <button className="btn-ghost text-red-600" onClick={() => remove.mutate(a.id)}>Remove</button>}</Td>
                  </tr>
                );
              })}
              {!paged.page.length && <tr><Td colSpan={6}><Empty>No employees.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>
    </div>
  );
}
