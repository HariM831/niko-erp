/**
 * Pay inputs — bonus, overtime, reimbursement, deduction and arrears in ONE
 * table (Amino had five pages; the kinds differ only in a few form fields).
 * Approved rows are picked up by the month's payroll run and marked paid.
 *
 * Arrears are late salary: days earned in one month and paid in a later one.
 * The amount is what that month's slip would have been, worked out by the
 * server with the run's own arithmetic, not typed from memory.
 *
 * Below it, Advances: money already handed over, recovered by the run and by
 * nothing else. What a month takes is the EMI, so the EMI is what HR changes.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, formatMoney } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Badge, Empty, EmployeeSelect, ErrorBanner, Field, MonthPicker, PageHeader, Pager, Spinner, Td, Th, dmy, istToday,
  num, statusTone, useEmployees, useErr, useMonth, usePaged,
} from "../../components/payroll/ui";
import { monthsBefore } from "@shared/search";

type Kind = "bonus" | "overtime" | "reimbursement" | "deduction" | "arrears";
const KINDS: Kind[] = ["bonus", "overtime", "reimbursement", "deduction", "arrears"];
const KIND_LABEL: Record<Kind, string> = { bonus: "Bonus", overtime: "Overtime", reimbursement: "Reimbursement", deduction: "Deduction", arrears: "Arrears" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: number, y: number) => `${MONTHS[m - 1]} ${y}`;
const BONUS_CATEGORIES = ["festival", "performance", "referral", "retention", "other"];
const EXPENSE_CATEGORIES = ["travel", "food", "accommodation", "communication", "medical", "other"];

interface PayInput {
  id: string;
  employeeId: string;
  name: string;
  empCode: string;
  kind: Kind;
  month: number;
  year: number;
  amount: number | string;
  hours: number | null;
  ratePerHour: number | string | null;
  earnedMonth: number | null;
  earnedYear: number | null;
  days: number | null;
  category: string | null;
  description: string | null;
  status: "pending" | "approved" | "rejected" | "paid";
  approvedAmount: number | string | null;
}
interface ArrearsSuggestion {
  days: number;
  totalDays: number;
  amount: number;
  monthly: number | null;
  working: string;
  dateOfJoining: string | null;
  existingSlip: { paidDays: number; netPay: number; status: string } | null;
}
interface Advance {
  id: string;
  employeeId: string;
  name: string;
  empCode: string;
  type: "salary_advance" | "loan";
  amount: number | string;
  emiAmount: number | string;
  givenOn: string;
  reason: string | null;
  status: "active" | "closed" | "cancelled";
  outstanding: number | string;
  repayments: { id: string; amount: number | string; month: number; year: number; notes: string | null; payrollRunId: string | null }[];
}

/** The routes join the employee in flat: `name` and `empCode` on the row. */
const who = (r: { name?: string; empCode?: string }) => r.name ?? "—";
const whoCode = (r: { empCode?: string }) => r.empCode ?? "";

