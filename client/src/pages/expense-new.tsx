import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}
interface BankAccount {
  id: string;
  name: string;
}
interface Contact {
  id: string;
  displayName: string;
}
interface Tax {
  id: string;
  name: string;
}

export function ExpenseNewPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    expenseDate: new Date().toISOString().slice(0, 10),
    expenseAccountId: "",
    paidThroughId: "",
    vendorId: "",
    amount: "",
    taxId: "",
    reference: "",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const { data: banks } = useQuery({
    queryKey: ["bank-accounts"],
    queryFn: () => api<BankAccount[]>("/api/banking/accounts"),
  });
  const { data: vendors } = useQuery({
    queryKey: ["contacts", "vendor"],
    queryFn: () => api<Contact[]>("/api/contacts?type=vendor&isActive=true"),
  });
  const { data: taxes } = useQuery({
    queryKey: ["taxes"],
    queryFn: () => api<Tax[]>("/api/taxes"),
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/purchases/expenses", {
        method: "POST",
        body: {
          expenseDate: form.expenseDate,
          expenseAccountId: form.expenseAccountId,
          paidThroughId: form.paidThroughId,
          vendorId: form.vendorId || undefined,
          amount: Number(form.amount).toFixed(2),
          taxId: form.taxId || undefined,
          reference: form.reference || undefined,
          notes: form.notes || undefined,
        },
      });
      await qc.invalidateQueries();
      navigate("/purchases/expenses");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";
  const label = "label";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Record Expense</h1>
        <button onClick={() => navigate("/purchases/expenses")} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-2xl grid-cols-2 gap-4">
          <div>
            <label className={label}>Date *</label>
            <input type="date" value={form.expenseDate} onChange={set("expenseDate")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Amount *</label>
            <input value={form.amount} onChange={set("amount")} placeholder="0.00" className={inputCls} />
          </div>
          <div>
            <label className={label}>Expense Account *</label>
            <select value={form.expenseAccountId} onChange={set("expenseAccountId")} className={inputCls}>
              <option value="">Select account…</option>
              {accounts
                ?.filter((a) => a.type === "expense")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className={label}>Paid Through *</label>
            <select value={form.paidThroughId} onChange={set("paidThroughId")} className={inputCls}>
              <option value="">Select account…</option>
              {banks?.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Vendor</label>
            <select value={form.vendorId} onChange={set("vendorId")} className={inputCls}>
              <option value="">None</option>
              {vendors?.map((v) => (
                <option key={v.id} value={v.id}>{v.displayName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Tax</label>
            <select value={form.taxId} onChange={set("taxId")} className={inputCls}>
              <option value="">No tax</option>
              {taxes?.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Reference</label>
            <input value={form.reference} onChange={set("reference")} className={inputCls} />
          </div>
          <div className="col-span-2">
            <label className={label}>Notes</label>
            <textarea value={form.notes} onChange={set("notes")} rows={2} className={inputCls} />
          </div>
        </div>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !form.expenseAccountId || !form.paidThroughId || Number(form.amount) <= 0}
          className="btn-primary"
        >
          Save Expense
        </button>
        <button onClick={() => navigate("/purchases/expenses")} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
