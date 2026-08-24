/**
 * Pay inputs — bonus, overtime, reimbursement and deduction in ONE table
 * (Amino had four pages; the four kinds differ only in two form fields).
 * Approved rows are picked up by the month's payroll run and marked paid.
 *
 * Below it, Advances: money already handed over, recovered EMI-first by the
 * run, with a manual repayment path for cash paid back outside payroll.
 */
import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, formatMoney } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Badge, Empty, EmployeeSelect, ErrorBanner, Field, MonthPicker, PageHeader, Pager, Spinner, Td, Th, dmy, istToday,
  num, statusTone, useErr, useMonth, usePaged,
} from "../../components/payroll/ui";

type Kind = "bonus" | "overtime" | "reimbursement" | "deduction";
const KINDS: Kind[] = ["bonus", "overtime", "reimbursement", "deduction"];
const KIND_LABEL: Record<Kind, string> = { bonus: "Bonus", overtime: "Overtime", reimbursement: "Reimbursement", deduction: "Deduction" };
const BONUS_CATEGORIES = ["festival", "performance", "referral", "retention", "other"];
const EXPENSE_CATEGORIES = ["travel", "food", "accommodation", "communication", "medical", "other"];

interface PayInput {
  id: string;
  employeeId: string;
  employeeName?: string;
  employee?: { name: string; empCode: string };
  kind: Kind;
  month: number;
  year: number;
  amount: number | string;
  hours: number | null;
  ratePerHour: number | string | null;
  category: string | null;
  description: string | null;
  status: "pending" | "approved" | "rejected" | "paid";
  approvedAmount: number | string | null;
}
interface Advance {
  id: string;
  employeeId: string;
  employeeName?: string;
  employee?: { name: string; empCode: string };
  type: "salary_advance" | "loan";
  amount: number | string;
  emiAmount: number | string;
  givenOn: string;
  reason: string | null;
  status: "active" | "closed" | "cancelled";
  outstanding: number | string;
  repayments: { id: string; amount: number | string; month: number; year: number; notes: string | null; payrollRunId: string | null }[];
}

const who = (r: { employeeName?: string; employee?: { name: string } }) => r.employeeName ?? r.employee?.name ?? "—";

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
    const t: Record<Kind, number> = { bonus: 0, overtime: 0, reimbursement: 0, deduction: 0 };
    for (const r of rows) if (r.status === "approved" || r.status === "paid") t[r.kind] += Number(r.approvedAmount ?? r.amount);
    return t;
  }, [rows]);

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Pay inputs" sub="Bonus, overtime, reimbursement and deduction — approved rows flow into the month's run.">
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
          Approved: +{formatMoney(totals.bonus + totals.overtime + totals.reimbursement)} · −{formatMoney(totals.deduction)}
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
                  <Td className="font-medium">{who(r)}</Td>
                  <Td><Badge tone={r.kind === "deduction" ? "red" : "blue"}>{KIND_LABEL[r.kind]}</Badge></Td>
                  <Td className="max-w-[280px] truncate" title={r.description ?? undefined}>
                    {r.kind === "overtime" && r.hours != null && <span className="tabular-nums">{num(r.hours, 1)} h × {formatMoney(r.ratePerHour ?? 0)} · </span>}
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
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

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
        hours: form.kind === "overtime" ? Number(form.hours) || 0 : null,
        ratePerHour: form.kind === "overtime" ? Number(form.ratePerHour) || 0 : null,
        category: form.kind === "bonus" || form.kind === "reimbursement" ? form.category || null : null,
        description: form.description.trim() || null,
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
            <EmployeeSelect value={form.employeeId} onChange={(v) => set("employeeId", v)} />
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
          <button className="btn-primary" disabled={save.isPending || !form.employeeId || amount <= 0} onClick={() => save.mutate()}>Add</button>
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
  const [repayFor, setRepayFor] = useState<Advance | null>(null);
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
                    <Td className="font-medium">{who(a)}</Td>
                    <Td>{a.type === "loan" ? "Loan" : "Salary advance"}{a.reason && <span className="ml-1 text-[11px] text-gray-400">{a.reason}</span>}</Td>
                    <Td className="tabular-nums">{dmy(a.givenOn)}</Td>
                    <Td right>{formatMoney(a.amount)}</Td>
                    <Td right>{formatMoney(a.emiAmount)}</Td>
                    <Td right className="font-semibold">{formatMoney(a.outstanding)}</Td>
                    <Td><Badge tone={statusTone(a.status)}>{a.status}</Badge></Td>
                    <Td right onClick={undefined}>
                      {a.status === "active" && (
                        <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <button className="btn-ghost" onClick={() => setRepayFor(a)}>Repay</button>
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
      {repayFor && <RepayDialog advance={repayFor} onClose={() => setRepayFor(null)} onSaved={invalidate} />}
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
        <p className="mb-2 text-[12px] text-gray-500">
          This records the advance for recovery. The cash itself goes out through a normal payment or expense the accountant books.
        </p>
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

function RepayDialog({ advance, onClose, onSaved }: { advance: Advance; onClose: () => void; onSaved: () => void }) {
  const { err, setErr, fail } = useErr();
  const t = istToday();
  const [form, setForm] = useState({ amount: "", month: Number(t.slice(5, 7)), year: Number(t.slice(0, 4)), notes: "" });
  const save = useMutation({
    mutationFn: () => api(`/api/payroll/advances/${advance.id}/repay`, {
      method: "POST",
      body: { amount: Number(form.amount), month: form.month, year: form.year, notes: form.notes.trim() || null },
    }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: fail,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Manual repayment · {who(advance)}</DialogTitle></DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        <div className="mb-2 text-[13px] text-gray-600">Outstanding <strong className="tabular-nums">{formatMoney(advance.outstanding)}</strong></div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Amount" required className="col-span-3">
            <input type="number" className="input tabular-nums" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Month">
            <input type="number" min={1} max={12} className="input tabular-nums" value={form.month} onChange={(e) => setForm({ ...form, month: Number(e.target.value) })} />
          </Field>
          <Field label="Year">
            <input type="number" className="input tabular-nums" value={form.year} onChange={(e) => setForm({ ...form, year: Number(e.target.value) })} />
          </Field>
          <Field label="Notes" className="col-span-3">
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. paid in cash" />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || !(Number(form.amount) > 0)} onClick={() => save.mutate()}>Record repayment</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
