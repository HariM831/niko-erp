/**
 * The egg calendar — a month of days, each derived on the way in.
 *
 * Nothing here was "populated": every cell is computed from the agreements,
 * the exceptions and the spot orders when the month is asked for, so an
 * agreement edited a minute ago is already right for every day shown.
 *
 * Committed vs expected: expected production is the average of the last seven
 * day-end records for future days, and the actual record for past ones.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, Loader2, Plus, X } from "lucide-react";
import { api } from "../api";

interface CalDay {
  date: string;
  committed: number;
  standing: number;
  spot: number;
  skipped: number;
  dispatched: number;
  production: number | null;
  expected: number | null;
  benchmark: string | null;
}

interface DayLine {
  kind: "standing" | "spot";
  sourceId: string;
  customerName: string;
  boxes: number;
  spreadPerEgg: string;
  exception: { kind: string; reason: string | null } | null;
  voided: boolean;
  dispatch: { invoiceNumber: string; loadedBoxes: number } | null;
}

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
            Boxes committed against production. Derived live — edit an agreement and every day
            already agrees.
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
              const supply = d.production ?? d.expected;
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
                    <div className="mt-0.5 text-[11px] leading-tight">
                      <span className="font-medium tabular-nums">{d.committed}</span>
                      <span className="text-muted-foreground"> / {supply ?? "?"} boxes</span>
                    </div>
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
            The denominator is the day's own production record where one exists, else the
            seven-day average. An amber dot means no benchmark is set for that day yet.
          </p>
        </div>
      )}

      {open && <DayDrawer date={open} onClose={() => setOpen(null)} onChanged={load} goLoad={() => setLocation("/sales/egg-loading")} />}
    </div>
  );
}

const inputCls = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

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
  const [lines, setLines] = useState<DayLine[]>([]);
  const [benchmark, setBenchmark] = useState<{ ratePerEgg: string; setFor: string } | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [spotCustomer, setSpotCustomer] = useState("");
  const [spotBoxes, setSpotBoxes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ lines: DayLine[]; benchmark: typeof benchmark }>(`/api/sales/eggs/day/${date}`)
      .then((d) => {
        setLines(d.lines);
        setBenchmark(d.benchmark);
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    api<{ customers: Customer[] }>("/api/sales/eggs/customers").then((d) => {
      setCustomers(d.customers);
      if (d.customers[0]) setSpotCustomer(d.customers[0].id);
    });
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

  const addSpot = () =>
    act(async () => {
      await api("/api/sales/eggs/spot-orders", {
        method: "POST",
        body: { customerId: spotCustomer, orderDate: date, boxes: Number(spotBoxes) },
      });
      setAdding(false);
      setSpotBoxes("");
    });

  const skip = (agreementId: string) => {
    const reason = prompt("Skip this delivery — why? (optional)") ?? undefined;
    return act(() =>
      api(`/api/sales/eggs/agreements/${agreementId}/exceptions`, {
        method: "POST",
        body: { onDate: date, kind: "skip", reason },
      }),
    );
  };

  const unskip = (agreementId: string) =>
    act(() => api(`/api/sales/eggs/agreements/${agreementId}/exceptions/${date}`, { method: "DELETE" }));

  const voidSpot = (id: string) => {
    const reason = prompt("Void this spot order — why? (optional)") ?? undefined;
    return act(() => api(`/api/sales/eggs/spot-orders/${id}/void`, { method: "POST", body: { reason } }));
  };

  const pretty = new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="mt-8 w-full max-w-lg rounded-lg bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
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
          <div className="space-y-1.5">
            {lines.map((l) => (
              <div
                key={`${l.kind}-${l.sourceId}`}
                className={`flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm ${
                  l.voided || l.exception?.kind === "skip" ? "opacity-50" : ""
                }`}
              >
                <div>
                  <span className={l.voided ? "line-through" : ""}>{l.customerName}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {l.kind === "standing" ? "standing" : "spot"}
                    {l.exception?.kind === "skip" && " · skipped"}
                    {l.exception?.kind === "qty_override" && " · adjusted"}
                    {l.voided && " · voided"}
                  </span>
                  {l.dispatch && (
                    <span className="ml-2 text-xs text-success">
                      loaded {l.dispatch.loadedBoxes} · {l.dispatch.invoiceNumber}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="tabular-nums">{l.exception?.kind === "skip" ? "—" : `${l.boxes} boxes`}</span>
                  {!l.dispatch && !l.voided && l.kind === "standing" && (
                    l.exception?.kind === "skip" ? (
                      <button onClick={() => unskip(l.sourceId)} disabled={busy} className="text-xs text-primary hover:underline">
                        restore
                      </button>
                    ) : (
                      <button onClick={() => skip(l.sourceId)} disabled={busy} className="text-xs text-destructive hover:underline">
                        skip
                      </button>
                    )
                  )}
                  {!l.dispatch && !l.voided && l.kind === "spot" && (
                    <button onClick={() => voidSpot(l.sourceId)} disabled={busy} className="text-xs text-destructive hover:underline">
                      void
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!lines.length && (
              <p className="py-4 text-center text-sm text-muted-foreground">Nothing due this day.</p>
            )}
          </div>
        )}

        {adding ? (
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Customer</label>
              <select value={spotCustomer} onChange={(e) => setSpotCustomer(e.target.value)} className={inputCls}>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-24">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Boxes</label>
              <input type="number" min="1" value={spotBoxes} onChange={(e) => setSpotBoxes(e.target.value)} className={inputCls} />
            </div>
            <button
              onClick={addSpot}
              disabled={busy || !spotBoxes}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Book"}
            </button>
          </div>
        ) : (
          <div className="mt-3 flex justify-between">
            <button
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <Plus className="h-3.5 w-3.5" /> Spot order
            </button>
            <button onClick={goLoad} className="text-sm text-primary hover:underline">
              Loading bay →
            </button>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
