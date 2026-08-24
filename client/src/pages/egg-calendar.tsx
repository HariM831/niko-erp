/**
 * The egg calendar — a month of days, each derived on the way in.
 *
 * Nothing here was "populated": every cell is computed from the agreements,
 * the exceptions and the spot orders when the month is asked for, so an
 * agreement edited a minute ago is already right for every day shown.
 *
 * Committed vs supply: supply is yesterday's closing stock plus the day's
 * graded boxes (the seven-day average until the sheet is in), carried forward
 * day to day — what can actually be sold, not just what the sheds lay.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "../api";
import { EggOrdersTable, EGG_SIZES as SIZES, EGG_SIZE_LABEL as SIZE_LABEL, isStruck, type EggSize as Size, type OrderLine } from "../components/egg-orders-table";

interface CalDay {
  date: string;
  committed: number;
  standing: number;
  spot: number;
  skipped: number;
  dispatched: number;
  production: number | null;
  graded: boolean;
  opening: number | null;
  supply: number | null;
  closing: number | null;
  benchmark: string | null;
}

type DayLine = OrderLine;

interface Customer {
  id: string;
  name: string;
}

const monthName = (ym: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

const shiftMonth = (ym: string, by: number) => {
  const d = new Date(`${ym}-01T00:00:00`);
  d.setMonth(d.getMonth() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function EggCalendarPage() {
  const [, setLocation] = useLocation();
  const today = new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [days, setDays] = useState<CalDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api<{ days: CalDay[] }>(`/api/sales/eggs/calendar/${month}`)
      .then((d) => setDays(d.days))
      .finally(() => setLoading(false));
  };
  useEffect(load, [month]);

  const firstWeekday = new Date(`${month}-01T00:00:00`).getDay();

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Egg calendar</h1>
          <p className="text-sm text-muted-foreground">
            Boxes committed against what can be sold — the shelf plus the day's grading, carried
            day to day. Derived live; edit an agreement and every day already agrees.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-md border border-border p-2 hover:bg-muted">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[10rem] text-center text-sm font-medium">{monthName(month)}</span>
          <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-md border border-border p-2 hover:bg-muted">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">reading…</div>
      ) : (
        <div className="table-surface p-3">
          <div className="grid grid-cols-7 gap-1.5">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="pb-1 text-center text-[11px] font-semibold uppercase text-muted-foreground">
                {d}
              </div>
            ))}
            {Array.from({ length: firstWeekday }).map((_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {days.map((d) => {
              /* Supply is the shelf plus the lay: yesterday's closing carried
                 in, plus the day's graded boxes (or the seven-day average
                 until the sheet is in). */
              const supply = d.supply;
              const past = d.date < today;
              /* The colour is the day's headroom: committed within supply is
                 fine, near it is amber, over it is a promise the sheds cannot
                 keep. */
              const ratio = supply ? d.committed / supply : 0;
              const tone = !d.committed
                ? ""
                : ratio > 1
                  ? "border-destructive/60 bg-destructive/5"
                  : ratio > 0.85
                    ? "border-warning/60 bg-warning/5"
                    : "border-success/40 bg-success/5";
              return (
                <button
                  key={d.date}
                  onClick={() => setOpen(d.date)}
                  className={`min-h-[84px] rounded-md border p-1.5 text-left align-top transition-colors hover:bg-muted/60 ${
                    tone || "border-border/60"
                  } ${d.date === today ? "ring-1 ring-primary" : ""} ${past ? "opacity-70" : ""}`}
                >
                  <div className="flex items-start justify-between">
                    <span className="text-xs font-semibold">{Number(d.date.slice(8))}</span>
                    {/* A future day with no benchmark yet is a day loading will refuse. */}
                    {!d.benchmark && !past && (
                      <span title="No benchmark set" className="h-1.5 w-1.5 rounded-full bg-warning" />
                    )}
                  </div>
                  {d.committed > 0 && (
                    <div
                      className="mt-0.5 text-[11px] leading-tight"
                      title={
                        supply != null
                          ? `${d.opening ?? 0} on the shelf + ${d.production ?? 0} ${d.graded ? "graded" : "expected"} = ${supply}; ${d.closing ?? 0} left after orders`
                          : undefined
                      }
                    >
                      <span className="font-medium tabular-nums">{d.committed}</span>
                      <span className="text-muted-foreground"> / {supply ?? "?"} boxes</span>
                    </div>
                  )}
                  {d.committed === 0 && !past && d.closing != null && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{d.closing} on shelf</div>
                  )}
                  {d.dispatched > 0 && (
                    <div className="text-[10px] text-success">↑ {d.dispatched} loaded</div>
                  )}
                  {d.skipped > 0 && <div className="text-[10px] text-muted-foreground">{d.skipped} skipped</div>}
                  {past && d.production != null && d.committed === 0 && (
                    <div className="text-[10px] text-muted-foreground">{d.production} produced</div>
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            The denominator is what can actually be sold: yesterday's closing stock plus the day's
            graded boxes (the seven-day average until the sheet is in), carried day to day. Hover
            a day for the breakdown. An amber dot means no benchmark is set for that day yet.
          </p>
        </div>
      )}

      {open && <DayDrawer date={open} onClose={() => setOpen(null)} onChanged={load} goLoad={() => setLocation("/sales/egg-loading")} />}
    </div>
  );
}

