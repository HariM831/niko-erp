/**
 * Payroll overview — the HR desk's one screen: who is in today, how many came
 * through the gate each of the last seven days, what is waiting for a
 * decision, and what is coming up.
 */
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { Link } from "wouter";
import { api, formatMoney } from "../../api";
import {
  Avatar, Badge, Empty, MONTHS, PageHeader, Spinner, Td, Th, dmy, fmtTime, istToday, num, useEmployees,
} from "../../components/payroll/ui";

interface Today {
  present: { id: string; empCode: string; name: string; department?: string | null; firstIn?: string | null; photoUrl?: string | null }[];
  insideNow: { id: string; empCode: string; name: string; department?: string | null; since?: string | null; punchedAt?: string | null }[];
  absent: { id: string; empCode: string; name: string; department?: string | null }[];
  counts: { present: number; insideNow: number; absent: number; total: number };
}
interface DayCount { day: string; present: number; bySite: Record<string, number> }
interface GateDays { sites: string[]; days: DayCount[] }
interface Leave { id: string; name?: string; empCode?: string; leaveType: string; fromDate: string; toDate: string; days: number; status: string }
interface PayInput { id: string; name?: string; empCode?: string; kind: string; amount: number | string; status: string }
interface OpenPunch { id: string; employeeId: string; name?: string; empCode?: string; punchDate: string; punchedAt: string }
interface Holiday { id: string; name: string; date: string; type: string; isRecurring: boolean }

/** recharts types its Tooltip more tightly than this chart needs; widened once, as elsewhere. */
const Tooltip = RechartsTooltip as unknown as (props: Record<string, unknown>) => ReactElement;

/** One colour a site, in the order the sites come; a punch with no place is grey. */
const SITE_COLOURS = ["#2f80d1", "#2a9d8f", "#f39a4a", "#a77bd8", "#e0697a", "#62b86b", "#e2b93b"];
const siteColour = (site: string, i: number) => (site === "Unknown" ? "#b8c0c8" : SITE_COLOURS[i % SITE_COLOURS.length]);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Gate attendance, day by day, stacked by site: each site's count in its band, the day's total on top. */
function GateWeek({ data: src, today }: { data: GateDays; today: string }) {
  const data = src.days.map((r) => ({
    ...r,
    ...Object.fromEntries(src.sites.map((st) => [st, r.bySite[st] ?? 0])),
    label: `${r.day.slice(8, 10)} ${MONTHS[Number(r.day.slice(5, 7)) - 1]}`,
    wd: r.day === today ? "Today" : WEEKDAYS[new Date(`${r.day}T00:00:00`).getDay()],
  }));
  const total = src.days.reduce((n, r) => n + r.present, 0);
  const avg = src.days.length ? Math.round(total / src.days.length) : 0;
  const best = src.days.reduce<DayCount | null>((b, r) => (!b || r.present > b.present ? r : b), null);
  const last = src.sites.length - 1;
  const XTick = (props: Record<string, unknown>) => {
    const { x, y, payload } = props as { x: number; y: number; payload: { value: string } };
    const d = data.find((r) => r.day === payload.value);
    if (!d) return <g />;
    const isToday = d.day === today;
    return (
      <g transform={`translate(${x},${y + 4})`}>
        <text textAnchor="middle" fontSize={11} fill={isToday ? "#111827" : "#4b5563"} fontWeight={isToday ? 600 : 400} dy={8}>{d.label}</text>
        <text textAnchor="middle" fontSize={10} fill="#9ca3af" dy={21}>{d.wd}</text>
      </g>
    );
  };
  return (
    <>
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 22, right: 4, bottom: 0, left: -18 }}>
            <CartesianGrid vertical={false} stroke="#eef0f2" />
            <XAxis dataKey="day" tickLine={false} axisLine={{ stroke: "#d1d5db" }} interval={0} height={34} tick={XTick} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} />
            <Tooltip cursor={{ fill: "rgba(0,0,0,0.04)" }} labelFormatter={(d: string) => dmy(d)} />
            {src.sites.length > 1 && <Legend verticalAlign="top" align="right" height={22} iconType="square" iconSize={9} wrapperStyle={{ fontSize: 11, top: -4 }} />}
            {src.sites.map((st, i) => (
              <Bar key={st} dataKey={st} stackId="gate" fill={siteColour(st, i)} maxBarSize={44} isAnimationActive={false} radius={i === last ? [4, 4, 0, 0] : [0, 0, 0, 0]}>
                {/* the site's own count, inside its band when the band has room */}
                <LabelList dataKey={st} position="center" fontSize={11} fontWeight={600} fill="#ffffff" formatter={(v: unknown) => (Number(v) >= 8 && src.sites.length > 1 ? String(v) : "")} />
                {i === last && <LabelList dataKey="present" position="top" fontSize={12} fontWeight={700} fill="#111827" />}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex justify-between text-[12px] text-gray-500">
        <span>Average <span className="font-semibold tabular-nums text-gray-800">{num(avg)}</span> a day</span>
        {best && <span>Highest <span className="font-semibold tabular-nums text-gray-800">{num(best.present)}</span> on {dmy(best.day)}</span>}
      </div>
    </>
  );
}

/** The routes join the person in flat, as `name`. */
const empName = (r: { name?: string }) => r.name ?? "—";

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

  const todayQ = useQuery({ queryKey: ["payroll", "attendance-today"], queryFn: () => api<Today>("/api/payroll/attendance/today"), refetchInterval: 60_000 });
  const weekQ = useQuery({ queryKey: ["payroll", "attendance-daily", 7], queryFn: () => api<GateDays>("/api/payroll/attendance/daily?days=7"), refetchInterval: 60_000 });
  const leaveQ = useQuery({ queryKey: ["payroll", "leave", "pending"], queryFn: () => api<Leave[]>("/api/payroll/leave?status=pending") });
  const inputsQ = useQuery({ queryKey: ["payroll", "pay-inputs", "pending"], queryFn: () => api<PayInput[]>("/api/payroll/pay-inputs?status=pending") });
  const openQ = useQuery({ queryKey: ["payroll", "punches-open"], queryFn: () => api<OpenPunch[] | { rows: OpenPunch[] }>("/api/payroll/punches/open"), select: (d) => (Array.isArray(d) ? d : d.rows) });
  const holQ = useQuery({ queryKey: ["payroll", "holidays", year], queryFn: () => api<Holiday[]>(`/api/payroll/holidays?year=${year}`) });
  const empQ = useEmployees();

  const t = todayQ.data;
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
        {/* Gate attendance, last seven days */}
        <div className="card p-4">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Gate attendance, last 7 days</h2>
            <Link href="/payroll/time" className="text-[12px] text-brand-600 hover:underline">Open</Link>
          </div>
          {weekQ.isLoading ? <Spinner /> : weekQ.data ? <GateWeek data={weekQ.data} today={today} /> : null}
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
            <Link href="/settings/m-payroll" className="text-[12px] text-brand-600 hover:underline">Manage</Link>
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
                    <Td>{o.name ?? o.empCode ?? "—"}</Td>
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
