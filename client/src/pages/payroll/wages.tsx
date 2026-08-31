/**
 * Wages — two views of the same yard.
 *
 * Month: the daily-wage report — per worker, days present and half, amount
 * priced day by day at the role each day was worked in; totals by role.
 *
 * Day roles: one day at a time, every wage worker with an editable role
 * dropdown — because people change jobs day to day, egg picking today and
 * vaccination helper tomorrow. Presence itself comes from the gate; a worker
 * the gate never saw has no row to hang a role on, so the dropdown is dark.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatMoney } from "../../api";
import { Badge, Empty, PageHeader, Pager, Spinner, Td, Th, istToday, num, usePaged } from "../../components/payroll/ui";

interface WageRow {
  id: string;
  empCode: string;
  name: string;
  role: string | null;
  dailyRate: number | string;
  presentDays: number;
  halfDays: number;
  amount: number | string;
}
interface WagesReport {
  rows: WageRow[];
  byRole: { role: string | null; heads: number; presentDays: number; halfDays: number; amount: number | string }[];
  total?: number | string;
}
interface WageRole { id: string; name: string; isActive: boolean }
interface DayRow {
  id: string;
  empCode: string;
  name: string;
  defaultRoleId: string | null;
  defaultRoleName: string | null;
  status: string | null;
  dayRoleId: string | null;
}

export function PayrollWagesPage() {
  const today = istToday();
  const [view, setView] = useState<"month" | "day">("month");
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [role, setRole] = useState("");
  const [day, setDay] = useState(today);

  const rolesQ = useQuery({ queryKey: ["payroll", "wage-roles"], queryFn: () => api<WageRole[]>("/api/payroll/wage-roles") });
  const reportQ = useQuery({
    queryKey: ["payroll", "wages-report", from, to, role],
    queryFn: () => api<WagesReport>(`/api/payroll/reports/wages?from=${from}&to=${to}${role ? `&role=${encodeURIComponent(role)}` : ""}`),
    enabled: view === "month" && from <= to,
  });

  const rows = useMemo(
    () => [...(reportQ.data?.rows ?? [])].sort((a, b) => a.empCode.localeCompare(b.empCode, undefined, { numeric: true })),
    [reportQ.data],
  );
  const paged = usePaged(rows);
  const grand = reportQ.data?.total != null
    ? Number(reportQ.data.total)
    : rows.reduce((a, r) => a + Number(r.amount), 0);

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Wages">
        <div className="flex rounded-md border border-gray-200 bg-white p-0.5">
          {(["month", "day"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-3 py-1 text-[13px] ${view === v ? "bg-brand-50 font-medium text-brand-700" : "text-gray-500 hover:text-gray-800"}`}
            >
              {v === "month" ? "Month" : "Day roles"}
            </button>
          ))}
        </div>
        {view === "month" ? (
          <>
            <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-gray-400">–</span>
            <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} />
            <select value={role} onChange={(e) => setRole(e.target.value)} className="input w-44">
              <option value="">All roles</option>
              {(rolesQ.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </>
        ) : (
          <input type="date" className="input w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
        )}
      </PageHeader>

      {view === "day" ? (
        <DayRoles day={day} roles={rolesQ.data ?? []} />
      ) : (
        <>
          {/* Totals by role */}
          {reportQ.data && (
            <div className="mb-3 flex flex-wrap gap-2">
              {(reportQ.data.byRole ?? []).map((t) => (
                <div key={t.role ?? "none"} className="rounded-lg bg-white px-4 py-2 shadow-sm">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{t.role ?? "No role"}</div>
                  <div className="text-[15px] font-semibold tabular-nums">{formatMoney(t.amount)}</div>
                  <div className="text-[11px] tabular-nums text-gray-500">{t.heads} workers · {num(t.presentDays + t.halfDays * 0.5, 1)} days</div>
                </div>
              ))}
              <div className="rounded-lg bg-white px-4 py-2 shadow-sm ring-1 ring-brand-100">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Total</div>
                <div className="text-[15px] font-semibold tabular-nums">{formatMoney(grand)}</div>
              </div>
            </div>
          )}

          <div className="table-surface">
            {reportQ.isLoading ? (
              <Spinner />
            ) : (
              <table className="data-table w-full">
                <thead className="table-head">
                  <tr>
                    <Th className="col-fill">Worker</Th><Th className="col-portrait-hide">Role</Th><Th right className="col-portrait-hide">Rate/day</Th>
                    <Th right className="col-portrait-hide">Present</Th><Th right className="col-portrait-hide">Half</Th><Th right className="col-qty">Paid days</Th><Th right>Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {paged.page.map((r) => (
                    <tr key={r.id} className="table-row">
                      <Td className="col-fill"><span className="font-medium">{r.name}</span> <span className="text-[11px] text-gray-400">{r.empCode}</span></Td>
                      <Td className="col-portrait-hide">{r.role ?? <span className="text-red-600">no role</span>}</Td>
                      <Td right className="col-portrait-hide">{formatMoney(r.dailyRate)}</Td>
                      <Td right className="col-portrait-hide">{num(r.presentDays, 1)}</Td>
                      <Td right className="col-portrait-hide">{num(r.halfDays, 1)}</Td>
                      <Td right className="col-qty">{num(r.presentDays + r.halfDays * 0.5, 1)}</Td>
                      <Td right className="font-semibold">{formatMoney(r.amount)}</Td>
                    </tr>
                  ))}
                  {!paged.page.length && <tr><Td colSpan={7}><Empty>No daily-wage attendance in this range.</Empty></Td></tr>}
                  {paged.page.length > 0 && (
                    <tr className="bg-gray-50 font-semibold">
                      <Td colSpan={6}>Total ({rows.length} workers)</Td>
                      <Td right>{formatMoney(grand)}</Td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
            <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
          </div>
        </>
      )}
    </div>
  );
}

