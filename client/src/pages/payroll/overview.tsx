/**
 * Payroll overview — the HR desk's one screen: who is in today, where this
 * month's run stands, what is waiting for a decision, and what is coming up.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, formatMoney } from "../../api";
import {
  Avatar, Badge, Empty, MONTHS, PageHeader, Spinner, Td, Th, dmy, fmtTime, istToday, num, statusTone, useEmployees,
} from "../../components/payroll/ui";

interface Today {
  present: { id: string; empCode: string; name: string; department?: string | null; firstIn?: string | null; photoUrl?: string | null }[];
  insideNow: { id: string; empCode: string; name: string; department?: string | null; since?: string | null; punchedAt?: string | null }[];
  absent: { id: string; empCode: string; name: string; department?: string | null }[];
  counts: { present: number; insideNow: number; absent: number; total: number; onLeave?: number };
}
interface Run { id: string; month: number; year: number; status: "draft" | "confirmed"; employeeCount: number; totalNet: number; totalGross: number; journalEntryNumber?: string | null }
interface Leave { id: string; employeeName?: string; employee?: { name: string }; leaveType: string; fromDate: string; toDate: string; days: number; status: string }
interface PayInput { id: string; employeeName?: string; employee?: { name: string }; kind: string; amount: number | string; status: string }
interface OpenPunch { id: string; employeeId: string; employeeName?: string; name?: string; empCode?: string; punchDate: string; punchedAt: string }
interface Holiday { id: string; name: string; date: string; type: string; isRecurring: boolean }

const empName = (r: { employeeName?: string; employee?: { name: string }; name?: string }) => r.employeeName ?? r.employee?.name ?? r.name ?? "—";

function Tile({ label, value, sub, href, tone }: { label: string; value: string; sub?: string; href?: string; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : "";
  const body = (
    <div className="rounded-lg bg-white px-4 py-3 shadow-sm transition hover:bg-gray-50">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function PayrollOverviewPage() {
  const today = istToday();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  const todayQ = useQuery({ queryKey: ["payroll", "attendance-today"], queryFn: () => api<Today>("/api/payroll/attendance/today"), refetchInterval: 60_000 });
  const runsQ = useQuery({ queryKey: ["payroll", "runs"], queryFn: () => api<Run[]>("/api/payroll/runs") });
  const leaveQ = useQuery({ queryKey: ["payroll", "leave", "pending"], queryFn: () => api<Leave[]>("/api/payroll/leave?status=pending") });
  const inputsQ = useQuery({ queryKey: ["payroll", "pay-inputs", "pending"], queryFn: () => api<PayInput[]>("/api/payroll/pay-inputs?status=pending") });
  const openQ = useQuery({ queryKey: ["payroll", "punches-open"], queryFn: () => api<OpenPunch[] | { rows: OpenPunch[] }>("/api/payroll/punches/open"), select: (d) => (Array.isArray(d) ? d : d.rows) });
  const holQ = useQuery({ queryKey: ["payroll", "holidays", year], queryFn: () => api<Holiday[]>(`/api/payroll/holidays?year=${year}`) });
  const empQ = useEmployees();

  const t = todayQ.data;
  const thisRun = runsQ.data?.find((r) => r.year === year && r.month === month);
  const upcoming = (holQ.data ?? []).filter((h) => h.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);

  const byDept = (() => {
    const m = new Map<string, { total: number; present: number }>();
    for (const e of empQ.data ?? []) {
      const k = e.department ?? "Unassigned";
      const v = m.get(k) ?? { total: 0, present: 0 };
      v.total += 1;
      m.set(k, v);
    }
    const presentIds = new Set((t?.present ?? []).map((p) => p.id));
    for (const e of empQ.data ?? []) {
      if (presentIds.has(e.id)) m.get(e.department ?? "Unassigned")!.present += 1;
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  })();

  const pendingLeave = leaveQ.data ?? [];
  const pendingInputs = inputsQ.data ?? [];
  const open = openQ.data ?? [];

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Payroll" sub={`Today, ${dmy(today)} · ${empQ.data?.length ?? 0} active employees`} />

      {todayQ.isLoading ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
          <Tile label="Present today" value={num(t?.counts.present ?? 0)} sub={`of ${t?.counts.total ?? 0}`} tone="good" href="/payroll/time" />
          <Tile label="Inside now" value={num(t?.counts.insideNow ?? 0)} href="/payroll/gate" />
          <Tile label="Absent" value={num(t?.counts.absent ?? 0)} tone={(t?.counts.absent ?? 0) > 0 ? "bad" : undefined} href="/payroll/time" />
          <Tile label="Open punches" value={num(open.length)} tone={open.length ? "warn" : undefined} sub="no out recorded" href="/payroll/time" />
          <Tile label="Leave pending" value={num(pendingLeave.length)} tone={pendingLeave.length ? "warn" : undefined} href="/payroll/time" />
          <Tile label="Pay inputs pending" value={num(pendingInputs.length)} tone={pendingInputs.length ? "warn" : undefined} href="/payroll/pay-inputs" />
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* This month's run */}
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">
              {MONTHS[month - 1]} {year} run
            </h2>
            <Link href="/payroll/run" className="text-[12px] text-brand-600 hover:underline">Open</Link>
          </div>
          {thisRun ? (
            <div className="space-y-1 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-gray-500">Status</span>
                <Badge tone={statusTone(thisRun.status)}>{thisRun.status}</Badge>
              </div>
              <div className="flex justify-between"><span className="text-gray-500">Employees</span><span className="tabular-nums">{thisRun.employeeCount}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Gross</span><span className="tabular-nums">{formatMoney(thisRun.totalGross)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Net</span><span className="font-semibold tabular-nums">{formatMoney(thisRun.totalNet)}</span></div>
              {thisRun.journalEntryNumber && (
                <div className="flex justify-between"><span className="text-gray-500">Journal</span><span>{thisRun.journalEntryNumber}</span></div>
              )}
            </div>
          ) : (
            <div className="text-[13px] text-gray-400">Not processed yet.</div>
          )}
        </div>

        {/* Headcount by department */}
        <div className="card p-4">
          <h2 className="mb-2 text-[14px] font-semibold">Headcount by department</h2>
          <div className="space-y-1.5">
            {byDept.map(([dept, v]) => (
              <div key={dept} className="flex items-center gap-2 text-xs">
                <span className="w-28 truncate text-gray-600">{dept}</span>
                <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                  <div className="h-full bg-brand-500" style={{ width: `${v.total ? (v.present / v.total) * 100 : 0}%` }} />
                </div>
                <span className="w-14 text-right tabular-nums">
                  {v.present}/{v.total}
                </span>
              </div>
            ))}
            {!byDept.length && <div className="text-xs text-gray-400">No employees yet.</div>}
          </div>
        </div>

        {/* Upcoming holidays */}
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Upcoming holidays</h2>
            <Link href="/payroll/settings" className="text-[12px] text-brand-600 hover:underline">Manage</Link>
          </div>
          {upcoming.length ? (
            <div className="space-y-1 text-[13px]">
              {upcoming.map((h) => (
                <div key={h.id} className="flex justify-between">
                  <span>{h.name}</span>
                  <span className="tabular-nums text-gray-500">{dmy(h.date)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-gray-400">None left this year.</div>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Inside now */}
        <div className="table-surface">
          <div className="flex items-center justify-between px-3 py-2">
            <h2 className="text-[13px] font-semibold">Inside now</h2>
            <span className="text-[12px] text-gray-500">{t?.insideNow.length ?? 0}</span>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full">
              <thead className="table-head"><tr><Th>Employee</Th><Th>Department</Th><Th right>In since</Th></tr></thead>
              <tbody>
                {(t?.insideNow ?? []).map((p) => (
                  <tr key={p.id} className="table-row">
                    <Td><span className="flex items-center gap-2"><Avatar name={p.name} size="sm" /> {p.name} <span className="text-gray-400">{p.empCode}</span></span></Td>
                    <Td>{p.department ?? "—"}</Td>
                    <Td right>{fmtTime(p.since ?? p.punchedAt)}</Td>
                  </tr>
                ))}
                {!t?.insideNow.length && <tr><Td colSpan={3}><Empty>Nobody inside.</Empty></Td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pending decisions */}
        <div className="table-surface">
          <div className="flex items-center justify-between px-3 py-2">
            <h2 className="text-[13px] font-semibold">Waiting for a decision</h2>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full">
              <thead className="table-head"><tr><Th>What</Th><Th>Employee</Th><Th>Detail</Th><Th right>Amount / days</Th></tr></thead>
              <tbody>
                {pendingLeave.map((l) => (
                  <tr key={l.id} className="table-row">
                    <Td><Badge tone="blue">Leave</Badge></Td>
                    <Td>{empName(l)}</Td>
                    <Td>{l.leaveType} · {dmy(l.fromDate)} – {dmy(l.toDate)}</Td>
                    <Td right>{l.days}</Td>
                  </tr>
                ))}
                {pendingInputs.map((p) => (
                  <tr key={p.id} className="table-row">
                    <Td><Badge tone="amber">{p.kind}</Badge></Td>
                    <Td>{empName(p)}</Td>
                    <Td className="capitalize">{p.kind}</Td>
                    <Td right>{formatMoney(p.amount)}</Td>
                  </tr>
                ))}
                {open.map((o) => (
                  <tr key={o.id} className="table-row">
                    <Td><Badge tone="red">Open punch</Badge></Td>
                    <Td>{o.employeeName ?? o.name ?? o.empCode ?? "—"}</Td>
                    <Td>In {dmy(o.punchDate)} {fmtTime(o.punchedAt)}, no out</Td>
                    <Td right>—</Td>
                  </tr>
                ))}
                {!pendingLeave.length && !pendingInputs.length && !open.length && (
                  <tr><Td colSpan={4}><Empty>Nothing pending.</Empty></Td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
