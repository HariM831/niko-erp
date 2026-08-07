import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate } from "../api";

type Section = "org" | "taxes" | "series" | "financial-years";

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: "org", label: "Organisation Profile" },
  { key: "taxes", label: "Taxes" },
  { key: "series", label: "Document Numbering" },
  { key: "financial-years", label: "Financial Years & Locking" },
];

export function SettingsPage() {
  const [active, setActive] = useState<Section>("org");
  return (
    <div className="flex h-full">
      <aside className="w-60 border-r bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">Settings</h2>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActive(s.key)}
            className={`block w-full rounded px-2 py-1.5 text-left text-[13px] ${
              active === s.key ? "bg-brand-50 font-medium text-brand-700" : "hover:bg-gray-50"
            }`}
          >
            {s.label}
          </button>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto p-6">
        {active === "org" && <OrgSection />}
        {active === "taxes" && <TaxesSection />}
        {active === "series" && <SeriesSection />}
        {active === "financial-years" && <FinancialYearsSection />}
      </div>
    </div>
  );
}

const inputCls = "w-full rounded border px-2 py-1.5 text-[13px] focus:border-brand-500 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-600";

function OrgSection() {
  const qc = useQueryClient();
  const { data: org } = useQuery({
    queryKey: ["org"],
    queryFn: () => api<Record<string, string | null> | null>("/api/settings/org"),
  });
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (org) {
      setForm({
        name: org.name ?? "",
        gstin: org.gstin ?? "",
        pan: org.pan ?? "",
        stateCode: org.stateCode ?? "",
        phone: org.phone ?? "",
        email: org.email ?? "",
        address: org.address ?? "",
        city: org.city ?? "",
        state: org.state ?? "",
        pincode: org.pincode ?? "",
      });
    }
  }, [org]);

  const set = (k: string) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const save = async () => {
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
      await api("/api/settings/org", { method: "PATCH", body });
      await qc.invalidateQueries({ queryKey: ["org"] });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const fields: Array<[string, string]> = [
    ["name", "Business Name *"],
    ["gstin", "GSTIN"],
    ["pan", "PAN"],
    ["stateCode", "State Code (place of supply)"],
    ["phone", "Phone"],
    ["email", "Email"],
    ["address", "Address"],
    ["city", "City"],
    ["state", "State"],
    ["pincode", "Pincode"],
  ];

  return (
    <div className="max-w-xl">
      <h1 className="mb-4 text-lg font-semibold">Organisation Profile</h1>
      <div className="grid grid-cols-2 gap-4">
        {fields.map(([k, l]) => (
          <div key={k} className={k === "address" ? "col-span-2" : ""}>
            <label className={labelCls}>{l}</label>
            <input value={form[k] ?? ""} onChange={set(k)} className={inputCls} />
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <button
        onClick={() => void save()}
        className="mt-4 rounded-md bg-brand-500 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-brand-600"
      >
        Save {saved && "✓"}
      </button>
      <p className="mt-2 text-xs text-gray-500">
        The state code drives CGST/SGST vs IGST on every invoice and bill.
      </p>
    </div>
  );
}

function TaxesSection() {
  const qc = useQueryClient();
  const { data: taxes } = useQuery({
    queryKey: ["taxes"],
    queryFn: () => api<Array<{ id: string; name: string; rate: string; isActive: boolean }>>("/api/taxes"),
  });
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setError(null);
    try {
      await api("/api/taxes", { method: "POST", body: { name, rate: Number(rate).toFixed(3) } });
      await qc.invalidateQueries({ queryKey: ["taxes"] });
      setName("");
      setRate("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <div className="max-w-xl">
      <h1 className="mb-4 text-lg font-semibold">Taxes</h1>
      <table className="mb-4 w-full text-[13px]">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="border-y px-3 py-2">Name</th>
            <th className="border-y px-3 py-2 text-right">Rate %</th>
          </tr>
        </thead>
        <tbody>
          {taxes?.map((t) => (
            <tr key={t.id} className="border-b">
              <td className="px-3 py-2">{t.name}</td>
              <td className="px-3 py-2 text-right tabular-nums">{Number(t.rate)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className={labelCls}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="GST 18%" className={inputCls} />
        </div>
        <div className="w-28">
          <label className={labelCls}>Rate %</label>
          <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="18" className={inputCls} />
        </div>
        <button
          onClick={() => void add()}
          disabled={!name.trim() || !rate}
          className="rounded-md bg-brand-500 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          Add Tax
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}

function SeriesSection() {
  const qc = useQueryClient();
  const { data: series } = useQuery({
    queryKey: ["series"],
    queryFn: () => api<Array<{ id: string; entity: string; prefix: string; nextNumber: number; padding: number }>>("/api/settings/series"),
  });
  const [error, setError] = useState<string | null>(null);

  const updatePrefix = async (id: string, prefix: string) => {
    setError(null);
    try {
      await api(`/api/settings/series/${id}`, { method: "PATCH", body: { prefix } });
      await qc.invalidateQueries({ queryKey: ["series"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <div className="max-w-xl">
      <h1 className="mb-4 text-lg font-semibold">Document Numbering</h1>
      <table className="w-full text-[13px]">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="border-y px-3 py-2">Document</th>
            <th className="border-y px-3 py-2">Prefix</th>
            <th className="border-y px-3 py-2 text-right">Next Number</th>
          </tr>
        </thead>
        <tbody>
          {series?.map((s) => (
            <tr key={s.id} className="border-b">
              <td className="px-3 py-2 capitalize">{s.entity.replace(/_/g, " ")}</td>
              <td className="px-3 py-2">
                <input
                  defaultValue={s.prefix}
                  onBlur={(e) => {
                    if (e.target.value !== s.prefix && e.target.value.trim()) {
                      void updatePrefix(s.id, e.target.value.trim());
                    }
                  }}
                  className="w-28 rounded border px-2 py-1 text-[13px]"
                />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {s.prefix}
                {String(s.nextNumber).padStart(s.padding, "0")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}

function FinancialYearsSection() {
  const qc = useQueryClient();
  const { data: years } = useQuery({
    queryKey: ["fys"],
    queryFn: () =>
      api<Array<{ id: string; name: string; startDate: string; endDate: string; isActive: boolean; lockedThrough: string | null }>>(
        "/api/settings/financial-years",
      ),
  });
  const [form, setForm] = useState({ name: "", startDate: "", endDate: "" });
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["fys"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-lg font-semibold">Financial Years &amp; Transaction Locking</h1>
      <table className="mb-5 w-full text-[13px]">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="border-y px-3 py-2">Name</th>
            <th className="border-y px-3 py-2">Period</th>
            <th className="border-y px-3 py-2">Locked Through</th>
            <th className="border-y px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {years?.map((y) => (
            <tr key={y.id} className="border-b">
              <td className="px-3 py-2 font-medium">{y.name}</td>
              <td className="px-3 py-2">
                {formatDate(y.startDate)} – {formatDate(y.endDate)}
              </td>
              <td className="px-3 py-2">{y.lockedThrough ? formatDate(y.lockedThrough) : "Not locked"}</td>
              <td className="px-3 py-2 text-right">
                <input
                  type="date"
                  onChange={(e) =>
                    e.target.value &&
                    void run(() =>
                      api(`/api/settings/financial-years/${y.id}`, {
                        method: "PATCH",
                        body: { lockedThrough: e.target.value },
                      }),
                    )
                  }
                  className="rounded border px-2 py-1 text-xs"
                />
                {y.lockedThrough && (
                  <button
                    onClick={() =>
                      void run(() =>
                        api(`/api/settings/financial-years/${y.id}`, {
                          method: "PATCH",
                          body: { lockedThrough: null },
                        }),
                      )
                    }
                    className="ml-2 text-xs text-brand-600 hover:underline"
                  >
                    Unlock
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="mb-2 text-sm font-semibold">Add Financial Year</h2>
      <div className="flex items-end gap-3">
        <div>
          <label className={labelCls}>Name</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="FY 2026-27"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Start</label>
          <input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>End</label>
          <input type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} className={inputCls} />
        </div>
        <button
          onClick={() =>
            void run(async () => {
              await api("/api/settings/financial-years", { method: "POST", body: form });
              setForm({ name: "", startDate: "", endDate: "" });
            })
          }
          disabled={!form.name || !form.startDate || !form.endDate}
          className="rounded-md bg-brand-500 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        Locking a period rejects any journal posting (manual or from documents) dated inside it.
      </p>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
