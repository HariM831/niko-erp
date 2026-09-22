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
import { SearchSelect } from "../../components/search-select";
import { useLocalSearch } from "../../components/search-context";
import { matchesTerm } from "../../lib/utils";
import { filterRows, useAdvancedSearch, type Criteria, type SearchField } from "../../components/advanced-search";
import { Badge, Empty, PageHeader, Pager, Spinner, Td, Th, istToday, num, usePaged } from "../../components/payroll/ui";

/**
 * Advanced search per view. Dates and role already sit in the header for the
 * month, so its search is the rest: who, and how much. The day view asks who
 * was in the yard and what they were put to.
 */
const MONTH_SEARCH: SearchField[] = [
  { key: "employee", label: "Employee", kind: "employee" },
  { key: "paidDays", label: "Paid Days", kind: "numberRange" },
  { key: "rate", label: "Daily Rate Range", kind: "numberRange" },
  { key: "amount", label: "Amount Range", kind: "numberRange" },
];

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
  // "Search in Wages" narrows the people listed, in either view; the totals
  // and the by-role summary still count everyone.
  const term = useLocalSearch("Wages", `payroll:wages:${view}`);

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
  const daySearch = useMemo<SearchField[]>(
    () => [
      { key: "employee", label: "Employee", kind: "employee" },
      {
        key: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "in", label: "In the yard (present or half)" },
          { value: "P", label: "Present" },
          { value: "H", label: "Half day" },
          { value: "out", label: "Not in the yard" },
        ],
      },
      {
        key: "role",
        label: "Role Worked",
        kind: "select",
        options: (rolesQ.data ?? []).map((r) => ({ value: r.id, label: r.name })),
      },
      {
        key: "reassigned",
        label: "Reassigned",
        kind: "select",
        options: [
          { value: "yes", label: "Worked another role" },
          { value: "no", label: "Usual role" },
        ],
      },
    ],
    [rolesQ.data],
  );
  const advMonth = useAdvancedSearch("Wages", MONTH_SEARCH);
  const advDay = useAdvancedSearch("Day roles", daySearch);
  const adv = view === "month" ? advMonth : advDay;
  const shown = filterRows(
    rows.filter((r) => matchesTerm(term, [r.name, r.empCode, r.role])),
    MONTH_SEARCH,
    advMonth.criteria,
    (r, key) => {
      switch (key) {
        case "employee":
          return r.id;
        case "paidDays":
          return r.presentDays + r.halfDays * 0.5;
        case "rate":
          return Number(r.dailyRate);
        case "amount":
          return Number(r.amount);
      }
    },
  );
  const paged = usePaged(shown);
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
            <SearchSelect
              className="w-44"
              value={role || null}
              onChange={(id) => setRole(id ?? "")}
              placeholder="All roles"
              options={(rolesQ.data ?? []).map((r) => ({ id: r.id, label: r.name }))}
            />
          </>
        ) : (
          <input type="date" className="input w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
        )}
        {adv.button}
      </PageHeader>
      {adv.dialog}

      {view === "day" ? (
        <DayRoles day={day} roles={rolesQ.data ?? []} term={term} fields={daySearch} criteria={advDay.criteria} />
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
                  {!paged.page.length && <tr><Td colSpan={7}><Empty>{(term.trim() || advMonth.active) && rows.length ? "Nobody matches." : "No daily-wage attendance in this range."}</Empty></Td></tr>}
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
function DayRoles({ day, roles, term, fields, criteria }: {
  day: string;
  roles: WageRole[];
  term: string;
  fields: SearchField[];
  criteria: Criteria;
}) {
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
  const paged = usePaged(
    filterRows(
      rows.filter((r) => matchesTerm(term, [r.name, r.empCode, r.defaultRoleName])),
      fields,
      criteria,
      (r, key) => {
        const inYard = r.status === "P" || r.status === "H";
        switch (key) {
          case "employee":
            return r.id;
          // "In" and "out" are the yard's two answers; P and H are the day's own.
          case "status":
            return [r.status, inYard ? "in" : "out"];
          // The role actually worked: the day's, or the usual one when none was set.
          case "role":
            return r.dayRoleId ?? r.defaultRoleId;
          case "reassigned":
            return r.dayRoleId && r.dayRoleId !== r.defaultRoleId ? "yes" : "no";
        }
      },
    ),
  );
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
                      {/* No role for the day (null) is "usual": the placeholder shows it, the × goes back to it. */}
                      <SearchSelect
                        className="w-full max-w-56"
                        buttonClassName={`input h-8 py-0 text-[13px] ${changed ? "border-brand-300 bg-brand-50/50" : ""}`}
                        disabled={!r.status || setRole.isPending}
                        value={r.dayRoleId || null}
                        onChange={(id) => {
                          // A <select> only fired on a change; re-picking the same role saves nothing.
                          if ((id || null) === (r.dayRoleId || null)) return;
                          setRole.mutate({ employeeId: r.id, wageRoleId: id || null });
                        }}
                        placeholder={`usual${r.defaultRoleName ? ` — ${r.defaultRoleName}` : ""}`}
                        options={roles.filter((x) => x.isActive || x.id === r.dayRoleId).map((x) => ({ id: x.id, label: x.name }))}
                      />
                    </Td>
                  </tr>
                );
              })}
              {!paged.page.length && <tr><Td colSpan={3}><Empty>{(term.trim() || Object.keys(criteria).length) && rows.length ? "Nobody matches." : "Nobody on the wage roll."}</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>
    </>
  );
}
