/**
 * Settings › Sales, the egg screens (the user, 30 Sep 2026): the size
 * differentials, moved here off the Benchmark page, and the WhatsApp message
 * the calendar sends each customer once the day's rate is set.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, formatDate } from "../api";
import { EGG_SIZE_LABEL, VISIBLE_EGG_SIZES, isDirectRate, type EggSize } from "@shared/egg-sizes";
import { WHATSAPP_PLACEHOLDERS, fillTemplate, inr } from "@shared/egg-whatsapp";
import { localYmd } from "../lib/utils";

const inputCls = "input w-full";
/** Differentials apply to the grades priced off the benchmark and shown on screen. */
const SIZES = VISIBLE_EGG_SIZES.filter((s) => !isDirectRate(s));

type OffsetRow = { effectiveFrom: string } & Partial<Record<EggSize, string>>;

/**
 * The size differentials: ₹ per egg over the benchmark, per grade. Saving
 * dates a new row today — the invoice reads the row in force on its day, so
 * a change never reprices an earlier load.
 */
export function EggDifferentialsSection() {
  const [offsets, setOffsets] = useState<OffsetRow[]>([]);
  const [bench, setBench] = useState<number | null>(null);
  const [boxSizes, setBoxSizes] = useState<Record<string, number>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () =>
    api<{ offsets: OffsetRow[]; history: { ratePerEgg: string }[]; boxSizes: Record<string, number> }>("/api/sales/eggs/benchmark").then((d) => {
      setOffsets(d.offsets);
      setBench(d.history[0] ? Number(d.history[0].ratePerEgg) : null);
      setBoxSizes(d.boxSizes);
      const cur = d.offsets[0];
      setForm(Object.fromEntries(SIZES.map((s) => [s, Number(cur?.[s] ?? 0).toFixed(2)])));
    });
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api("/api/sales/eggs/size-offsets", {
        method: "POST",
        body: { effectiveFrom: localYmd(), ...Object.fromEntries(SIZES.map((s) => [s, Number(form[s] ?? 0)])) },
      });
      await load();
      setMsg({ ok: true, text: "Saved — in force from today." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setSaving(false);
    }
  };

  const current = offsets[0];
  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-lg border bg-white p-5">
        <h3 className="text-[15px] font-medium text-[#212529]">Size differentials</h3>
        <p className="mb-4 mt-1 text-[13px] text-gray-500">
          ₹ per egg over the day's benchmark. A box is priced (benchmark + differential + the customer's spread) × eggs
          in the box. Brown and Niko have their own box rates on the Benchmark page.
          {current && ` In force since ${formatDate(current.effectiveFrom)}.`}
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {SIZES.map((s) => (
            <div key={s}>
              <label className="mb-1 block text-[12px] font-medium text-gray-600">{EGG_SIZE_LABEL[s]}</label>
              <input
                type="number"
                step="0.01"
                value={form[s] ?? "0.00"}
                onChange={(e) => setForm({ ...form, [s]: e.target.value })}
                className={inputCls}
              />
              {bench != null && (
                <div className="mt-1 text-[11px] text-gray-500">
                  ₹{inr((bench + (Number(form[s]) || 0)) * (boxSizes[s] ?? 210))}/box
                </div>
              )}
            </div>
          ))}
        </div>
        {bench != null && (
          <p className="mt-2 text-[11px] text-gray-500">Box prices at today's benchmark ₹{bench.toFixed(2)}, before any customer's spread.</p>
        )}
        <div className="mt-4 flex items-center justify-end gap-3">
          {msg && <span className={`text-[13px] ${msg.ok ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save differentials"}
          </button>
        </div>
      </div>

      {offsets.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="table-head">
              <tr>
                <th className="table-th text-left">From</th>
                {SIZES.map((s) => (
                  <th key={s} className="table-th text-right">
                    {EGG_SIZE_LABEL[s]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {offsets.map((o) => (
                <tr key={o.effectiveFrom} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">{formatDate(o.effectiveFrom)}</td>
                  {SIZES.map((s) => (
                    <td key={s} className="px-3 py-2 text-right tabular-nums">
                      {Number(o[s] ?? 0).toFixed(2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The sample the preview fills — Amino's, so the two read alike. */
const SAMPLE = {
  customerName: "ABC Farms Pvt Ltd",
  deliveryDate: "Tue, 18 Mar 2026",
  orderLines: "Small: 30 boxes @ ₹1,239/box — ₹37,170\nLarge: 750 boxes @ ₹1,344/box — ₹10,08,000",
  totalAmount: "₹10,45,170",
  qty: { small: 30, large: 750 } as Partial<Record<EggSize, number>>,
  price: { small: 1239, large: 1344 } as Partial<Record<EggSize, number>>,
};

/**
 * The message the calendar opens in WhatsApp beside each order, once the
 * day's benchmark is set. Placeholders are filled per customer at send time.
 */
export function WhatsappMessageSection() {
  const [template, setTemplate] = useState("");
  const [payment, setPayment] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ template: string; paymentInstructions: string }>("/api/sales/eggs/message-settings").then((d) => {
      setTemplate(d.template);
      setPayment(d.paymentInstructions);
      setLoaded(true);
    });
  }, []);

  /** A chip goes in where the cursor is, not always at the end. */
  const insert = (p: string) => {
    const el = box.current;
    const at = el?.selectionStart ?? template.length;
    const to = el?.selectionEnd ?? template.length;
    setTemplate(template.slice(0, at) + p + template.slice(to));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + p.length, at + p.length);
    });
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api("/api/sales/eggs/message-settings", { method: "PUT", body: { template, paymentInstructions: payment } });
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <div className="py-10 text-center text-sm text-gray-500">reading…</div>;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-lg border bg-white p-5">
        <h3 className="text-[15px] font-medium text-[#212529]">Payment instructions</h3>
        <p className="mb-3 mt-1 text-[13px] text-gray-500">One line, put into the message wherever [payment_instructions] sits.</p>
        <input value={payment} onChange={(e) => setPayment(e.target.value)} className={inputCls} placeholder="Name | A/C No | IFSC" />
      </div>

      <div className="rounded-lg border bg-white p-5">
        <h3 className="text-[15px] font-medium text-[#212529]">WhatsApp message</h3>
        <p className="mb-3 mt-1 text-[13px] text-gray-500">
          Opened in WhatsApp from the Calendar, beside each customer's order, once that day's benchmark is set. Prices
          are the Loading Bay's: benchmark + differential + the customer's spread.
        </p>
        <textarea
          ref={box}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={9}
          className="input w-full resize-y py-2 font-mono text-[13px]"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {WHATSAPP_PLACEHOLDERS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => insert(p)}
              className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 font-mono text-[12px] text-blue-700 hover:bg-blue-100"
            >
              {p}
            </button>
          ))}
        </div>

        <div className="mt-4 text-[12px] font-medium text-gray-500">Preview (sample customer)</div>
        <div className="mt-1 max-w-md whitespace-pre-wrap rounded-lg border border-green-200 bg-green-50 p-3 text-[14px] text-[#212529]">
          {fillTemplate(template, { ...SAMPLE, paymentInstructions: payment })}
        </div>

        <div className="mt-4 flex items-center justify-end gap-3">
          {msg && <span className={`text-[13px] ${msg.ok ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
          <button onClick={save} disabled={saving || !template.trim()} className="btn-primary">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
