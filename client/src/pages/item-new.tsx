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
interface Tax {
  id: string;
  name: string;
}

export function ItemNewPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    type: "goods",
    name: "",
    sku: "",
    unit: "pcs",
    hsnOrSac: "",
    sellingPrice: "",
    salesAccountId: "",
    costPrice: "",
    purchaseAccountId: "",
    taxId: "",
    trackInventory: false,
    inventoryAccountId: "",
    openingStock: "",
    reorderLevel: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const { data: taxes } = useQuery({
    queryKey: ["taxes"],
    queryFn: () => api<Tax[]>("/api/taxes"),
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const canSave = form.name.trim() && (!form.trackInventory || form.inventoryAccountId);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/items", {
        method: "POST",
        body: {
          type: form.type,
          name: form.name,
          sku: form.sku || undefined,
          unit: form.unit || undefined,
          hsnOrSac: form.hsnOrSac || undefined,
          sellingPrice: form.sellingPrice ? Number(form.sellingPrice).toFixed(2) : undefined,
          salesAccountId: form.salesAccountId || undefined,
          costPrice: form.costPrice ? Number(form.costPrice).toFixed(2) : undefined,
          purchaseAccountId: form.purchaseAccountId || undefined,
          taxId: form.taxId || undefined,
          trackInventory: form.trackInventory,
          inventoryAccountId: form.trackInventory ? form.inventoryAccountId || undefined : undefined,
          openingStock: form.trackInventory && form.openingStock ? Number(form.openingStock).toFixed(3) : undefined,
          reorderLevel: form.trackInventory && form.reorderLevel ? Number(form.reorderLevel).toFixed(3) : undefined,
        },
      });
      await qc.invalidateQueries();
      navigate("/items");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded border px-2 py-1.5 text-[13px] focus:border-brand-500 focus:outline-none";
  const label = "mb-1 block text-xs font-medium text-gray-600";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">New Item</h1>
        <button onClick={() => navigate("/items")} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-2xl grid-cols-2 gap-4">
          <div>
            <label className={label}>Type</label>
            <select value={form.type} onChange={set("type")} className={inputCls}>
              <option value="goods">Goods</option>
              <option value="service">Service</option>
            </select>
          </div>
          <div>
            <label className={label}>Name *</label>
            <input value={form.name} onChange={set("name")} className={inputCls} autoFocus />
          </div>
          <div>
            <label className={label}>SKU</label>
            <input value={form.sku} onChange={set("sku")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Unit</label>
            <input value={form.unit} onChange={set("unit")} className={inputCls} />
          </div>
          <div>
            <label className={label}>HSN / SAC</label>
            <input value={form.hsnOrSac} onChange={set("hsnOrSac")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Tax</label>
            <select value={form.taxId} onChange={set("taxId")} className={inputCls}>
              <option value="">No default tax</option>
              {taxes?.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2 mt-2 grid grid-cols-2 gap-4 border-t pt-4">
            <div>
              <h2 className="mb-3 text-sm font-semibold">Sales Information</h2>
              <label className={label}>Selling Price</label>
              <input value={form.sellingPrice} onChange={set("sellingPrice")} placeholder="0.00" className={inputCls} />
              <label className={`${label} mt-3`}>Sales Account</label>
              <select value={form.salesAccountId} onChange={set("salesAccountId")} className={inputCls}>
                <option value="">Default (Sales Revenue)</option>
                {accounts
                  ?.filter((a) => a.type === "income")
                  .map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
              </select>
            </div>
            <div>
              <h2 className="mb-3 text-sm font-semibold">Purchase Information</h2>
              <label className={label}>Cost Price</label>
              <input value={form.costPrice} onChange={set("costPrice")} placeholder="0.00" className={inputCls} />
              <label className={`${label} mt-3`}>Purchase Account</label>
              <select value={form.purchaseAccountId} onChange={set("purchaseAccountId")} className={inputCls}>
                <option value="">None</option>
                {accounts
                  ?.filter((a) => a.type === "expense" || a.type === "asset")
                  .map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
              </select>
            </div>
          </div>
          <div className="col-span-2 mt-2 border-t pt-4">
            <label className="flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={form.trackInventory}
                onChange={(e) => setForm((f) => ({ ...f, trackInventory: e.target.checked }))}
                className="h-4 w-4 accent-brand-500"
              />
              <span className="text-sm font-semibold">Track inventory for this item</span>
            </label>
            <p className="ml-6 mt-0.5 text-xs text-gray-500">
              Stock levels are maintained and an inventory asset account is required.
            </p>
            {form.trackInventory && (
              <div className="ml-6 mt-3 grid grid-cols-3 gap-4">
                <div>
                  <label className="label">Inventory Account *</label>
                  <select value={form.inventoryAccountId} onChange={set("inventoryAccountId")} className={inputCls}>
                    <option value="">Select account…</option>
                    {accounts
                      ?.filter((a) => a.type === "asset")
                      .map((a) => (
                        <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="label">Opening Stock</label>
                  <input value={form.openingStock} onChange={set("openingStock")} placeholder="0" className={inputCls} />
                </div>
                <div>
                  <label className="label">Reorder Level</label>
                  <input value={form.reorderLevel} onChange={set("reorderLevel")} placeholder="0" className={inputCls} />
                </div>
              </div>
            )}
          </div>
        </div>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !canSave}
          className="rounded-md bg-brand-500 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          Save
        </button>
        <button onClick={() => navigate("/items")} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
