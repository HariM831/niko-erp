/**
 * Run — pick a month, process, review the slips and exceptions, confirm.
 *
 * Processing is repeatable while the run is a draft (it reverts its own side
 * effects first); confirming posts ONE journal dated the last day of the
 * month and locks it. The bank file is a CSV of name / account / IFSC / net.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Printer } from "lucide-react";
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
  const paged = usePaged(slips);

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Payroll run" sub="Process a month, review every slip, then confirm — one journal, dated the last day of the month.">
        <MonthPicker year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m); setOpenRunId(null); }} />
        <button className="btn-primary" disabled={processM.isPending || monthRun?.status === "confirmed"} onClick={() => processM.mutate()}>
          {processM.isPending ? "Processing…" : monthRun ? "Re-process" : "Process"} {MONTHS_LONG[month - 1]}
        </button>
      </PageHeader>
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
              <table className="w-full whitespace-nowrap">
                <thead className="table-head">
                  <tr>
                    <Th>Employee</Th><Th>Pay</Th>
                    <Th right>Paid days</Th><Th right>LOP</Th>
                    <Th right>Earned</Th><Th right>Extras</Th>
                    <Th right>PF</Th><Th right>ESI</Th><Th right>PT</Th>
                    <Th right>Advance</Th><Th right>Other</Th>
                    <Th right>Net pay</Th>
                  </tr>
                </thead>
                <tbody>
                  {paged.page.map((s) => (
                    <tr key={s.id} className="table-row cursor-pointer" onClick={() => setSlipOpen(s)}>
                      <Td>
                        <span className="font-medium">{slipName(s)}</span>
                        <span className="ml-1 text-[11px] text-gray-400">{s.empCode}</span>
                      </Td>
                      <Td><Badge tone={s.payType === "salaried" ? "blue" : "gray"}>{s.payType === "salaried" ? "S" : "W"}</Badge></Td>
                      <Td right>{num(s.paidDays, 1)}/{s.totalDays}</Td>
                      <Td right className={Number(s.lopDays) > 0 ? "text-red-600" : ""}>{num(s.lopDays, 1)}</Td>
                      <Td right>{formatMoney(s.earnedGross)}</Td>
                      <Td right>{formatMoney(Number(s.bonus) + Number(s.overtime) + Number(s.reimbursement))}</Td>
                      <Td right>{formatMoney(s.pfEmployee)}</Td>
                      <Td right>{formatMoney(s.esiEmployee)}</Td>
                      <Td right>{formatMoney(s.professionalTax)}</Td>
                      <Td right>{formatMoney(s.advanceRecovery)}</Td>
                      <Td right>{formatMoney(s.otherDeductions)}</Td>
                      <Td right className="font-semibold">{formatMoney(s.netPay)}</Td>
                    </tr>
                  ))}
                  {!paged.page.length && <tr><Td colSpan={12}><Empty>No slips.</Empty></Td></tr>}
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
            <Row label="Gross earnings" value={Number(s.earnedGross) + Number(s.bonus) + Number(s.overtime) + Number(s.reimbursement)} bold />
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
