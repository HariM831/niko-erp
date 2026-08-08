import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, formatMoney } from "../api";

interface Contact {
  id: string;
  displayName: string;
  paymentTermsDays: number;
}
interface Item {
  id: string;
  name: string;
  unit: string;
  sellingPrice?: string;
  costPrice?: string;
  taxId?: string;
  hsnOrSac?: string;
}
interface Tax {
  id: string;
  name: string;
  rate: string;
}
interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface FormLine {
  itemId?: string;
  accountId?: string;
  name: string;
  quantity: string;
  unit?: string;
  rate: string;
  discountPercent: string;
  taxId?: string;
}

const emptyLine = (): FormLine => ({ name: "", quantity: "1", rate: "0", discountPercent: "0" });

export interface TransactionFormConfig {
  title: string;
  endpoint: string;
  listPath: string;
  contactType: "customer" | "vendor";
  contactLabel: string;
  dateField: string;
  dateLabel: string;
  /** Show per-line expense account column (bills, vendor credits). */
  withAccountColumn?: boolean;
  /** Offer "Save and Send" (invoices) in addition to draft. */
  withSend?: boolean;
  extraBody?: Record<string, unknown>;
}

/** Zoho Books-style transaction entry: header, line-item grid, totals panel. */
export function TransactionForm({ config }: { config: TransactionFormConfig }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [contactId, setContactId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: contacts } = useQuery({
    queryKey: ["contacts", config.contactType],
    queryFn: () => api<Contact[]>(`/api/contacts?type=${config.contactType}&isActive=true`),
  });
  const { data: items } = useQuery({
    queryKey: ["items-active"],
    queryFn: () => api<Item[]>("/api/items?isActive=true"),
  });
  const { data: taxes } = useQuery({
    queryKey: ["taxes"],
    queryFn: () => api<Tax[]>("/api/taxes"),
  });
  const { data: accounts } = useQuery({
    queryKey: ["accounts-expense"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
    enabled: !!config.withAccountColumn,
  });

  const taxRate = (id?: string) => Number(taxes?.find((t) => t.id === id)?.rate ?? 0);

  /** Client-side preview only — the server recomputes authoritatively. */
  const totals = useMemo(() => {
    let sub = 0;
    let disc = 0;
    let tax = 0;
    for (const l of lines) {
      const gross = Number(l.quantity || 0) * Number(l.rate || 0);
      const d = (gross * Number(l.discountPercent || 0)) / 100;
      sub += gross;
      disc += d;
      tax += ((gross - d) * taxRate(l.taxId)) / 100;
    }
    const raw = sub - disc + tax;
    const rounded = Math.round(raw);
    return { sub, disc, tax, roundOff: rounded - raw, total: rounded };
  }, [lines, taxes]);

  const updateLine = (i: number, patch: Partial<FormLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const pickItem = (i: number, itemId: string) => {
    const item = items?.find((it) => it.id === itemId);
    if (!item) return updateLine(i, { itemId: undefined });
    updateLine(i, {
      itemId,
      name: item.name,
      unit: item.unit,
      rate:
        (config.contactType === "customer" ? item.sellingPrice : item.costPrice) ??
        item.sellingPrice ??
        "0",
      taxId: item.taxId,
    });
  };

  const save = async (saveAs?: "draft" | "sent") => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        [config.contactType === "customer" ? "customerId" : "vendorId"]: contactId,
        [config.dateField]: date,
        reference: reference || undefined,
        lines: lines
          .filter((l) => l.name.trim())
          .map((l) => ({
            itemId: l.itemId || undefined,
            accountId: l.accountId || undefined,
            name: l.name,
            quantity: l.quantity,
            unit: l.unit || undefined,
            rate: l.rate,
            discountPercent: l.discountPercent || undefined,
            taxId: l.taxId || undefined,
          })),
        ...config.extraBody,
      };
      if (notes) body.customerNotes = notes;
      if (saveAs) body.saveAs = saveAs;
      await api(config.endpoint, { method: "POST", body });
      await qc.invalidateQueries();
      navigate(config.listPath);
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setError(err.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
      } else {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">{config.title}</h1>
        <button onClick={() => navigate(config.listPath)} className="text-xl text-gray-400 hover:text-gray-700">
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-5 grid max-w-3xl grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className="label">
              {config.contactLabel} *
            </label>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={inputCls}>
              <option value="">Select {config.contactLabel.toLowerCase()}…</option>
              {contacts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">{config.dateLabel} *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="label">Reference</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
          </div>
        </div>

        <table className="mb-3 w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="w-56 border px-2 py-2">Item</th>
              <th className="border px-2 py-2">Details</th>
              {config.withAccountColumn && <th className="w-44 border px-2 py-2">Account</th>}
              <th className="w-20 border px-2 py-2">Qty</th>
              <th className="w-28 border px-2 py-2">Rate</th>
              <th className="w-20 border px-2 py-2">Disc %</th>
              <th className="w-32 border px-2 py-2">Tax</th>
              <th className="w-28 border px-2 py-2 text-right">Amount</th>
              <th className="w-8 border" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const gross = Number(l.quantity || 0) * Number(l.rate || 0);
              const net = gross - (gross * Number(l.discountPercent || 0)) / 100;
              return (
                <tr key={i}>
                  <td className="border px-1 py-1">
                    <select value={l.itemId ?? ""} onChange={(e) => pickItem(i, e.target.value)} className={inputCls}>
                      <option value="">— manual —</option>
                      {items?.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border px-1 py-1">
                    <input
                      value={l.name}
                      onChange={(e) => updateLine(i, { name: e.target.value })}
                      placeholder="Description"
                      className={inputCls}
                    />
                  </td>
                  {config.withAccountColumn && (
                    <td className="border px-1 py-1">
                      <select
                        value={l.accountId ?? ""}
                        onChange={(e) => updateLine(i, { accountId: e.target.value || undefined })}
                        className={inputCls}
                      >
                        <option value="">Item default</option>
                        {accounts
                          ?.filter((a) => a.type === "expense" || a.type === "asset")
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                      </select>
                    </td>
                  )}
                  <td className="border px-1 py-1">
                    <input value={l.quantity} onChange={(e) => updateLine(i, { quantity: e.target.value })} className={inputCls} />
                  </td>
                  <td className="border px-1 py-1">
                    <input value={l.rate} onChange={(e) => updateLine(i, { rate: e.target.value })} className={inputCls} />
                  </td>
                  <td className="border px-1 py-1">
                    <input
                      value={l.discountPercent}
                      onChange={(e) => updateLine(i, { discountPercent: e.target.value })}
                      className={inputCls}
                    />
                  </td>
                  <td className="border px-1 py-1">
                    <select value={l.taxId ?? ""} onChange={(e) => updateLine(i, { taxId: e.target.value || undefined })} className={inputCls}>
                      <option value="">No tax</option>
                      {taxes?.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border px-2 py-1 text-right tabular-nums">{formatMoney(net)}</td>
                  <td className="border text-center">
                    {lines.length > 1 && (
                      <button
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                        className="text-gray-400 hover:text-red-600"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button
          onClick={() => setLines((ls) => [...ls, emptyLine()])}
          className="mb-6 text-[13px] font-medium text-brand-600 hover:underline"
        >
          + Add another line
        </button>

        <div className="flex max-w-5xl items-start justify-between gap-8">
          <div className="flex-1">
            <label className="label">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputCls} />
          </div>
          <div className="w-80 rounded-xl border border-gray-200/80 bg-gray-50/80 p-5 text-[13px] shadow-[0_1px_3px_rgba(16,24,40,0.05)]">
            <div className="mb-1.5 flex justify-between">
              <span>Sub Total</span>
              <span className="tabular-nums">{formatMoney(totals.sub)}</span>
            </div>
            {totals.disc > 0 && (
              <div className="mb-1.5 flex justify-between text-gray-600">
                <span>Discount</span>
                <span className="tabular-nums">− {formatMoney(totals.disc)}</span>
              </div>
            )}
            <div className="mb-1.5 flex justify-between">
              <span>Tax</span>
              <span className="tabular-nums">{formatMoney(totals.tax)}</span>
            </div>
            <div className="mb-2 flex justify-between text-gray-600">
              <span>Round Off</span>
              <span className="tabular-nums">{totals.roundOff >= 0 ? "" : "− "}{formatMoney(Math.abs(totals.roundOff))}</span>
            </div>
            <div className="flex justify-between border-t pt-2 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(totals.total)}</span>
            </div>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>

      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save(config.withSend ? "draft" : undefined)}
          disabled={busy || !contactId}
          className="btn-secondary"
        >
          Save as Draft
        </button>
        {config.withSend && (
          <button
            onClick={() => void save("sent")}
            disabled={busy || !contactId}
            className="btn-primary"
          >
            Save and Send
          </button>
        )}
        <button onClick={() => navigate(config.listPath)} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
