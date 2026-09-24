/**
 * Run — pick a month, process, review the slips and exceptions, confirm.
 *
 * Processing is repeatable while the run is a draft (it reverts its own side
 * effects first); confirming posts ONE journal dated the last day of the
 * month and locks it. The bank file is a CSV of name / account / IFSC / net.
 */
import { useMemo, useState, type ReactElement } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { ProportionBar, type ProportionSegment } from "@/components/ui/proportion-bar";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Printer } from "lucide-react";
import { useLocalSearch } from "../../components/search-context";
import { filterRows, useAdvancedSearch, type SearchField } from "../../components/advanced-search";
import { matchesTerm } from "../../lib/utils";
import { api, formatMoney } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Badge, Empty, ErrorBanner, MONTHS_LONG, MonthPicker, PageHeader, Pager, Spinner, Td, Th, dmy, fmtDateTime,
  num, statusTone, useErr, useMonth, usePaged,
} from "../../components/payroll/ui";

interface Run {
  id: string;
  month: number;
  year: number;
  status: "draft" | "confirmed";
  employeeCount: number;
  totalGross: number | string;
  totalDeductions: number | string;
  totalNet: number | string;
  totalEmployerCost: number | string;
  processedAt: string | null;
  confirmedAt: string | null;
  journalEntryNumber?: string | null;
}
interface Slip {
  id: string;
  employeeId: string;
  name?: string;
  empCode?: string;
  department?: string | null;
  payType: "salaried" | "daily_wage";
  totalDays: number;
  presentDays: number;
  halfDays: number;
  weeklyOffs: number;
  holidays: number;
  leaveDays: number;
  paidDays: number;
  lopDays: number;
  dailyRate: number | string | null;
  basicSalary: number | string;
  hra: number | string;
  allowances: number | string;
  earnedBasic: number | string;
  earnedHra: number | string;
  earnedAllowances: number | string;
  earnedGross: number | string;
  bonus: number | string;
  overtime: number | string;
  reimbursement: number | string;
  arrears: number | string;
  pfEmployee: number | string;
  pfEmployer: number | string;
  esiEmployee: number | string;
  esiEmployer: number | string;
  professionalTax: number | string;
  otherDeductions: number | string;
  advanceRecovery: number | string;
  totalDeductions: number | string;
  netPay: number | string;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
}
interface RunDetail {
  run: Run;
  slips: Slip[];
  exceptions: { employeeId: string; name: string; issue: string }[];
}

const slipName = (s: Slip) => s.name ?? "—";

/**
 * Finding slips within the month's run: whose, which kind of pay, and the
 * ones worth a second look before confirming — loss of pay, an advance being
 * recovered, a net pay out of line. Bank details matter too: a slip with no
 * account number is a line the bank file cannot pay.
 */
const searchFields = (departments: string[]): SearchField[] => [
  { key: "employee", label: "Employee", kind: "employee" },
  {
    key: "payType",
    label: "Pay Type",
    kind: "select",
    options: [
      { value: "salaried", label: "Salaried" },
      { value: "daily_wage", label: "Daily wage" },
    ],
  },
  { key: "department", label: "Department", kind: "select", options: departments },
  { key: "paidDays", label: "Paid Days", kind: "numberRange" },
  { key: "lopDays", label: "LOP Days", kind: "numberRange" },
  { key: "gross", label: "Earned Gross Range", kind: "numberRange" },
  { key: "deductions", label: "Deductions Range", kind: "numberRange" },
  { key: "net", label: "Net Pay Range", kind: "numberRange" },
  {
    key: "advance",
    label: "Advance Recovery",
    kind: "select",
    options: [
      { value: "yes", label: "Recovering an advance" },
      { value: "no", label: "No recovery" },
    ],
  },
  {
    key: "bank",
    label: "Bank Account",
    kind: "select",
    options: [
      { value: "yes", label: "On file" },
      { value: "no", label: "Missing" },
    ],
  },
];