const inputCls = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";
const fmtBoxes = (n: number) => n.toLocaleString("en-IN");

interface Capacity {
  opening: number | null;
  production: number | null;
  productionSource: "actual" | "forecast" | "none";
  supply: number | null;
  committed: number;
  dispatched: number;
  closing: number | null;
}

/**
 * The day, opened: the capacity breakdown first — shelf + lay = available,
 * minus committed = can still sell — then the orders as the bay will see
 * them, per size, with the per-day void (skip) for standing and edit/void for
 * spot. The same panel Amino's schedule had, on niko's ledger.
 */
function DayDrawer({
  date,
  onClose,
  onChanged,
  goLoad,
}: {
  date: string;
  onClose: () => void;
  onChanged: () => void;
  goLoad: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const past = date < today;
  const [lines, setLines] = useState<DayLine[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [benchmark, setBenchmark] = useState<{ ratePerEgg: string; setFor: string } | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ id: string | null; customerId: string; sizes: Record<Size, string>; spread: string; notes: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const emptySizes = () => Object.fromEntries(SIZES.map((s) => [s, ""])) as Record<Size, string>;

  const load = () =>
    api<{ lines: DayLine[]; benchmark: typeof benchmark; capacity: Capacity | null }>(`/api/sales/eggs/day/${date}`)
      .then((d) => {
        setLines(d.lines);
        setBenchmark(d.benchmark);
        setCapacity(d.capacity);
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    api<{ customers: Customer[] }>("/api/sales/eggs/customers").then((d) => setCustomers(d.customers));
  }, [date]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  /** Opening the form pre-fills the spread the customer last took. */
  const openNew = async () => {
    const first = customers[0]?.id ?? "";
    setForm({ id: null, customerId: first, sizes: emptySizes(), spread: "", notes: "" });
    if (first) pickCustomer(first);
  };
  const pickCustomer = async (customerId: string) => {
    const r = await api<{ spread: string | null }>(`/api/sales/eggs/customers/${customerId}/last-spread`).catch(() => null);
    setForm((f) => (f ? { ...f, customerId, spread: r?.spread != null ? Number(r.spread).toFixed(2) : "" } : f));
  };
  const openEdit = (l: DayLine) =>
    setForm({
      id: l.sourceId,
      customerId: l.customerId,
      sizes: Object.fromEntries(SIZES.map((s) => [s, l.sizes?.[s] ? String(l.sizes[s]) : ""])) as Record<Size, string>,
      spread: Number(l.spreadPerEgg) ? Number(l.spreadPerEgg).toFixed(2) : "",
      notes: "",
    });

  const submitForm = () =>
    act(async () => {
      if (!form) return;
      const sizes = Object.fromEntries(SIZES.map((s) => [s, Number(form.sizes[s]) || 0]));
      const body = { sizes, spreadPerEgg: form.spread === "" ? null : Number(form.spread), notes: form.notes || undefined };
      if (form.id) await api(`/api/sales/eggs/spot-orders/${form.id}`, { method: "PATCH", body });
      else await api("/api/sales/eggs/spot-orders", { method: "POST", body: { customerId: form.customerId, orderDate: date, ...body } });
      setForm(null);
    });

  const skip = (agreementId: string) => {
    const reason = prompt("Skip this delivery — why? (optional)") ?? undefined;
    return act(() =>
      api(`/api/sales/eggs/agreements/${agreementId}/exceptions`, { method: "POST", body: { onDate: date, kind: "skip", reason } }),
    );
  };
  const unskip = (agreementId: string) =>
    act(() => api(`/api/sales/eggs/agreements/${agreementId}/exceptions/${date}`, { method: "DELETE" }));
  const voidSpot = (id: string) => {
    const reason = prompt("Void this spot order — why? (optional)") ?? undefined;
    return act(() => api(`/api/sales/eggs/spot-orders/${id}/void`, { method: "POST", body: { reason } }));
  };

  const pretty = new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short", year: "numeric" });
  const live = lines.filter((l) => !l.voided && l.exception?.kind !== "skip");
  const formTotal = form ? SIZES.reduce((a, s) => a + (Number(form.sizes[s]) || 0), 0) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="mt-6 w-full max-w-4xl rounded-lg bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{pretty}</h2>
          <button onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {benchmark
            ? benchmark.setFor === date
              ? `Benchmark ₹${Number(benchmark.ratePerEgg).toFixed(2)}/egg`
              : `Benchmark ₹${Number(benchmark.ratePerEgg).toFixed(2)}/egg (carried from ${benchmark.setFor})`
            : "No benchmark in force — loading will refuse this day"}
        </p>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">reading…</div>
        ) : (
          <div className="space-y-4">
            {/* ── Capacity: the arithmetic, left to right ── */}
            {capacity && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Tile
                  label={date > today ? "Opening (projected)" : "Opening stock"}
                  value={capacity.opening}
                />
                <Tile
                  label="+ Production"
                  value={capacity.production}
                  badge={
                    capacity.productionSource === "actual"
                      ? { text: "graded", cls: "bg-success/10 text-success" }
                      : capacity.productionSource === "forecast"
                        ? { text: "forecast", cls: "bg-info/10 text-info" }
                        : undefined
                  }
                />
                <Tile label="= Available" value={capacity.supply} strong />
                <Tile
                  label={past ? "− Dispatched" : "− Committed"}
                  value={past ? capacity.dispatched : capacity.committed}
                  tone="text-destructive"
                  hint={!past && capacity.dispatched > 0 ? `${fmtBoxes(capacity.dispatched)} already loaded` : undefined}
                />
                <Tile
                  label={past ? "= Closing" : "Can still sell"}
                  value={capacity.closing}
                  strong
                  tone={capacity.closing != null && capacity.closing <= 0 ? "text-destructive" : "text-success"}
                />
              </div>
            )}

            {/* ── Orders ── */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Orders</div>
                {!past && !form && (
                  <button onClick={openNew} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                    <Plus className="h-3.5 w-3.5" /> Spot order
                  </button>
                )}
              </div>

              {form && (
                <div className="mb-3 rounded-md border border-dashed border-primary/40 bg-primary/5 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">{form.id ? "Edit spot order" : "New spot order"}</span>
                    <button onClick={() => setForm(null)} className="text-muted-foreground hover:text-foreground">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {!form.id && (
                    <div className="mb-2">
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Customer</label>
                      <select value={form.customerId} onChange={(e) => pickCustomer(e.target.value)} className={inputCls}>
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="mb-2 grid grid-cols-3 gap-2">
                    {SIZES.map((s) => (
                      <div key={s}>
                        <label className="mb-0.5 block text-[10px] text-muted-foreground">{SIZE_LABEL[s]} (boxes)</label>
                        <input
                          type="number"
                          min="0"
                          value={form.sizes[s]}
                          onChange={(e) => setForm({ ...form, sizes: { ...form.sizes, [s]: e.target.value } })}
                          className={inputCls}
                          placeholder="0"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-0.5 block text-[10px] text-muted-foreground">Spread over benchmark (₹/egg)</label>
                      <input type="number" step="0.01" value={form.spread} onChange={(e) => setForm({ ...form, spread: e.target.value })} className={inputCls} placeholder="0.00" />
                    </div>
                    <div>
                      <label className="mb-0.5 block text-[10px] text-muted-foreground">Notes</label>
                      <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputCls} />
                    </div>
                  </div>
                  <button
                    onClick={submitForm}
                    disabled={busy || formTotal <= 0 || !form.customerId}
                    className="w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : form.id ? `Save ${fmtBoxes(formTotal)} boxes` : `Book ${fmtBoxes(formTotal)} boxes`}
                  </button>
                </div>
              )}

                {(() => {
                  const struck = lines.filter(isStruck);
                  const rowActions = (l: OrderLine) =>
                    !l.dispatch && !past ? (
                      <div className="flex justify-end gap-0.5">
                        {l.kind === "spot" && (
                          <button onClick={() => openEdit(l as DayLine)} disabled={busy} title="Edit" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => (l.kind === "standing" ? skip(l.sourceId) : voidSpot(l.sourceId))}
                          disabled={busy}
                          title={l.kind === "standing" ? "Skip this delivery" : "Void this order"}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : null;
                  const struckActions = (l: OrderLine) =>
                    l.kind === "standing" && l.exception?.kind === "skip" && !past ? (
                      <button onClick={() => unskip(l.sourceId)} disabled={busy} className="text-xs text-primary hover:underline">
                        restore
                      </button>
                    ) : null;
                  return (
                    <>
                      <EggOrdersTable lines={live} title="Total" empty="Nothing due this day." actions={rowActions} />
                      {struck.length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skipped & voided</div>
                          <EggOrdersTable lines={struck} title="Struck off" muted actions={struckActions} />
                        </div>
                      )}
                    </>
                  );
                })()}

              {!past && (
                <div className="mt-2 text-right">
                  <button onClick={goLoad} className="text-sm text-primary hover:underline">
                    Loading bay →
                  </button>
                </div>
              )}
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One figure of the capacity arithmetic. */
function Tile({
  label,
  value,
  strong,
  tone = "",
  badge,
  hint,
}: {
  label: string;
  value: number | null;
  strong?: boolean;
  tone?: string;
  badge?: { text: string; cls: string };
  hint?: string;
}) {
  return (
    <div className="table-surface px-3 py-2">
      <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
        {label}
        {badge && <span className={`rounded-full px-1.5 text-[10px] font-medium ${badge.cls}`}>{badge.text}</span>}
      </div>
      <div className={`whitespace-nowrap text-lg tabular-nums ${strong ? "font-semibold" : "font-medium"} ${tone}`}>
        {value != null ? fmtBoxes(value) : "—"}
        <span className="ml-1 text-xs font-normal text-muted-foreground">boxes</span>
      </div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
