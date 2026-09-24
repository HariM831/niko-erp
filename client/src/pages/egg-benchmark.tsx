/**
 * The egg benchmark — one rate, set each evening, read everywhere.
 *
 * This writes the same egg_benchmark_prices table owner billing prices the
 * buy-back from, so there is exactly one egg rate in the system, the same way
 * there is one feed cost. The size differentials live here too: they are a
 * setting about the market, not about any customer — the customer's own term
 * is the spread on their agreement.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, formatDate } from "../api";
import { DIRECT_RATE_SIZES, EGG_SIZE_LABEL, VISIBLE_EGG_SIZES, isDirectRate, type EggSize } from "@shared/egg-sizes";
import { localYmd } from "../lib/utils";
import { DateInput } from "../components/date-input";
import { Sparkline } from "../components/ui/sparkline";

interface BenchmarkRow {
  id: string;
  effectiveFrom: string;
  ratePerEgg: string;
  note: string | null;
  setBy: string | null;
}

interface Forecast {
  anchorDate: string;
  points: { date: string; p10: number; p50: number; p90: number }[];
}

type OffsetRow = { effectiveFrom: string } & Partial<Record<EggSize, string>>;

interface BoxRateRow {
  id: string;
  effectiveFrom: string;
  ratePerBox: string;
  note: string | null;
  setBy: string | null;
}

/** Differentials apply to the grades priced off the benchmark and shown on screen. */
const SIZES = VISIBLE_EGG_SIZES.filter((s) => !isDirectRate(s));
const SIZE_LABEL: Record<string, string> = EGG_SIZE_LABEL;

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localYmd(d);
};

const inputCls = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

