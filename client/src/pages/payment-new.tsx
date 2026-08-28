import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";

interface Contact {
  id: string;
  displayName: string;
}
interface OpenDoc {
  id: string;
  number: string;
  balanceDue: string;
  dueDate: string;
}
interface BankAccount {
  id: string;
  name: string;
}

const MODES = ["bank_transfer", "cash", "upi", "cheque", "card"] as const;

/**
 * Zoho-style payment recording with open-item application: pick the party,
 * see their open documents, allocate the amount line by line.
 */
export function PaymentNewPage({ side, editId }: { side: "customer" | "vendor"; editId?: string }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const presetBankAccountId = params.get("bankAccountId") ?? "";
  const presetContactId = params.get("contactId") ?? "";
  const presetDocId = params.get("docId") ?? "";
  const qc = useQueryClient();
  const isCustomer = side === "customer";
  const listPath = isCustomer ? "/sales/payments" : "/purchases/payments";
  const endpoint = isCustomer ? "/api/sales/payments" : "/api/purchases/payments";

  const [contactId, setContactId] = useState(presetContactId);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [tds, setTds] = useState("");
  const [mode, setMode] = useState<string>("bank_transfer");
  const [bankAccountId, setBankAccountId] = useState(presetBankAccountId);
  const [reference, setReference] = useState("");
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [presetApplied, setPresetApplied] = useState(false);

  const { data: contacts } = useQuery({
    queryKey: ["contacts", side],
    queryFn: () => api<Contact[]>(`/api/contacts?type=${isCustomer ? "customer" : "vendor"}&isActive=true`),
  });
  const { data: banks } = useQuery({
    queryKey: ["bank-accounts"],
    queryFn: () => api<BankAccount[]>("/api/banking/accounts"),
  });

  const openEndpoint = isCustomer
    ? `/api/sales/invoices?customerId=${contactId}`
    : `/api/purchases/bills?vendorId=${contactId}`;
  const { data: allDocs } = useQuery({
    queryKey: ["open-docs", side, contactId],
    queryFn: () => api<Array<OpenDoc & { status: string }>>(openEndpoint),
    enabled: !!contactId,
  });
  // When editing, this payment may have closed the very documents it paid, so keep
  // those visible alongside the still-open ones or you couldn't change the split.
  const appliedDocIds = new Set(Object.keys(applied));
  const openDocs = allDocs?.filter(
    (d) =>
      appliedDocIds.has(d.id) ||
      (isCustomer
        ? d.status === "sent" || d.status === "partially_paid"
        : d.status === "open" || d.status === "partially_paid"),
  );

  const { data: existing } = useQuery({
    queryKey: ["payment", side, editId],
    queryFn: () =>
      api<Record<string, string> & { applications: Array<{ invoiceId?: string; billId?: string; amountApplied: string }> }>(
        `${endpoint}/${editId}`,
      ),
    enabled: !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    const loadedContactId = (existing.customerId ?? existing.vendorId) as string;
    prevContactId.current = loadedContactId; // pre-seed so the clear-on-change effect skips this
    setContactId(loadedContactId);
    setDate(existing.paymentDate ?? date);
    setAmount(String(Number(existing.amount)));
    setTds(existing.tdsAmount && Number(existing.tdsAmount) > 0 ? String(Number(existing.tdsAmount)) : "");
    setMode(existing.mode ?? "bank_transfer");
    setBankAccountId(existing.bankAccountId ?? "");
    setReference(existing.reference ?? "");
    setApplied(
      Object.fromEntries(
        existing.applications.map((a) => [(a.invoiceId ?? a.billId) as string, String(Number(a.amountApplied))]),
      ),
    );
    setPresetApplied(true);
  }, [existing]);

  useEffect(() => {
    if (presetApplied || !presetDocId || !openDocs?.length) return;
    const doc = openDocs.find((d) => d.id === presetDocId);
    if (doc) {
      setApplied({ [doc.id]: doc.balanceDue });
      setAmount(doc.balanceDue);
    }
    setPresetApplied(true);
  }, [openDocs, presetDocId, presetApplied]);

  // Switching party invalidates the split — but don't wipe what an edit just loaded.
  const prevContactId = useRef(contactId);
  useEffect(() => {
    if (prevContactId.current !== contactId) {
      prevContactId.current = contactId;
      setApplied({});
    }
  }, [contactId]);

  const totalApplied = Object.values(applied).reduce((s, v) => s + Number(v || 0), 0);
  const unapplied = Number(amount || 0) - totalApplied;

  /** Auto-allocate the amount oldest-first, Zoho's "pay in full" behaviour. */
  const autoApply = () => {
    let remaining = Number(amount || 0);
    const next: Record<string, string> = {};
    for (const doc of openDocs ?? []) {
      if (remaining <= 0) break;
      const due = Number(doc.balanceDue);
      const take = Math.min(remaining, due);
      next[doc.id] = take.toFixed(2);
      remaining -= take;
    }
    setApplied(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const applications = Object.entries(applied)
        .filter(([, v]) => Number(v) > 0)
        .map(([id, v]) => ({ [isCustomer ? "invoiceId" : "billId"]: id, amount: Number(v).toFixed(2) }));
      const body: Record<string, unknown> = {
        [isCustomer ? "customerId" : "vendorId"]: contactId,
        paymentDate: date,
        amount: Number(amount).toFixed(2),
        mode,
        bankAccountId,
        reference: reference || undefined,
        applications,
      };
      if (!isCustomer && Number(tds) > 0) body.tdsAmount = Number(tds).toFixed(2);
      await api(editId ? `${endpoint}/${editId}` : endpoint, { method: editId ? "PATCH" : "POST", body });
      await qc.invalidateQueries();
      navigate(editId ? `${listPath}/${editId}` : listPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";
  const backPath = editId ? `${listPath}/${editId}` : listPath;
  const title = editId
    ? `Edit ${isCustomer ? "Payment Received" : "Payment Made"}`
    : isCustomer
      ? "Record Payment Received"
      : "Record Payment Made";

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        <button onClick={() => navigate(backPath)} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-6 grid max-w-3xl grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className="label-required">
              {isCustomer ? "Customer" : "Vendor"} *
            </label>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={inputCls}>
              <option value="">Select…</option>
              {contacts?.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-required">Payment Date *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="label-required">Amount *</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={inputCls} />
          </div>
          {!isCustomer && (
            <div>
              <label className="label">TDS Withheld</label>
              <input value={tds} onChange={(e) => setTds(e.target.value)} placeholder="0.00" className={inputCls} />
            </div>
          )}
          <div>
            <label className="label">Mode</label>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}>
              {MODES.map((m) => (
                <option key={m} value={m}>{m.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-required">
              {isCustomer ? "Deposit To" : "Paid Through"} *
            </label>
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className={inputCls}>
              <option value="">Select account…</option>
              {banks?.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Reference #</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
          </div>
        </div>

        {contactId && (
          <div className="max-w-3xl">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                Open {isCustomer ? "Invoices" : "Bills"} ({openDocs?.length ?? 0})
              </h2>
              <button onClick={autoApply} disabled={!amount} className="text-[13px] font-medium text-brand-600 hover:underline disabled:opacity-50">
                Auto-apply oldest first
              </button>
            </div>
            {!openDocs?.length ? (
              <p className="rounded border border-dashed p-4 text-sm text-gray-500">
                Nothing open — the full amount will be recorded as an advance.
              </p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="table-head">
                  <tr>
                    <th className="border border-[#ece3d5] px-3 py-2">Number</th>
                    <th className="border border-[#ece3d5] px-3 py-2">Due Date</th>
                    <th className="border border-[#ece3d5] px-3 py-2 text-right">Balance Due</th>
                    <th className="w-36 border border-[#ece3d5] px-3 py-2 text-right">Payment</th>
                  </tr>
                </thead>
                <tbody>
                  {openDocs.map((d) => (
                    <tr key={d.id}>
                      <td className="border border-[#ece3d5] px-3 py-2 font-medium text-brand-600">{d.number}</td>
                      <td className="border border-[#ece3d5] px-3 py-2">{formatDate(d.dueDate)}</td>
                      <td className="border border-[#ece3d5] px-3 py-2 text-right tabular-nums">{formatMoney(d.balanceDue)}</td>
                      <td className="border border-[#ece3d5] px-1 py-1">
                        <input
                          value={applied[d.id] ?? ""}
                          onChange={(e) => setApplied((a) => ({ ...a, [d.id]: e.target.value }))}
                          placeholder="0.00"
                          className="input py-1 text-right tabular-nums"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-3 flex justify-end gap-8 text-[13px]">
              <span>
                Applied: <strong className="tabular-nums">{formatMoney(totalApplied)}</strong>
              </span>
              <span className={unapplied < 0 ? "text-red-600" : ""}>
                {unapplied < 0 ? "Over-applied by" : "Unapplied"}:{" "}
                <strong className="tabular-nums">{formatMoney(Math.abs(unapplied))}</strong>
              </span>
            </div>
          </div>
        )}

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>

      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !date || !contactId || !bankAccountId || Number(amount) <= 0 || unapplied < 0}
          className="btn-primary"
        >
          {editId ? "Save Changes" : "Record Payment"}
        </button>
        <button onClick={() => navigate(backPath)} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
