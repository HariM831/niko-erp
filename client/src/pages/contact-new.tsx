import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

const GST_TREATMENTS = [
  ["registered_business", "Registered Business"],
  ["registered_composition", "Registered (Composition)"],
  ["unregistered_business", "Unregistered Business"],
  ["consumer", "Consumer"],
  ["overseas", "Overseas"],
  ["special_economic_zone", "Special Economic Zone"],
] as const;

export function ContactNewPage({ type }: { type: "customer" | "vendor" }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const listPath = type === "customer" ? "/sales/customers" : "/purchases/vendors";
  const [form, setForm] = useState({
    displayName: "",
    companyName: "",
    email: "",
    phone: "",
    gstTreatment: "consumer",
    gstin: "",
    pan: "",
    placeOfSupplyState: "",
    paymentTermsDays: "0",
    billingLine1: "",
    billingCity: "",
    billingState: "",
    billingPincode: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const hasAddress = form.billingLine1 || form.billingCity;
      await api("/api/contacts", {
        method: "POST",
        body: {
          type,
          displayName: form.displayName,
          companyName: form.companyName || undefined,
          email: form.email || undefined,
          phone: form.phone || undefined,
          gstTreatment: form.gstTreatment,
          gstin: form.gstin || undefined,
          pan: form.pan || undefined,
          placeOfSupplyState: form.placeOfSupplyState || undefined,
          paymentTermsDays: Number(form.paymentTermsDays) || 0,
          addresses: hasAddress
            ? [
                {
                  kind: "billing",
                  line1: form.billingLine1 || undefined,
                  city: form.billingCity || undefined,
                  state: form.billingState || undefined,
                  pincode: form.billingPincode || undefined,
                  isDefault: true,
                },
              ]
            : undefined,
        },
      });
      await qc.invalidateQueries();
      navigate(listPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded border px-2 py-1.5 text-[13px] focus:border-brand-500 focus:outline-none";
  const label = "mb-1 block text-xs font-medium text-gray-600";
  const title = type === "customer" ? "New Customer" : "New Vendor";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <button onClick={() => navigate(listPath)} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-2xl grid-cols-2 gap-4">
          <div>
            <label className={label}>Display Name *</label>
            <input value={form.displayName} onChange={set("displayName")} className={inputCls} autoFocus />
          </div>
          <div>
            <label className={label}>Company Name</label>
            <input value={form.companyName} onChange={set("companyName")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Email</label>
            <input value={form.email} onChange={set("email")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Phone</label>
            <input value={form.phone} onChange={set("phone")} className={inputCls} />
          </div>
          <div>
            <label className={label}>GST Treatment</label>
            <select value={form.gstTreatment} onChange={set("gstTreatment")} className={inputCls}>
              {GST_TREATMENTS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>GSTIN</label>
            <input value={form.gstin} onChange={set("gstin")} maxLength={15} className={inputCls} />
          </div>
          <div>
            <label className={label}>PAN</label>
            <input value={form.pan} onChange={set("pan")} maxLength={10} className={inputCls} />
          </div>
          <div>
            <label className={label}>Place of Supply (State Code)</label>
            <input value={form.placeOfSupplyState} onChange={set("placeOfSupplyState")} maxLength={4} placeholder="e.g. 29" className={inputCls} />
          </div>
          <div>
            <label className={label}>Payment Terms (days)</label>
            <input value={form.paymentTermsDays} onChange={set("paymentTermsDays")} className={inputCls} />
          </div>
          <div className="col-span-2 mt-2 border-t pt-4">
            <h2 className="mb-3 text-sm font-semibold">Billing Address</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className={label}>Street</label>
                <input value={form.billingLine1} onChange={set("billingLine1")} className={inputCls} />
              </div>
              <div>
                <label className={label}>City</label>
                <input value={form.billingCity} onChange={set("billingCity")} className={inputCls} />
              </div>
              <div>
                <label className={label}>State</label>
                <input value={form.billingState} onChange={set("billingState")} className={inputCls} />
              </div>
              <div>
                <label className={label}>Pincode</label>
                <input value={form.billingPincode} onChange={set("billingPincode")} className={inputCls} />
              </div>
            </div>
          </div>
        </div>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !form.displayName.trim()}
          className="rounded-md bg-brand-500 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          Save
        </button>
        <button onClick={() => navigate(listPath)} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