export function EggBenchmarkPage() {
  const [history, setHistory] = useState<BenchmarkRow[]>([]);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [offsets, setOffsets] = useState<OffsetRow[]>([]);
  const [eggsPerBox, setEggsPerBox] = useState(210);
  const [loading, setLoading] = useState(true);

  const [date, setDate] = useState(tomorrow());
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [offsetForm, setOffsetForm] = useState<Record<string, string>>({});
  const [savingOffsets, setSavingOffsets] = useState(false);

  /** The box-priced grades — Niko — with a rate of their own. */
  const [boxRates, setBoxRates] = useState<Record<string, BoxRateRow[]>>({});
  const [boxSizes, setBoxSizes] = useState<Record<string, number>>({});
  const [boxDate, setBoxDate] = useState(tomorrow());
  const [boxRate, setBoxRate] = useState("");
  const [boxNote, setBoxNote] = useState("");
  const [savingBox, setSavingBox] = useState<string | null>(null);

  const load = () =>
    api<{
      history: BenchmarkRow[];
      offsets: OffsetRow[];
      eggsPerBox: number;
      boxSizes: Record<string, number>;
      boxRates: Record<string, BoxRateRow[]>;
      forecast?: Forecast | null;
    }>("/api/sales/eggs/benchmark")
      .then((d) => {
        setHistory(d.history);
        setForecast(d.forecast ?? null);
        setOffsets(d.offsets);
        setEggsPerBox(d.eggsPerBox);
        setBoxSizes(d.boxSizes ?? {});
        setBoxRates(d.boxRates ?? {});
        const current = d.offsets[0];
        if (current) {
          setOffsetForm(Object.fromEntries(SIZES.map((s) => [s, Number(current[s] ?? 0).toFixed(2)])));
        }
      })
      .finally(() => setLoading(false));

  const setBoxRateFor = async (size: string) => {
    setError(null);
    setSavingBox(size);
    try {
      await api("/api/sales/eggs/box-rate", {
        method: "POST",
        body: { size, effectiveFrom: boxDate, ratePerBox: Number(boxRate), note: boxNote || undefined },
      });
      setBoxRate("");
      setBoxNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSavingBox(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const setBenchmark = async () => {
    setError(null);
    setSaving(true);
    try {
      await api("/api/sales/eggs/benchmark", {
        method: "POST",
        body: { effectiveFrom: date, ratePerEgg: Number(rate), note: note || undefined },
      });
      setRate("");
      setNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const saveOffsets = async () => {
    setError(null);
    setSavingOffsets(true);
    try {
      await api("/api/sales/eggs/size-offsets", {
        method: "POST",
        body: {
          effectiveFrom: localYmd(),
          ...Object.fromEntries(SIZES.map((s) => [s, Number(offsetForm[s] ?? 0)])),
        },
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSavingOffsets(false);
    }
  };

  /** Days in the last week with no rate of their own — the forgetting warning. */
  const missing = (() => {
    const have = new Set(history.map((h) => h.effectiveFrom));
    const out: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const s = localYmd(d);
      if (!have.has(s)) out.push(s);
    }
    return out;
  })();

  const current = history[0];

  return (
    <div className="p-4 md:p-6">
      <div className="page-header -mx-4 px-4 py-3 md:-mx-6 md:px-6 mb-4">
        <h1 className="text-2xl font-semibold">Egg benchmark</h1>
        </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">reading…</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            {/* ── Set ── */}
            <div className="table-surface p-4">
              <div className="mb-1 text-sm font-medium">Set the rate</div>
              {current && (
                <p className="mb-3 text-xs text-muted-foreground">
                  In force now: ₹{Number(current.ratePerEgg).toFixed(2)} (₹
                  {(Number(current.ratePerEgg) * eggsPerBox).toFixed(0)}/box of {eggsPerBox}).
                </p>
              )}
              <div className="flex items-end gap-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">For</label>
                  <DateInput value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
                </div>
                <div className="w-28">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">₹ / egg</label>
                  <input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} className={inputCls} />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Note</label>
                  <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="e.g. NECC Guwahati" />
                </div>
                <button
                  onClick={setBenchmark}
                  disabled={saving || !rate}
                  className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Set"}
                </button>
              </div>
              {rate && (
                <p className="mt-2 text-xs text-muted-foreground">
                  ₹{Number(rate).toFixed(2)}/egg = ₹{(Number(rate) * eggsPerBox).toFixed(0)} per box of {eggsPerBox}
                </p>
              )}
              {missing.length > 0 && (
                <p className="mt-2 text-xs text-warning">
                  No rate of their own: {missing.map((m) => formatDate(m)).join(", ")} — those days carry
                  the last rate before them.
                </p>
              )}
            </div>

            {/* ── Box rates: the grades sold by the box, not off the benchmark ── */}
            {DIRECT_RATE_SIZES.map((size) => {
              const rows = boxRates[size] ?? [];
              const inForce = rows[0];
              return (
                <div key={size} className="table-surface p-4">
                  <div className="mb-1 text-sm font-medium">{EGG_SIZE_LABEL[size]} box rate</div>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Sold at a rate per box of {boxSizes[size] ?? "—"}, with nothing to do with the benchmark,
                    the differentials or a customer's spread.
                    {inForce
                      ? ` In force now: ₹${Number(inForce.ratePerBox).toFixed(2)}/box, set for ${formatDate(inForce.effectiveFrom)}.`
                      : ` No rate set yet — a ${EGG_SIZE_LABEL[size]} box cannot be invoiced until one is.`}
                  </p>
                  <div className="flex items-end gap-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">For</label>
                      <DateInput value={boxDate} onChange={(e) => setBoxDate(e.target.value)} className={inputCls} />
                    </div>
                    <div className="w-28">
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">₹ / box</label>
                      <input type="number" step="0.01" min="0" value={boxRate} onChange={(e) => setBoxRate(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Note</label>
                      <input value={boxNote} onChange={(e) => setBoxNote(e.target.value)} className={inputCls} />
                    </div>
                    <button
                      onClick={() => setBoxRateFor(size)}
                      disabled={savingBox === size || !boxRate}
                      className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {savingBox === size ? <Loader2 className="h-4 w-4 animate-spin" /> : "Set"}
                    </button>
                  </div>
                  {rows.length > 0 && (
                    <table className="mt-3 w-full text-xs">
                      <tbody>
                        {rows.slice(0, 8).map((r) => (
                          <tr key={r.id} className="border-t border-border/60">
                            <td className="py-1">{formatDate(r.effectiveFrom)}</td>
                            <td className="py-1 text-right tabular-nums">₹{Number(r.ratePerBox).toFixed(2)}</td>
                            <td className="py-1 pl-3 text-muted-foreground">{r.note ?? ""}</td>
                            <td className="py-1 pl-3 text-muted-foreground">{r.setBy ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}

            {/* ── Size differentials ── */}
            <div className="table-surface p-4">
              <div className="mb-1 text-sm font-medium">Size differentials</div>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                {SIZES.map((s) => (
                  <div key={s}>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">{SIZE_LABEL[s]}</label>
                    <input
                      type="number"
                      step="0.01"
                      value={offsetForm[s] ?? "0"}
                      onChange={(e) => setOffsetForm({ ...offsetForm, [s]: e.target.value })}
                      className={inputCls}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  onClick={saveOffsets}
                  disabled={savingOffsets}
                  className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                  {savingOffsets ? "Saving…" : "Save differentials"}
                </button>
              </div>
            </div>
          </div>

          {/* ── History ── */}
          <div className="space-y-4">
          <BenchmarkTrend history={history} forecast={forecast} />
          <div className="table-surface overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="table-th text-left">From</th>
                  <th className="table-th text-right">₹ / egg</th>
                  <th className="table-th text-right">Change</th>
                  <th className="table-th text-right">₹ / box</th>
                  <th className="table-th text-left">Note</th>
                  <th className="table-th text-left">Set by</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">{formatDate(h.effectiveFrom)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(h.ratePerEgg).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <RateChange now={h.ratePerEgg} before={history[i + 1]?.ratePerEgg} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {(Number(h.ratePerEgg) * eggsPerBox).toFixed(0)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{h.note ?? ""}</td>
                    <td className="px-3 py-2 text-muted-foreground">{h.setBy ?? ""}</td>
                  </tr>
                ))}
                {!history.length && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                      No rates set yet — nothing can be invoiced until one is.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** A rate against the one before it, in paise-sized steps. */
function RateChange({ now, before }: { now: string; before?: string }) {
  if (before == null) return <span className="text-muted-foreground">—</span>;
  const d = Number(now) - Number(before);
  if (Math.abs(d) < 0.005) return <span className="text-muted-foreground">0.00</span>;
  return (
    <span className={d > 0 ? "text-emerald-600" : "text-rose-600"}>
      {d > 0 ? "+" : ""}
      {d.toFixed(2)}
    </span>
  );
}

/** YYYY-MM-DD plus or minus whole days, in UTC so no clock moves the date. */
const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The benchmark over the last sixty days, one point a day. A day nobody set a
 * rate for carries the one before it — that is the price eggs were invoiced
 * at — so the line shows what applied, and a flat stretch is a stretch nobody
 * updated. The model's forecast follows, dashed, with its p10–p90 range shaded.
 */
function BenchmarkTrend({ history, forecast }: { history: BenchmarkRow[]; forecast: Forecast | null }) {
  const rates = [...history].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (rates.length < 2) return null;
  const today = localYmd();
  const lastSet = rates[rates.length - 1]!.effectiveFrom;
  // The window ends at the last rate anyone set. Running it on to today would,
  // on a benchmark left alone for months, draw sixty days of one carried rate.
  const end = lastSet;
  const stale = lastSet < today;
  const start = [rates[0]!.effectiveFrom, shiftDay(end, -59)].sort()[1]!;
  const points: { x: string; y: number }[] = [];
  let j = 0;
  let rate: number | null = null;
  for (let day = start; day <= end; day = shiftDay(day, 1)) {
    while (j < rates.length && rates[j]!.effectiveFrom <= day) rate = Number(rates[j++]!.ratePerEgg);
    if (rate != null) points.push({ x: day, y: rate });
  }
  const ahead = (forecast?.points ?? [])
    // A forecast whose days have gone by is not a forecast — the home tile's rule.
    .filter((p) => p.date > end && p.date > today)
    .slice(0, 28)
    .map((p) => ({ x: p.date, y: p.p50, lo: p.p10, hi: p.p90 }));
  const first = points[0];
  const last = points[points.length - 1];
  const far = ahead[ahead.length - 1];
  if (!first || !last) return null;
  return (
    <div className="table-surface p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">Benchmark, ₹ per egg</span>
        <span className="text-[11px] text-muted-foreground">
          {stale
            ? `Not set since ${formatDate(lastSet)} — every day since has carried ₹${last.y.toFixed(2)}`
            : ahead.length
              ? "Dashed: the forecast; shaded: where 8 in 10 outcomes fall"
              : "No forecast ahead of the last rate"}
        </span>
      </div>
      <Sparkline points={points} ahead={ahead} className="h-24 w-full" />
      <div className="mt-1 flex justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {formatDate(first.x)} · ₹{first.y.toFixed(2)}
        </span>
        <span>
          {formatDate(last.x)} · <strong className="text-foreground">₹{last.y.toFixed(2)}</strong>
        </span>
        {far && (
          <span>
            {formatDate(far.x)} · ₹{far.y.toFixed(2)} forecast
          </span>
        )}
      </div>
    </div>
  );
}
