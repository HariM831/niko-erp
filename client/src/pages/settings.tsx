import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate } from "../api";

type Section = "org" | "taxes" | "series" | "financial-years";

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: "org", label: "Organisation Profile" },
  { key: "taxes", label: "Taxes" },
  { key: "series", label: "Transaction Number Series" },
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
        {/* The series grid is a wide table; everything else reads better narrow. */}
        <div className={`card p-6 ${active === "series" ? "" : "max-w-3xl"}`}>
        {active === "org" && <OrgSection />}
        {active === "taxes" && <TaxesSection />}
        {active === "series" && <SeriesSection />}
        {active === "financial-years" && <FinancialYearsSection />}
        </div>
      </div>
    </div>
  );
}

const inputCls = "input";
const labelCls = "label";

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
            <label className={l.endsWith("*") ? "label-required" : labelCls}>{l}</label>
            <input value={form[k] ?? ""} onChange={set(k)} className={inputCls} />
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <button
        onClick={() => void save()}
        disabled={!form.name?.trim()}
        className="btn-primary mt-4"
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
        <thead className="table-head">
          <tr>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Name</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Rate %</th>
          </tr>
        </thead>
        <tbody>
          {taxes?.map((t) => (
            <tr key={t.id} className="border-b border-[#ebeaf2]">
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
          className="btn-primary"
        >
          Add Tax
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}

interface SeriesEntity {
  id: string;
  entity: string;
  prefix: string;
  nextNumber: number;
  padding: number;
}
interface NumberSeries {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  entities: SeriesEntity[];
}

/** Column order for the series grid, following the order Zoho lists modules in. */
const SERIES_COLUMNS: Array<[entity: string, label: string]> = [
  ["invoice", "Invoice"],
  ["credit_note", "Credit Note"],
  ["customer_payment", "Customer Payment"],
  ["bill", "Bill"],
  ["purchase_order", "Purchase Order"],
  ["vendor_credit", "Vendor Credit"],
  ["vendor_payment", "Vendor Payment"],
  ["expense", "Expense"],
  ["journal_entry", "Journal"],
  ["fixed_asset", "Fixed Asset"],
  ["inventory_adjustment", "Inventory Adjustment"],
];

function SeriesSection() {
  const qc = useQueryClient();
  const { data: series } = useQuery({
    queryKey: ["series"],
    queryFn: () => api<NumberSeries[]>("/api/settings/series"),
  });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", prefixTag: "" });

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["series"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  const create = () =>
    run(async () => {
      await api("/api/settings/series", {
        method: "POST",
        body: { name: draft.name.trim(), prefixTag: draft.prefixTag.trim() || undefined },
      });
      setDraft({ name: "", prefixTag: "" });
      setAdding(false);
    });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Transaction Number Series</h1>
        <button onClick={() => setAdding((v) => !v)} className="btn-primary">
          + New Series
        </button>
      </div>
      <p className="mb-4 text-[13px] text-gray-500">
        Run several numbering series side by side so each line of business gets its own document
        numbers. Transactions draw from the default unless they name another series.
      </p>

      {adding && (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border bg-[#fafafc] p-4">
          <div>
            <label className="label-required">Series Name *</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="e.g. Eggs"
              className="input w-44"
              autoFocus
            />
          </div>
          <div>
            <label className="label">Prefix Tag</label>
            <input
              value={draft.prefixTag}
              onChange={(e) => setDraft((d) => ({ ...d, prefixTag: e.target.value }))}
              placeholder="e.g. EG-"
              className="input w-28"
            />
          </div>
          <button onClick={() => void create()} disabled={!draft.name.trim()} className="btn-primary">
            Create
          </button>
          <button onClick={() => setAdding(false)} className="pb-2 text-[13px] text-gray-500 hover:underline">
            Cancel
          </button>
          <p className="w-full text-[12px] text-gray-500">
            The tag is appended to each module&rsquo;s prefix, so &ldquo;EG-&rdquo; gives{" "}
            <span className="font-medium text-gray-700">INV-EG-00001</span>. Every prefix stays
            editable below.
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        {/* w-max stops the browser compressing columns to fit — it scrolls instead. */}
        <table className="w-max text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="sticky left-0 z-10 whitespace-nowrap border border-[#ebeaf2] bg-[#f9f9fb] px-3 py-2 text-left">
                Series Name
              </th>
              {SERIES_COLUMNS.map(([entity, label]) => (
                <th key={entity} className="whitespace-nowrap border border-[#ebeaf2] px-3 py-2 text-left">
                  {label}
                </th>
              ))}
              <th className="border border-[#ebeaf2] px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {series?.map((s) => {
              const byEntity = new Map(s.entities.map((e) => [e.entity, e]));
              return (
                <tr key={s.id}>
                  <td className="sticky left-0 z-10 whitespace-nowrap border border-[#ebeaf2] bg-white px-3 py-2">
                    <span className="font-medium">{s.name}</span>
                    {s.isDefault && (
                      <span className="ml-2 rounded bg-[#eef0f5] px-1.5 py-0.5 text-[11px] text-gray-600">
                        Default
                      </span>
                    )}
                  </td>
                  {SERIES_COLUMNS.map(([entity]) => {
                    const e = byEntity.get(entity);
                    if (!e) {
                      return (
                        <td key={entity} className="border border-[#ebeaf2] px-3 py-2 text-gray-300">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={entity} className="border border-[#ebeaf2] p-1 align-top">
                        <input
                          defaultValue={e.prefix}
                          onBlur={(ev) => {
                            const next = ev.target.value.trim();
                            if (next && next !== e.prefix) {
                              void run(() =>
                                api(`/api/settings/series/${e.id}`, {
                                  method: "PATCH",
                                  body: { prefix: next },
                                }),
                              );
                            }
                          }}
                          className="input w-32 py-1"
                        />
                        <div className="px-1 pt-0.5 text-[11px] tabular-nums text-gray-400">
                          next {e.prefix}
                          {String(e.nextNumber).padStart(e.padding, "0")}
                        </div>
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap border border-[#ebeaf2] px-3 py-2 align-top">
                    {!s.isDefault && (
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            void run(() =>
                              api(`/api/settings/series-group/${s.id}`, {
                                method: "PATCH",
                                body: { isDefault: true },
                              }),
                            )
                          }
                          className="text-[12px] font-medium text-brand-600 hover:underline"
                        >
                          Make Default
                        </button>
                        <button
                          onClick={() =>
                            void run(() =>
                              api(`/api/settings/series-group/${s.id}`, { method: "DELETE" }),
                            )
                          }
                          className="text-[12px] text-red-600 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
        <thead className="table-head">
          <tr>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Name</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Period</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Locked Through</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {years?.map((y) => (
            <tr key={y.id} className="border-b border-[#ebeaf2]">
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
                  className="input w-auto py-1 text-xs"
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
          className="btn-primary"
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