export function PayrollPayInputsPage() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const { year, month, setYear, setMonth } = useMonth();
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [approveFor, setApproveFor] = useState<PayInput | null>(null);
  const [approvedAmount, setApprovedAmount] = useState("");

  const listQ = useQuery({
    queryKey: ["payroll", "pay-inputs", year, month, kind, status],
    queryFn: () => api<PayInput[]>(`/api/payroll/pay-inputs?year=${year}&month=${month}${kind ? `&kind=${kind}` : ""}${status ? `&status=${status}` : ""}`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "pay-inputs"] });
  const decide = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: "approve" | "reject"; body?: unknown }) =>
      api(`/api/payroll/pay-inputs/${id}/${action}`, { method: "POST", body: body ?? {} }),
    onSuccess: () => { invalidate(); setApproveFor(null); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/payroll/pay-inputs/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: fail,
  });

  const rows = listQ.data ?? [];
  const paged = usePaged(rows);
  const totals = useMemo(() => {
    const t: Record<Kind, number> = { bonus: 0, overtime: 0, reimbursement: 0, deduction: 0, arrears: 0 };
    for (const r of rows) if (r.status === "approved" || r.status === "paid") t[r.kind] += Number(r.approvedAmount ?? r.amount);
    return t;
  }, [rows]);

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Pay inputs" sub="Bonus, overtime, reimbursement, deduction and arrears — approved rows flow into the month's run.">
        <button className="btn-primary" onClick={() => setAddOpen(true)}><Plus size={14} /> Add input</button>
      </PageHeader>
      <ErrorBanner message={err} onClose={() => setErr(null)} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MonthPicker year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m); }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="input w-40">
          <option value="">All kinds</option>
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="input w-36">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="paid">Paid</option>
        </select>
        <span className="ml-auto text-[12px] tabular-nums text-gray-500">
          Approved: +{formatMoney(totals.bonus + totals.overtime + totals.reimbursement + totals.arrears)} · −{formatMoney(totals.deduction)}
        </span>
      </div>

      <div className="table-surface overflow-x-auto">
        {listQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Employee</Th><Th>Kind</Th><Th>Detail</Th><Th right>Amount</Th><Th right>Approved</Th><Th>Status</Th><Th /></tr>
            </thead>
            <tbody>
              {paged.page.map((r) => (
                <tr key={r.id} className="table-row">
                  <Td className="font-medium">
                    {who(r)} <span className="ml-1 text-[11px] font-normal text-gray-400">{whoCode(r)}</span>
                  </Td>
                  <Td><Badge tone={r.kind === "deduction" ? "red" : "blue"}>{KIND_LABEL[r.kind]}</Badge></Td>
                  <Td className="max-w-[280px] truncate" title={r.description ?? undefined}>
                    {r.kind === "overtime" && r.hours != null && <span className="tabular-nums">{num(r.hours, 1)} h × {formatMoney(r.ratePerHour ?? 0)} · </span>}
                    {r.kind === "arrears" && r.earnedMonth && r.earnedYear && (
                      <span className="tabular-nums">earned {monthName(r.earnedMonth, r.earnedYear)}{r.days != null ? ` · ${num(r.days, 1)} day(s)` : ""}{r.description ? " · " : ""}</span>
                    )}
                    {r.category && <span className="capitalize">{r.category} · </span>}
                    {r.description ?? ""}
                  </Td>
                  <Td right>{formatMoney(r.amount)}</Td>
                  <Td right>{r.approvedAmount != null ? formatMoney(r.approvedAmount) : "—"}</Td>
                  <Td><Badge tone={statusTone(r.status)}>{r.status}</Badge></Td>
                  <Td right>
                    {r.status === "pending" && (
                      <span className="flex justify-end gap-1">
                        <button className="btn-ghost text-emerald-700" onClick={() => { setApproveFor(r); setApprovedAmount(String(Number(r.amount))); }}>Approve</button>
                        <button className="btn-ghost text-red-600" onClick={() => decide.mutate({ id: r.id, action: "reject" })}>Reject</button>
                      </span>
                    )}
                    {r.status !== "paid" && r.status !== "pending" && (
                      <button className="btn-ghost text-red-600" onClick={() => remove.mutate(r.id)}>Delete</button>
                    )}
                  </Td>
                </tr>
              ))}
              {!paged.page.length && <tr><Td colSpan={7}><Empty>No pay inputs for this month.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>

      <AdvancesSection />

      {addOpen && <AddInputDialog year={year} month={month} onClose={() => setAddOpen(false)} onSaved={invalidate} />}

      {approveFor && (
        <Dialog open onOpenChange={(v) => !v && setApproveFor(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Approve {KIND_LABEL[approveFor.kind]} · {who(approveFor)}</DialogTitle></DialogHeader>
            <Field label="Approved amount" hint={`Requested ${formatMoney(approveFor.amount)}`}>
              <input type="number" className="input tabular-nums" value={approvedAmount} onChange={(e) => setApprovedAmount(e.target.value)} />
            </Field>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setApproveFor(null)}>Cancel</button>
              <button
                className="btn-primary"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: approveFor.id, action: "approve", body: { approvedAmount: Number(approvedAmount) || undefined } })}
              >
                Approve
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function AddInputDialog({ year, month, onClose, onSaved }: { year: number; month: number; onClose: () => void; onSaved: () => void }) {
  const { err, setErr, fail } = useErr();
  const [form, setForm] = useState({
    employeeId: "", kind: "bonus" as Kind, amount: "", hours: "", ratePerHour: "", category: "", description: "",
    earned: "", days: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Arrears: the month before the one paying is the latest a day can have been
  // earned in, and the usual answer, so it is where the picker starts.
  const lastEarnable = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  const isArrears = form.kind === "arrears";
  const earnedYear = Number(form.earned.slice(0, 4)) || 0;
  const earnedMonth = Number(form.earned.slice(5, 7)) || 0;
  useEffect(() => {
    if (isArrears && !form.earned) set("earned", lastEarnable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isArrears]);

  // Arrears are nearly always for someone who joined late in a month nobody
  // ran a payroll for. Those few are offered first, each with the date that
  // makes them a candidate; everyone else is a search away.
  const staffQ = useEmployees();
  const recentJoiners = useMemo(() => {
    const since = monthsBefore(year, month, 2);
    const recent = (staffQ.data ?? [])
      .filter((e) => e.dateOfJoining && e.dateOfJoining >= since)
      .sort((a, b) => (a.dateOfJoining! < b.dateOfJoining! ? 1 : -1));
    const joined = new Map(recent.map((e) => [e.id, `joined ${dmy(e.dateOfJoining!)}`]));
    return { heading: "Recent joiners", ids: recent.map((e) => e.id), meta: (id: string) => joined.get(id) ?? null, collapseOthers: recent.length > 0 };
  }, [staffQ.data, year, month]);

  const suggestQ = useQuery({
    queryKey: ["payroll", "arrears-suggest", form.employeeId, form.earned],
    enabled: isArrears && !!form.employeeId && !!form.earned,
    queryFn: () => api<ArrearsSuggestion>(`/api/payroll/arrears/suggest?employeeId=${form.employeeId}&earnedMonth=${earnedMonth}&earnedYear=${earnedYear}`),
  });
  const suggestion = suggestQ.data;
  // What attendance says fills the form; after that the figures are HR's to
  // change, because a closed month's attendance can still be corrected.
  useEffect(() => {
    if (suggestion) setForm((f) => ({ ...f, days: String(suggestion.days), amount: String(suggestion.amount) }));
  }, [suggestion]);
  const setDays = (v: string) => {
    setForm((f) => {
      const next = { ...f, days: v };
      if (suggestion?.monthly != null && v !== "") next.amount = String(Math.round(((suggestion.monthly * Number(v)) / suggestion.totalDays) * 100) / 100);
      return next;
    });
  };

  const otAmount = (Number(form.hours) || 0) * (Number(form.ratePerHour) || 0);
  const amount = form.kind === "overtime" ? otAmount : Number(form.amount) || 0;

  const save = useMutation({
    mutationFn: () => api("/api/payroll/pay-inputs", {
      method: "POST",
      body: {
        employeeId: form.employeeId,
        kind: form.kind,
        year,
        month,
        amount,
        // Left out, not null, for the other kinds: the server takes a number or
        // nothing, and a null here refused every bonus and deduction outright.
        hours: form.kind === "overtime" ? Number(form.hours) || 0 : undefined,
        ratePerHour: form.kind === "overtime" ? Number(form.ratePerHour) || 0 : undefined,
        category: form.kind === "bonus" || form.kind === "reimbursement" ? form.category || null : null,
        description: form.description.trim() || null,
        ...(isArrears && { earnedMonth, earnedYear, days: form.days === "" ? undefined : Number(form.days) }),
      },
    }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: fail,
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add pay input · {month}/{year}</DialogTitle></DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        <div className="space-y-2">
          <Field label="Employee" required>
            <EmployeeSelect value={form.employeeId} onChange={(v) => set("employeeId", v)} pinned={isArrears ? recentJoiners : undefined} />
          </Field>
          <Field label="Kind" required>
            <div className="flex rounded-md bg-gray-100 p-0.5 text-[13px]">
              {KINDS.map((k) => (
                <button key={k} type="button" onClick={() => set("kind", k)} className={`flex-1 rounded px-1 py-1 ${form.kind === k ? "bg-white font-medium shadow-sm" : "text-gray-500"}`}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </Field>
          {form.kind === "overtime" ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Hours" required>
                <input type="number" step="0.5" className="input tabular-nums" value={form.hours} onChange={(e) => set("hours", e.target.value)} />
              </Field>
              <Field label="Rate per hour" required>
                <input type="number" className="input tabular-nums" value={form.ratePerHour} onChange={(e) => set("ratePerHour", e.target.value)} />
              </Field>
              <div className="col-span-2 text-[12px] text-gray-500">Amount: <strong className="tabular-nums">{formatMoney(otAmount)}</strong></div>
            </div>
          ) : isArrears ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Earned in" required hint={suggestion?.dateOfJoining ? `Joined ${dmy(suggestion.dateOfJoining)}` : undefined} className="col-span-2">
                <input
                  type="month"
                  className="input tabular-nums"
                  max={lastEarnable}
                  min={suggestion?.dateOfJoining?.slice(0, 7)}
                  value={form.earned}
                  onChange={(e) => set("earned", e.target.value)}
                />
              </Field>
              <Field label="Days" hint={suggestion?.monthly == null ? undefined : "Changing this re-works the amount"}>
                <input type="number" step="0.5" className="input tabular-nums" value={form.days} onChange={(e) => setDays(e.target.value)} />
              </Field>
              <Field label="Amount" required>
                <input type="number" className="input tabular-nums" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
              </Field>
              {suggestQ.isFetching && <div className="col-span-2 text-[12px] text-gray-500">Working out what that month earned…</div>}
              {suggestion && (
                <div className="col-span-2 text-[12px] text-gray-500">
                  Attendance says <strong className="tabular-nums">{suggestion.working} = {formatMoney(suggestion.amount)}</strong>
                  {(Number(form.days) !== suggestion.days || Number(form.amount) !== suggestion.amount) && (
                    <button type="button" className="ml-2 underline" onClick={() => setForm((f) => ({ ...f, days: String(suggestion.days), amount: String(suggestion.amount) }))}>
                      Reset
                    </button>
                  )}
                </div>
              )}
              {suggestion?.existingSlip && (
                <div className="col-span-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-900">
                  {monthName(earnedMonth, earnedYear)} already has a payslip for this person — {num(suggestion.existingSlip.paidDays, 1)} paid day(s),
                  net {formatMoney(suggestion.existingSlip.netPay)} ({suggestion.existingSlip.status}). Arrears on top of it pay those days a second time
                  unless they were left out of that slip.
                </div>
              )}
            </div>
          ) : (
            <Field label="Amount" required>
              <input type="number" className="input tabular-nums" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
            </Field>
          )}
          {(form.kind === "bonus" || form.kind === "reimbursement") && (
            <Field label="Category">
              <select className="input capitalize" value={form.category} onChange={(e) => set("category", e.target.value)}>
                <option value="">—</option>
                {(form.kind === "bonus" ? BONUS_CATEGORIES : EXPENSE_CATEGORIES).map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}
              </select>
            </Field>
          )}
          <Field label="Description">
            <input className="input" value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || !form.employeeId || amount <= 0 || (isArrears && !form.earned)} onClick={() => save.mutate()}>Add</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Advances ──────────────────────────────────────────────────────────── */
function AdvancesSection() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const [status, setStatus] = useState("active");
  const [addOpen, setAddOpen] = useState(false);
  const [recoveryFor, setRecoveryFor] = useState<Advance | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ["payroll", "advances", status],
    queryFn: () => api<Advance[]>(`/api/payroll/advances${status ? `?status=${status}` : ""}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "advances"] });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/payroll/advances/${id}/cancel`, { method: "POST" }),
    onSuccess: invalidate,
    onError: fail,
  });

  const rows = listQ.data ?? [];
  const outstanding = rows.reduce((a, r) => a + Number(r.outstanding), 0);

  return (
    <div className="mt-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold">Advances</h2>
        <span className="text-[12px] tabular-nums text-gray-500">outstanding {formatMoney(outstanding)}</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="input ml-auto w-32">
          <option value="active">Active</option>
          <option value="closed">Closed</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
        <button className="btn-secondary" onClick={() => setAddOpen(true)}><Plus size={14} /> Give advance</button>
      </div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="table-surface overflow-x-auto">
        {listQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Employee</Th><Th>Type</Th><Th>Given on</Th><Th right>Amount</Th><Th right>EMI</Th><Th right>Outstanding</Th><Th>Status</Th><Th /></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <Fragment key={a.id}>
                  <tr className="table-row cursor-pointer" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                    <Td className="font-medium">
                      {who(a)} <span className="ml-1 text-[11px] font-normal text-gray-400">{whoCode(a)}</span>
                    </Td>
                    <Td>{a.type === "loan" ? "Loan" : "Salary advance"}{a.reason && <span className="ml-1 text-[11px] text-gray-400">{a.reason}</span>}</Td>
                    <Td className="tabular-nums">{dmy(a.givenOn)}</Td>
                    <Td right>{formatMoney(a.amount)}</Td>
                    <Td right>{formatMoney(a.emiAmount)}</Td>
                    <Td right className="font-semibold">{formatMoney(a.outstanding)}</Td>
                    <Td><Badge tone={statusTone(a.status)}>{a.status}</Badge></Td>
                    <Td right onClick={undefined}>
                      {a.status === "active" && (
                        <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <button className="btn-ghost" onClick={() => setRecoveryFor(a)}>Recovery</button>
                          <button className="btn-ghost text-red-600" onClick={() => cancel.mutate(a.id)}>Cancel</button>
                        </span>
                      )}
                    </Td>
                  </tr>
                  {expanded === a.id && a.repayments.length > 0 && (
                    <tr>
                      <Td colSpan={8} className="!bg-gray-50">
                        <div className="flex flex-wrap gap-4 py-1 text-[12px] tabular-nums text-gray-600">
                          {a.repayments.map((r) => (
                            <span key={r.id}>
                              {r.month}/{r.year}: {formatMoney(r.amount)}
                              {r.payrollRunId ? " (payroll)" : " (manual)"}
                              {r.notes ? ` — ${r.notes}` : ""}
                            </span>
                          ))}
                        </div>
                      </Td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!rows.length && <tr><Td colSpan={8}><Empty>No advances.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <GiveAdvanceDialog onClose={() => setAddOpen(false)} onSaved={invalidate} />}
      {recoveryFor && <RecoveryDialog advance={recoveryFor} onClose={() => setRecoveryFor(null)} onSaved={invalidate} />}
    </div>
  );
}

function GiveAdvanceDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { err, setErr, fail } = useErr();
  const [form, setForm] = useState({ employeeId: "", type: "salary_advance", amount: "", emiAmount: "", givenOn: istToday(), reason: "" });
  const save = useMutation({
    mutationFn: () => api("/api/payroll/advances", {
      method: "POST",
      body: { ...form, amount: Number(form.amount), emiAmount: Number(form.emiAmount) || 0, reason: form.reason.trim() || null },
    }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: fail,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Give an advance</DialogTitle></DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        <div className="space-y-2">
          <Field label="Employee" required><EmployeeSelect value={form.employeeId} onChange={(v) => setForm({ ...form, employeeId: v })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type">
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="salary_advance">Salary advance</option>
                <option value="loan">Loan</option>
              </select>
            </Field>
            <Field label="Given on" required><input type="date" className="input" value={form.givenOn} onChange={(e) => setForm({ ...form, givenOn: e.target.value })} /></Field>
            <Field label="Amount" required><input type="number" className="input tabular-nums" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
            <Field label="Monthly EMI" hint="Recovered from each run"><input type="number" className="input tabular-nums" value={form.emiAmount} onChange={(e) => setForm({ ...form, emiAmount: e.target.value })} /></Field>
          </div>
          <Field label="Reason"><input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || !form.employeeId || !(Number(form.amount) > 0)} onClick={() => save.mutate()}>Record advance</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How an advance comes back. The run takes the EMI each month — capped at the
 * balance and at the pay — and nothing else records a repayment, so this one
 * figure is the whole of HR's say: less this month, nothing this month, or the
 * lot at the next run. The schedule underneath is what the figure implies,
 * redrawn as it is typed; it is derived, never stored.
 */
function RecoveryDialog({ advance, onClose, onSaved }: { advance: Advance; onClose: () => void; onSaved: () => void }) {
  const { err, setErr, fail } = useErr();
  const outstanding = Number(advance.outstanding);
  const [emi, setEmi] = useState(String(Number(advance.emiAmount)));
  const emiNum = Number(emi) || 0;
  const save = useMutation({
    mutationFn: () => api(`/api/payroll/advances/${advance.id}`, { method: "PATCH", body: { emiAmount: emiNum } }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: fail,
  });

  const schedule = useMemo(() => {
    const rows: { label: string; take: number; left: number }[] = [];
    const t = istToday();
    let y = Number(t.slice(0, 4));
    let m = Number(t.slice(5, 7));
    let left = outstanding;
    while (emiNum > 0 && left > 0.005 && rows.length < 60) {
      const take = Math.min(emiNum, left);
      left = Math.round((left - take) * 100) / 100;
      rows.push({ label: monthName(m, y), take, left });
      if (++m > 12) { m = 1; y++; }
    }
    return rows;
  }, [emiNum, outstanding]);

  const tooMuch = emiNum > outstanding + 0.005;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Recovery · {who(advance)}</DialogTitle></DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        <div className="mb-3 grid grid-cols-3 gap-2 text-[13px]">
          <div><div className="text-[11px] text-gray-500">Given</div><strong className="tabular-nums">{formatMoney(advance.amount)}</strong></div>
          <div><div className="text-[11px] text-gray-500">Recovered</div><strong className="tabular-nums">{formatMoney(Number(advance.amount) - outstanding)}</strong></div>
          <div><div className="text-[11px] text-gray-500">Outstanding</div><strong className="tabular-nums">{formatMoney(outstanding)}</strong></div>
        </div>

        <Field label="Monthly EMI" hint="What each payroll run takes. Nil skips the month.">
          <div className="flex gap-2">
            <input type="number" min={0} className="input tabular-nums" value={emi} onChange={(e) => setEmi(e.target.value)} />
            <button type="button" className="btn-secondary whitespace-nowrap" onClick={() => setEmi(String(outstanding))}>Clear full balance next run</button>
          </div>
        </Field>
        {tooMuch && <div className="mt-1 text-[12px] text-red-600">Only {formatMoney(outstanding)} is outstanding.</div>}

        <div className="mt-3 text-[12px] text-gray-500">
          {emiNum <= 0
            ? "Nothing will be recovered until an EMI is set."
            : `Clears in ${schedule.length}${schedule.length === 60 ? "+" : ""} run(s), if the pay covers it each month.`}
        </div>
        {schedule.length > 0 && (
          <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-200">
            <table className="w-full text-[12px] tabular-nums">
              <tbody>
                {schedule.map((r) => (
                  <tr key={r.label} className="border-b border-gray-100 last:border-0">
                    <td className="px-2 py-1">{r.label}</td>
                    <td className="px-2 py-1 text-right">{formatMoney(r.take)}</td>
                    <td className="px-2 py-1 text-right text-gray-500">{formatMoney(r.left)} left</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {advance.repayments.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] text-gray-500">Recovered so far</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums text-gray-600">
              {advance.repayments.map((r) => (
                <span key={r.id}>{monthName(r.month, r.year)}: {formatMoney(r.amount)}{r.payrollRunId ? "" : " (manual)"}</span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || tooMuch || emiNum < 0 || emiNum === Number(advance.emiAmount)} onClick={() => save.mutate()}>Save EMI</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
