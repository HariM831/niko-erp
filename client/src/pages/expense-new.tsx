import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { PendingAttachments, uploadPending } from "../components/pending-attachments";
import { CustomFieldsBlock, type CustomFieldValues } from "../components/custom-fields";

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
interface TagOption {
  id: string;
  name: string;
  isActive: boolean;
}
interface ReportingTag {
  id: string;
  name: string;
  isActive: boolean;
  options: TagOption[];
}

interface Tax {
  id: string;
  name: string;
}

export function ExpenseNewPage({ editId }: { editId?: string } = {}) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const presetBankAccountId = new URLSearchParams(search).get("bankAccountId") ?? "";
  const qc = useQueryClient();
  const [form, setForm] = useState({
    expenseDate: new Date().toISOString().slice(0, 10),
    expenseAccountId: "",
    paidThroughId: presetBankAccountId,
    vendorId: "",
    amount: "",
    taxId: "",
    reference: "",
    notes: "",
  });
  /** Chosen option per tag — one select each, so two vehicles cannot both be picked. */
  const [lineTags, setLineTags] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldValues>({});

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
  const { data: allTags } = useQuery({
    queryKey: ["reporting-tags"],
    queryFn: () => api<ReportingTag[]>("/api/reporting-tags"),
  });
  const tags = (allTags ?? [])
    .filter((t) => t.isActive)
    .map((t) => ({ ...t, options: t.options.filter((o) => o.isActive) }))
    .filter((t) => t.options.length > 0);

  const { data: existing } = useQuery({
    queryKey: ["expense", editId],
    queryFn: () => api<Record<string, unknown>>(`/api/purchases/expenses/${editId}`),
    enabled: !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    const str = (k: string) => (existing[k] as string | null) ?? "";
    setForm({
      expenseDate: str("expenseDate"),
      expenseAccountId: str("expenseAccountId"),
      paidThroughId: str("paidThroughId"),
      vendorId: str("vendorId"),
      amount: existing.amount ? String(Number(existing.amount)) : "",
      taxId: str("taxId"),
      reference: str("reference"),
      notes: str("notes"),
    });
    setLineTags(
      Object.fromEntries(
        ((existing.tags ?? []) as Array<{ tagId: string; optionId: string }>).map((t) => [
          t.tagId,
          t.optionId,
        ]),
      ),
    );
  }, [existing]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = (await api(editId ? `/api/purchases/expenses/${editId}` : "/api/purchases/expenses", {
        method: editId ? "PATCH" : "POST",
        body: {
          expenseDate: form.expenseDate,
          expenseAccountId: form.expenseAccountId,
          paidThroughId: form.paidThroughId,
          vendorId: form.vendorId || undefined,
          amount: Number(form.amount).toFixed(2),
          taxId: form.taxId || undefined,
          reference: form.reference || undefined,
          notes: form.notes || undefined,
          tagOptionIds: Object.values(lineTags).filter(Boolean),
        },
      })) as { id: string };
      if (pendingFiles.length && created?.id) {
        const failed = await uploadPending("expense", created.id, pendingFiles);
        if (failed.length) setError(`Saved, but files failed: ${failed.join(", ")}`);
      }
      await qc.invalidateQueries();
      navigate(editId ? `/purchases/expenses/${editId}` : "/purchases/expenses");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";
  const label = "label";
  const backPath = editId ? `/purchases/expenses/${editId}` : "/purchases/expenses";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">{editId ? "Edit Expense" : "Record Expense"}</h1>
        <button onClick={() => navigate(backPath)} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-2xl grid-cols-2 gap-4">
          <div>
            <label className="label-required">Date *</label>
            <input type="date" value={form.expenseDate} onChange={set("expenseDate")} className={inputCls} />
          </div>
          <div>
            <label className="label-required">Amount *</label>
            <input value={form.amount} onChange={set("amount")} placeholder="0.00" className={inputCls} />
          </div>
          <div>
            <label className="label-required">Expense Account *</label>
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
            <label className="label-required">Paid Through *</label>
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
          {tags.map((t) => (
            <div key={t.id}>
              <label className={label}>{t.name}</label>
              <select
                value={lineTags[t.id] ?? ""}
                onChange={(e) => setLineTags((m) => ({ ...m, [t.id]: e.target.value }))}
                className={inputCls}
              >
                <option value="">—</option>
                {t.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="col-span-2">
            <label className={label}>Notes</label>
            <textarea value={form.notes} onChange={set("notes")} rows={2} className={inputCls} />
          </div>
          <div className="col-span-2">
            <CustomFieldsBlock
              entity="expense"
              value={customFields}
              onChange={setCustomFields}
              columns={2}
            />
          </div>
          <div className="col-span-2">
            <PendingAttachments files={pendingFiles} onChange={setPendingFiles} label="Attach Receipt(s)" />
          </div>
        </div>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !form.expenseDate || !form.expenseAccountId || !form.paidThroughId || Number(form.amount) <= 0}
          className="btn-primary"
        >
          {editId ? "Save Changes" : "Save Expense"}
        </button>
        <button onClick={() => navigate(backPath)} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