export function PayrollRunPage() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const { year, month, setYear, setMonth } = useMonth();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [slipOpen, setSlipOpen] = useState<Slip | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runsQ = useQuery({ queryKey: ["payroll", "runs"], queryFn: () => api<Run[]>("/api/payroll/runs") });
  const monthRun = runsQ.data?.find((r) => r.year === year && r.month === month);
  const activeId = openRunId ?? monthRun?.id ?? null;

  const detailQ = useQuery({
    queryKey: ["payroll", "run", activeId],
    queryFn: () => api<RunDetail>(`/api/payroll/runs/${activeId}`),
    enabled: !!activeId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["payroll", "runs"] });
    qc.invalidateQueries({ queryKey: ["payroll", "run"] });
  };
  const processM = useMutation({
    mutationFn: () => api<{ id?: string; run?: Run }>("/api/payroll/runs/process", { method: "POST", body: { month, year } }),
    onSuccess: (d) => { invalidate(); setOpenRunId(d.run?.id ?? d.id ?? null); },
    onError: fail,
  });
  const confirmM = useMutation({
    mutationFn: (id: string) => api(`/api/payroll/runs/${id}/confirm`, { method: "POST" }),
    onSuccess: () => { invalidate(); setConfirmOpen(false); },
    onError: fail,
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => api(`/api/payroll/runs/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); setOpenRunId(null); },
    onError: fail,
  });

  const detail = detailQ.data;
  const run = detail?.run;
    // The server returns them in employee-code order; keep it.
  const slips = useMemo(() => detail?.slips ?? [], [detail]);
  // "Search in Payroll Run" finds a person's slip; the run's totals are the
  // server's and still cover everyone.
  const term = useLocalSearch("Payroll Run", "payroll:run");
  // Departments offered are the ones on this run's slips.
  const fields = useMemo(
    () => searchFields([...new Set(slips.map((sl) => sl.department).filter((d): d is string => !!d))].sort()),
    [slips],
  );
  const adv = useAdvancedSearch("Payroll run", fields);
  const paged = usePaged(
    filterRows(
      slips.filter((sl) => matchesTerm(term, [sl.name, sl.empCode, sl.department])),
      fields,
      adv.criteria,
      (sl, key) => {
        switch (key) {
          case "employee":
            return sl.employeeId;
          case "payType":
            return sl.payType;
          case "department":
            return sl.department;
          case "paidDays":
            return Number(sl.paidDays);
          case "lopDays":
            return Number(sl.lopDays);
          case "gross":
            return Number(sl.earnedGross);
          case "deductions":
            return Number(sl.totalDeductions);
          case "net":
            return Number(sl.netPay);
          case "advance":
            return Number(sl.advanceRecovery) > 0 ? "yes" : "no";
          case "bank":
            return sl.bankAccountNumber?.trim() ? "yes" : "no";
        }
      },
    ),
  );

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Payroll run" sub="Process a month, review every slip, then confirm — one journal, dated the last day of the month.">
        {run && adv.button}
        <MonthPicker year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m); setOpenRunId(null); }} />
        <button className="btn-primary" disabled={processM.isPending || monthRun?.status === "confirmed"} onClick={() => processM.mutate()}>
          {processM.isPending ? "Processing…" : monthRun ? "Re-process" : "Process"} {MONTHS_LONG[month - 1]}
        </button>
      </PageHeader>
      {adv.dialog}
      <ErrorBanner message={err} onClose={() => setErr(null)} />

      {run && (
        <>
          {/* Totals band */}
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            {[
              ["Employees", num(run.employeeCount)],
              ["Gross", formatMoney(run.totalGross)],
              ["Deductions", formatMoney(run.totalDeductions)],
              ["Net pay", formatMoney(run.totalNet)],
              ["Employer cost", formatMoney(run.totalEmployerCost)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-white px-4 py-3 shadow-sm">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
                <div className="text-lg font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </div>

          {detail && detail.slips.length > 0 && <GrossToNet slips={detail.slips} />}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(run.status)}>{run.status}</Badge>
            {run.processedAt && <span className="text-[12px] text-gray-500">processed {fmtDateTime(run.processedAt)}</span>}
            {run.status === "confirmed" && (
              <span className="text-[12px] text-gray-500">
                confirmed {fmtDateTime(run.confirmedAt)}{run.journalEntryNumber ? ` · journal ${run.journalEntryNumber}` : ""}
              </span>
            )}
            <span className="ml-auto flex gap-2">
              <a className="btn-secondary" href={`/api/payroll/runs/${run.id}/bank-file`} download>
                <Download size={14} /> Bank file
              </a>
              {run.status === "draft" && (
                <>
                  <button className="btn-ghost text-red-600" disabled={deleteM.isPending} onClick={() => deleteM.mutate(run.id)}>Delete draft</button>
                  <button className="btn-primary" onClick={() => setConfirmOpen(true)}>Confirm run…</button>
                </>
              )}
            </span>
          </div>

          {/* Exceptions */}
          {detail && detail.exceptions.length > 0 && (
            <div className="mb-3 rounded-md bg-amber-50 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-amber-800">
                <AlertTriangle size={14} /> {detail.exceptions.length} exception{detail.exceptions.length === 1 ? "" : "s"} — check before confirming
              </div>
              <ul className="space-y-0.5 text-[12px] text-amber-800">
                {detail.exceptions.map((x, i) => (
                  <li key={i}><span className="font-medium">{x.name}</span> — {x.issue}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Slips */}
          <div className="table-surface overflow-x-auto">
            {detailQ.isLoading ? (
              <Spinner />
            ) : (
              <table className="data-table w-full whitespace-nowrap">
                <thead className="table-head">
                  <tr>
                    <Th className="col-fill">Employee</Th><Th className="col-portrait-hide">Pay</Th>
                    <Th right className="col-portrait-hide">Paid days</Th><Th right className="col-portrait-hide">LOP</Th>
                    <Th right className="col-portrait-hide">Earned</Th><Th right className="col-portrait-hide">Extras</Th>
                    <Th right className="col-portrait-hide">PF</Th><Th right className="col-portrait-hide">ESI</Th><Th right className="col-portrait-hide">PT</Th>
                    <Th right className="col-portrait-hide">Advance</Th><Th right className="col-portrait-hide">Other</Th>
                    <Th right>Net pay</Th>
                  </tr>
                </thead>
                <tbody>
                  {paged.page.map((s) => (
                    <tr key={s.id} className="table-row cursor-pointer" onClick={() => setSlipOpen(s)}>
                      <Td className="col-fill">
                        <span className="font-medium">{slipName(s)}</span>
                        <span className="ml-1 text-[11px] text-gray-400">{s.empCode}</span>
                      </Td>
                      <Td className="col-portrait-hide"><Badge tone={s.payType === "salaried" ? "blue" : "gray"}>{s.payType === "salaried" ? "S" : "W"}</Badge></Td>
                      <Td right className="col-portrait-hide">{num(s.paidDays, 1)}/{s.totalDays}</Td>
                      <Td right className={`col-portrait-hide ${Number(s.lopDays) > 0 ? "text-red-600" : ""}`}>{num(s.lopDays, 1)}</Td>
                      <Td right className="col-portrait-hide">{formatMoney(s.earnedGross)}</Td>
                      <Td right className="col-portrait-hide">{formatMoney(Number(s.bonus) + Number(s.overtime) + Number(s.reimbursement) + Number(s.arrears))}</Td>
                      <Td right className="col-portrait-hide">{formatMoney(s.pfEmployee)}</Td>
                      <Td right className="col-portrait-hide">{formatMoney(s.esiEmployee)}</Td>
                      <Td right className="col-portrait-hide">{formatMoney(s.professionalTax)}</Td>
                      <Td right className="col-portrait-hide">{formatMoney(s.advanceRecovery)}</Td>
                      <Td right className="col-portrait-hide">{formatMoney(s.otherDeductions)}</Td>
                      <Td right className="font-semibold">{formatMoney(s.netPay)}</Td>
                    </tr>
                  ))}
                  {!paged.page.length && <tr><Td colSpan={12}><Empty>{(term.trim() || adv.active) && slips.length ? "No slips match." : "No slips."}</Empty></Td></tr>}
                </tbody>
              </table>
            )}
            <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
          </div>
        </>
      )}

      {!run && !runsQ.isLoading && (
        <div className="card p-8 text-center text-sm text-gray-400">
          {MONTHS_LONG[month - 1]} {year} has not been processed. Approve the month's pay inputs and leave first, then press Process.
        </div>
      )}

      {/* Past runs */}
      <div className="mt-6">
        <h2 className="mb-2 text-[15px] font-semibold">All runs</h2>
        <RunsChart runs={runsQ.data ?? []} />
        <div className="table-surface">
          {runsQ.isLoading ? (
            <Spinner />
          ) : (
            <table className="w-full">
              <thead className="table-head">
                <tr><Th className="col-fill">Month</Th><Th className="col-status">Status</Th><Th right className="col-portrait-hide">Employees</Th><Th right className="col-portrait-hide">Gross</Th><Th right>Net</Th><Th right className="col-portrait-hide">Employer cost</Th><Th className="col-portrait-hide">Journal</Th></tr>
              </thead>
              <tbody>
                {(runsQ.data ?? []).map((r) => (
                  <tr
                    key={r.id}
                    className="table-row cursor-pointer"
                    onClick={() => { setYear(r.year); setMonth(r.month); setOpenRunId(r.id); }}
                  >
                    <Td className="col-fill font-medium">{MONTHS_LONG[r.month - 1]} {r.year}</Td>
                    <Td className="col-status"><Badge tone={statusTone(r.status)}>{r.status}</Badge></Td>
                    <Td right className="col-portrait-hide">{r.employeeCount}</Td>
                    <Td right className="col-portrait-hide">{formatMoney(r.totalGross)}</Td>
                    <Td right>{formatMoney(r.totalNet)}</Td>
                    <Td right className="col-portrait-hide">{formatMoney(r.totalEmployerCost)}</Td>
                    <Td className="col-portrait-hide">{r.journalEntryNumber ?? "—"}</Td>
                  </tr>
                ))}
                {!runsQ.data?.length && <tr><Td colSpan={7}><Empty>No runs yet.</Empty></Td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Confirm dialog */}
      {confirmOpen && run && (
        <Dialog open onOpenChange={(v) => !v && setConfirmOpen(false)}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Confirm {MONTHS_LONG[run.month - 1]} {run.year}?</DialogTitle></DialogHeader>
            <div className="space-y-1 text-[13px]">
              <div className="flex justify-between"><span className="text-gray-500">Employees</span><span className="tabular-nums">{run.employeeCount}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Net payout</span><span className="font-semibold tabular-nums">{formatMoney(run.totalNet)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Employer cost</span><span className="tabular-nums">{formatMoney(run.totalEmployerCost)}</span></div>
            </div>
            {detail && detail.exceptions.length > 0 && (
              <div className="mt-2 rounded bg-amber-50 p-2 text-[12px] text-amber-800">
                {detail.exceptions.length} unresolved exception{detail.exceptions.length === 1 ? "" : "s"} will be confirmed as-is.
              </div>
            )}
            <p className="mt-2 text-[12px] text-gray-500">
              Posts one journal dated the last day of the month and locks the run. A confirmed run cannot be deleted.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={confirmM.isPending} onClick={() => confirmM.mutate(run.id)}>
                {confirmM.isPending ? "Posting…" : "Confirm and post"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Payslip */}
      {slipOpen && run && <PayslipDialog slip={slipOpen} run={run} onClose={() => setSlipOpen(null)} />}
    </div>
  );
}

function PayslipDialog({ slip: s, run, onClose }: { slip: Slip; run: Run; onClose: () => void }) {
  const Row = ({ label, value, bold, neg }: { label: string; value: number | string; bold?: boolean; neg?: boolean }) =>
    Number(value) === 0 && !bold ? null : (
      <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
        <span className={bold ? "" : "text-gray-500"}>{label}</span>
        <span className={`tabular-nums ${neg ? "text-red-600" : ""}`}>{neg ? "−" : ""}{formatMoney(value)}</span>
      </div>
    );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md print:max-w-full print:border-0 print:shadow-none">
        <DialogHeader>
          <DialogTitle>Payslip · {MONTHS_LONG[run.month - 1]} {run.year}</DialogTitle>
        </DialogHeader>
        <div className="text-[13px]">
          <div className="mb-2">
            <div className="text-[15px] font-semibold">{slipName(s)}</div>
            <div className="text-gray-500">
              {s.empCode} · {s.department ?? "—"} · {s.payType === "salaried" ? "Salaried" : "Daily wage"}
              {s.payType === "daily_wage" && s.dailyRate != null && <> · {formatMoney(s.dailyRate)}/day</>}
            </div>
          </div>
          <div className="mb-2 grid grid-cols-4 gap-1 rounded-md bg-gray-50 p-2 text-center text-[12px]">
            {[
              ["Paid", num(s.paidDays, 1)],
              ["Present", num(s.presentDays, 1)],
              ["Half", num(s.halfDays, 1)],
              ["LOP", num(s.lopDays, 1)],
              ["WO", num(s.weeklyOffs, 1)],
              ["Holiday", num(s.holidays, 1)],
              ["Leave", num(s.leaveDays, 1)],
              ["Days", String(s.totalDays)],
            ].map(([l, v]) => (
              <div key={l}><div className="text-gray-400">{l}</div><div className="tabular-nums">{v}</div></div>
            ))}
          </div>
          <div className="space-y-0.5">
            <div className="text-[11px] font-semibold uppercase text-gray-400">Earnings</div>
            <Row label="Basic" value={s.earnedBasic} />
            <Row label="HRA" value={s.earnedHra} />
            <Row label="Allowances" value={s.earnedAllowances} />
            <Row label="Bonus" value={s.bonus} />
            <Row label="Overtime" value={s.overtime} />
            <Row label="Reimbursement" value={s.reimbursement} />
            {Number(s.arrears) > 0 && <Row label="Arrears (earlier month)" value={s.arrears} />}
            <Row label="Gross earnings" value={Number(s.earnedGross) + Number(s.bonus) + Number(s.overtime) + Number(s.reimbursement) + Number(s.arrears)} bold />
            <div className="pt-1 text-[11px] font-semibold uppercase text-gray-400">Deductions</div>
            <Row label="PF" value={s.pfEmployee} neg />
            <Row label="ESI" value={s.esiEmployee} neg />
            <Row label="Professional tax" value={s.professionalTax} neg />
            <Row label="Other deductions" value={s.otherDeductions} neg />
            <Row label="Advance recovery" value={s.advanceRecovery} neg />
            <Row label="Total deductions" value={s.totalDeductions} bold neg />
            <div className="mt-1 border-t border-gray-200 pt-1">
              <Row label="Net pay" value={s.netPay} bold />
            </div>
          </div>
          {(s.bankAccountNumber || s.bankIfsc) && (
            <div className="mt-2 text-[12px] text-gray-500">
              {s.bankName ?? ""} {s.bankAccountNumber ?? ""} {s.bankIfsc ?? ""}
            </div>
          )}
          <div className="mt-1 text-[11px] text-gray-400">
            Employer contributions (not deducted): PF {formatMoney(s.pfEmployer)} · ESI {formatMoney(s.esiEmployer)}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2 print:hidden">
          <button className="btn-secondary" onClick={() => window.print()}><Printer size={14} /> Print</button>
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * recharts 3 types the Tooltip's formatters more tightly than these charts
 * need; widened once, as the shed-conditions charts do.
 */
const Tooltip = RechartsTooltip as unknown as (props: Record<string, unknown>) => ReactElement;

/**
 * Where the month's gross goes: what reaches the people, and each thing taken
 * off on the way. Five totals tiles above say how big each figure is; this
 * says how they relate, which the tiles leave to arithmetic.
 */
function GrossToNet({ slips }: { slips: Slip[] }) {
  const sum = (k: keyof Slip) => slips.reduce((a, s) => a + (Number(s[k]) || 0), 0);
  const all: ProportionSegment[] = [
    { label: "Net pay", value: sum("netPay"), tone: "brand" },
    { label: "PF", value: sum("pfEmployee"), tone: "neutral" },
    { label: "ESI", value: sum("esiEmployee"), tone: "neutral" },
    { label: "Professional tax", value: sum("professionalTax"), tone: "neutral" },
    { label: "Advance recovery", value: sum("advanceRecovery"), tone: "neutral" },
    { label: "Other deductions", value: sum("otherDeductions"), tone: "neutral" },
  ];
  const parts = all
    .filter((p) => p.value > 0)
    .map((p) => ({ ...p, display: formatMoney(p.value) }));
  const whole = parts.reduce((a, p) => a + p.value, 0);
  if (!whole) return null;
  return (
    <div className="mb-3 rounded-lg bg-white px-4 py-3 shadow-sm">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        Where {formatMoney(whole)} goes
      </div>
      <ProportionBar segments={parts} />
    </div>
  );
}

/**
 * Every run, oldest to newest: net and deductions stacked to the gross, with
 * what the month cost the business — employer PF and ESI on top — as a line.
 * A draft is drawn faint; its figures move until it is confirmed.
 */
function RunsChart({ runs }: { runs: Run[] }) {
  const data = [...runs]
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .slice(-12)
    .map((r) => ({
      label: `${MONTHS_LONG[r.month - 1]!.slice(0, 3)} ${String(r.year).slice(2)}`,
      net: Number(r.totalNet),
      deductions: Number(r.totalDeductions),
      employerCost: Number(r.totalEmployerCost),
      draft: r.status === "draft",
    }));
  if (data.length < 2) return null;
  const money = (v: number) => formatMoney(v);
  // Lakh on the axis, trimmed: "12 L", "4.5 L", "0" — not "8.0 L" or "0 k".
  const axis = (v: number) => (v === 0 ? "0" : v >= 1e5 ? `${+(v / 1e5).toFixed(1)} L` : `${Math.round(v / 1e3)} k`);
  return (
    <div className="mb-3 rounded-lg bg-white px-3 pb-2 pt-3 shadow-sm">
      <div className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={axis} width={44} />
            <Tooltip formatter={(v: number, n: string) => [money(v), n]} />
            <Legend wrapperStyle={{ fontSize: 11 }} itemSorter={null} formatter={(v: string) => <span className="text-gray-600">{v}</span>} />
            <Bar dataKey="net" name="Net pay" stackId="g" fill="var(--color-brand-500)" isAnimationActive={false}>
              {data.map((d, i) => <Cell key={i} fillOpacity={d.draft ? 0.4 : 1} />)}
            </Bar>
            <Bar dataKey="deductions" name="Deductions" stackId="g" fill="var(--color-soil-400)" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {data.map((d, i) => <Cell key={i} fillOpacity={d.draft ? 0.4 : 1} />)}
            </Bar>
            <Line dataKey="employerCost" name="Cost to the business" stroke="var(--color-soil-600)" strokeDasharray="4 3" strokeWidth={1.5} dot={{ r: 2 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {data.some((d) => d.draft) && (
        <p className="px-1 text-[11px] text-gray-400">Faint bars are drafts, not yet confirmed.</p>
      )}
    </div>
  );
}