/** One day of the yard: everyone on the wage roll, and what they did that day. */
function DayRoles({ day, roles }: { day: string; roles: WageRole[] }) {
  const qc = useQueryClient();
  const dayQ = useQuery({
    queryKey: ["payroll", "wages-day", day],
    queryFn: () => api<DayRow[]>(`/api/payroll/wages/day?date=${day}`),
  });
  const [error, setError] = useState<string | null>(null);

  const setRole = useMutation({
    mutationFn: ({ employeeId, wageRoleId }: { employeeId: string; wageRoleId: string | null }) =>
      api(`/api/payroll/wages/day`, { method: "PATCH", body: { employeeId, day, wageRoleId } }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["payroll", "wages-day", day] });
      void qc.invalidateQueries({ queryKey: ["payroll", "wages-report"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed"),
  });

  const rows = dayQ.data ?? [];
  const paged = usePaged(rows);
  const present = rows.filter((r) => r.status === "P" || r.status === "H").length;
  const reassigned = rows.filter((r) => r.dayRoleId && r.dayRoleId !== r.defaultRoleId).length;

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="rounded-lg bg-white px-4 py-2 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">In the yard</div>
          <div className="text-[15px] font-semibold tabular-nums">{present} of {rows.length}</div>
        </div>
        <div className="rounded-lg bg-white px-4 py-2 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Reassigned today</div>
          <div className="text-[15px] font-semibold tabular-nums">{reassigned}</div>
        </div>
      </div>
      {error && <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}

      <div className="table-surface">
        {dayQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="data-table w-full">
            <thead className="table-head">
              <tr>
                <Th className="col-fill">Worker</Th>
                <Th className="col-status">Day</Th>
                <Th>Role worked</Th>
              </tr>
            </thead>
            <tbody>
              {paged.page.map((r) => {
                const inYard = r.status === "P" || r.status === "H";
                const changed = r.dayRoleId && r.dayRoleId !== r.defaultRoleId;
                return (
                  <tr key={r.id} className="table-row">
                    <Td className="col-fill">
                      <span className="font-medium">{r.name}</span>{" "}
                      <span className="text-[11px] text-gray-400">{r.empCode}</span>
                    </Td>
                    <Td className="col-status">
                      {r.status ? (
                        <Badge tone={inYard ? "green" : "gray"}>{r.status}</Badge>
                      ) : (
                        <span className="text-[12px] text-gray-400">—</span>
                      )}
                    </Td>
                    <Td>
                      <select
                        className={`input h-8 w-full max-w-56 py-0 text-[13px] ${changed ? "border-brand-300 bg-brand-50/50" : ""}`}
                        disabled={!r.status || setRole.isPending}
                        value={r.dayRoleId ?? ""}
                        onChange={(e) =>
                          setRole.mutate({ employeeId: r.id, wageRoleId: e.target.value || null })
                        }
                      >
                        <option value="">
                          usual{r.defaultRoleName ? ` — ${r.defaultRoleName}` : ""}
                        </option>
                        {roles.filter((x) => x.isActive || x.id === r.dayRoleId).map((x) => (
                          <option key={x.id} value={x.id}>{x.name}</option>
                        ))}
                      </select>
                    </Td>
                  </tr>
                );
              })}
              {!paged.page.length && <tr><Td colSpan={3}><Empty>Nobody on the wage roll.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>
    </>
  );
}
