/**
 * Wages — the daily-wage report: per worker, days present and half, amount
 * at the role's rate, over any date range; totals by role underneath.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, formatMoney } from "../../api";
import { Empty, PageHeader, Pager, Spinner, Td, Th, istToday, num, usePaged } from "../../components/payroll/ui";

interface WageRow {
  employeeId: string;
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

export function PayrollWagesPage() {
  const today = istToday();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [role, setRole] = useState("");

  const rolesQ = useQuery({ queryKey: ["payroll", "wage-roles"], queryFn: () => api<WageRole[]>("/api/payroll/wage-roles") });
  const reportQ = useQuery({
    queryKey: ["payroll", "wages-report", from, to, role],
    queryFn: () => api<WagesReport>(`/api/payroll/reports/wages?from=${from}&to=${to}${role ? `&role=${encodeURIComponent(role)}` : ""}`),
    enabled: from <= to,
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
      <PageHeader title="Wages" sub="Daily-wage cost: rate × (present + ½ half-days), straight from attendance.">
        <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-gray-400">–</span>
        <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="input w-44">
          <option value="">All roles</option>
          {(rolesQ.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </PageHeader>

      {/* Totals by role */}
      {reportQ.data && (
        <div className="mb-3 flex flex-wrap gap-2">
          {(reportQ.data.byRole ?? []).map((t) => (
            <div key={t.role ?? "none"} className="rounded-lg bg-white px-4 py-2 shadow-sm">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{t.role ?? "No role"}</div>
              <div className="text-[15px] font-semibold tabular-nums">{formatMoney(t.amount)}</div>
              <div className="text-[11px] tabular-nums text-gray-500">{t.heads} workers · {num(t.presentDays + t.halfDays * 0.5, 1)} paid days</div>
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
          <table className="w-full">
            <thead className="table-head">
              <tr>
                <Th>Worker</Th><Th>Role</Th><Th right>Rate/day</Th>
                <Th right>Present</Th><Th right>Half</Th><Th right>Paid days</Th><Th right>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {paged.page.map((r) => (
                <tr key={r.employeeId} className="table-row">
                  <Td><span className="font-medium">{r.name}</span> <span className="text-[11px] text-gray-400">{r.empCode}</span></Td>
                  <Td>{r.role ?? <span className="text-red-600">no role</span>}</Td>
                  <Td right>{formatMoney(r.dailyRate)}</Td>
                  <Td right>{num(r.presentDays, 1)}</Td>
                  <Td right>{num(r.halfDays, 1)}</Td>
                  <Td right>{num(r.presentDays + r.halfDays * 0.5, 1)}</Td>
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
    </div>
  );
}
