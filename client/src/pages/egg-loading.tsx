/**
 * The loading bay — where the order book meets a truck.
 *
 * The day's orders arrive derived (standing minus exceptions, plus spot); the
 * bay enters what was ACTUALLY loaded per size, the driver and the vehicle,
 * and one transaction raises the invoice at benchmark + differential + spread
 * and moves the egg stock. No benchmark for the day = loading refuses.
 *
 * The ±10% band against the committed boxes is shown, never enforced — the
 * bay loads what the truck takes, and the figure on the invoice is the truth.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Truck, X } from "lucide-react";
import { api, formatMoney } from "../api";
import { EggOrdersTable, isStruck, type OrderLine } from "../components/egg-orders-table";

type DayLine = OrderLine;

interface DayData {
  stockBoxes: number | null;
  stockBySize: Record<string, number> | null;
  /** customerId → what their ledger can pay for right now. */
  ledger: Record<string, number>;
  lines: DayLine[];
  benchmark: { ratePerEgg: string; setFor: string } | null;
  offsets: Record<string, string> | null;
  eggsPerBox: number;
}

interface Dispatch {
  id: string;
  customerName: string;
  invoiceNumber: string;
  invoiceTotal: string;
  status: string;
  driverName: string;
  vehicleNumber: string;
  loadedSmall: number;
  loadedMedium: number;
  loadedLarge: number;
  loadedXl: number;
  loadedJumbo: number;
  loadedDirty: number;
}

interface Customer {
  id: string;
  name: string;
}

const SIZES = ["small", "medium", "large", "xl", "jumbo", "dirty"] as const;
const SIZE_LABEL: Record<string, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xl: "XL",
  jumbo: "Jumbo",
  dirty: "Dirty",
};

const inputCls = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

export function EggLoadingPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [data, setData] = useState<DayData | null>(null);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingLine, setLoadingLine] = useState<DayLine | "walkin" | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      api<DayData>(`/api/sales/eggs/day/${date}`),
      api<{ dispatches: Dispatch[] }>(`/api/sales/eggs/dispatches/${date}`),
    ])
      .then(([d, disp]) => {
        setData(d);
        setDispatches(disp.dispatches);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, [date]);
  useEffect(() => {
    api<{ customers: Customer[] }>("/api/sales/eggs/customers").then((d) => setCustomers(d.customers));
  }, []);

  const due = (data?.lines ?? []).filter((l) => !l.voided && l.exception?.kind !== "skip" && !l.dispatch);

  return (
    <div className="p-4 md:p-6">
      <div className="page-header -mx-4 px-4 py-3 md:-mx-6 md:px-6 mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Loading bay</h1>
          </div>
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          <button
            onClick={() => setLoadingLine("walkin")}
            className="whitespace-nowrap rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Walk-in
          </button>
        </div>
      </div>

      {!loading && data && data.stockBoxes != null && (
        <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
          <span>
            In store: <strong className="tabular-nums">{data.stockBoxes.toLocaleString("en-IN")}</strong>{" "}
            <span className="text-muted-foreground">boxes</span>
            {data.stockBySize && (
              <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                {SIZES.filter((s) => (data.stockBySize?.[s] ?? 0) > 0)
                  .map((s) => `${SIZE_LABEL[s]} ${(data.stockBySize?.[s] ?? 0).toLocaleString("en-IN")}`)
                  .join(" · ")}
              </span>
            )}
          </span>
          {(() => {
            const dueBoxes = (data.lines ?? [])
              .filter((l) => !l.voided && l.exception?.kind !== "skip" && !l.dispatch)
              .reduce((a, l) => a + l.boxes, 0);
            const short = dueBoxes - data.stockBoxes!;
            return (
              <span className="text-muted-foreground">
                due {dueBoxes.toLocaleString("en-IN")}
                {short > 0 && (
                  <span className="ml-1 font-medium text-warning">
                    — {short.toLocaleString("en-IN")} short of stock
                  </span>
                )}
              </span>
            );
          })()}
        </div>
      )}

      {!loading && data && !data.benchmark && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="h-4 w-4" />
          No benchmark rate is in force for {date} — nothing can be loaded until it is set.
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">reading…</div>
      ) : (
        <>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Due
          </div>
          <EggOrdersTable
            lines={due}
            title="To load"
            empty="Nothing waiting. Walk-ins load with the button above."
            actions={(l) => {
              /**
               * What this order will invoice at, priced as the server will:
               * per egg, benchmark + size differential + spread. A standing
               * order booked by count is estimated as Large, the grade nearly
               * every box on the farm is — the dialog corrects to the truck.
               */
              const bm = data?.benchmark ? Number(data.benchmark.ratePerEgg) : null;
              const perEgg = (s: string) => (bm ?? 0) + Number(data?.offsets?.[s] ?? 0) + Number(l.spreadPerEgg);
              const split = l.sizes && Object.keys(l.sizes).length ? l.sizes : { large: l.boxes };
              const estimate = bm == null ? null : Object.entries(split).reduce((a, [s, q]) => a + (q ?? 0) * (data?.eggsPerBox ?? 210) * perEgg(s), 0);
              const available = data?.ledger?.[l.customerId];
              const short = estimate != null && available != null ? estimate - available : null;
              const funded = short != null && short <= 0;
              return (
                <div className="flex flex-col items-end gap-0.5">
                  <button
                    onClick={() => setLoadingLine(l)}
                    disabled={!data?.benchmark || !funded}
                    title={
                      !data?.benchmark
                        ? "No benchmark set for the day"
                        : funded
                          ? `Ledger covers ~${formatMoney(estimate ?? 0)}`
                          : `Ledger short by ${formatMoney(short ?? 0)}`
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-success px-2.5 py-1 text-xs font-medium text-white hover:bg-success/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                  >
                    <Truck className="h-3.5 w-3.5" /> Load
                  </button>
                  {short != null && short > 0 && (
                    <span className="whitespace-nowrap text-[10px] text-destructive">short {formatMoney(short)}</span>
                  )}
                </div>
              );
            }}
          />
          {(() => {
            const struck = (data?.lines ?? []).filter(isStruck);
            return struck.length > 0 ? (
              <div className="mt-4">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skipped & voided</div>
                <EggOrdersTable lines={struck} title="Struck off" muted />
              </div>
            ) : null;
          })()}

          <div className="mb-1 mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Loaded today
          </div>
          <div className="table-surface overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="table-th text-left">Customer</th>
                  <th className="table-th text-right">S</th>
                  <th className="table-th text-right">M</th>
                  <th className="table-th text-right">L</th>
                  <th className="table-th text-right">XL</th>
                  <th className="table-th text-right">J</th>
                  <th className="table-th text-right">D</th>
                  <th className="table-th text-left">Vehicle</th>
                  <th className="table-th text-left">Invoice</th>
                  <th className="table-th text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {dispatches.map((d) => (
                  <tr key={d.id} className={`border-b border-border/60 last:border-0 ${d.status === "void" ? "line-through opacity-40" : ""}`}>
                    <td className="px-3 py-2 font-medium">{d.customerName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.loadedSmall || ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.loadedMedium || ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.loadedLarge || ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.loadedXl || ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.loadedJumbo || ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.loadedDirty || ""}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {d.vehicleNumber} · {d.driverName}
                    </td>
                    <td className="px-3 py-2">{d.invoiceNumber}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(d.invoiceTotal)}</td>
                  </tr>
                ))}
                {!dispatches.length && (
                  <tr>
                    <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                      Nothing loaded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {loadingLine && data && (
        <LoadDialog
          date={date}
          line={loadingLine === "walkin" ? null : loadingLine}
          customers={customers}
          data={data}
          onClose={() => setLoadingLine(null)}
          onDone={() => {
            setLoadingLine(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function LoadDialog({
  date,
  line,
  customers,
  data,
  onClose,
  onDone,
}: {
  date: string;
  line: DayLine | null;
  customers: Customer[];
  data: DayData;
  onClose: () => void;
  onDone: () => void;
}) {
  const [customerId, setCustomerId] = useState(line?.customerId ?? customers[0]?.id ?? "");
  // A spot order was booked per size, so the dialog starts from it; the bay
  // corrects to what actually went on the truck.
  const [qty, setQty] = useState<Record<string, string>>(
    Object.fromEntries(SIZES.map((s) => [s, line?.sizes?.[s] ? String(line.sizes[s]) : ""])),
  );
  const [driver, setDriver] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    if (!customerId) return;
    api<{ available: string }>(`/api/sales/eggs/customers/${customerId}/ledger`)
      .then((d) => setAvailable(Number(d.available)))
      .catch(() => setAvailable(null));
  }, [customerId]);

  const totalBoxes = SIZES.reduce((a, s) => a + (Number(qty[s]) || 0), 0);
  /** A size loaded beyond what the pile holds — the server refuses; say so first. */
  const overStock = SIZES.filter((s) => (Number(qty[s]) || 0) > (data.stockBySize?.[s] ?? Infinity));

  /** What this loading will come to, computed the same way the server will. */
  const estimate = useMemo(() => {
    if (!data.benchmark) return null;
    let sum = 0;
    for (const s of SIZES) {
      const boxes = Number(qty[s]) || 0;
      if (!boxes) continue;
      const perEgg =
        Number(data.benchmark.ratePerEgg) +
        Number(data.offsets?.[s] ?? 0) +
        Number(line?.spreadPerEgg ?? 0);
      sum += boxes * data.eggsPerBox * perEgg;
    }
    return sum;
  }, [qty, data, line]);

  const deviation =
    line && totalBoxes > 0 ? ((totalBoxes - line.boxes) / line.boxes) * 100 : null;

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      await api("/api/sales/eggs/load", {
        method: "POST",
        body: {
          dispatchDate: date,
          customerId,
          agreementId: line?.kind === "standing" ? line.sourceId : undefined,
          spotOrderId: line?.kind === "spot" ? line.sourceId : undefined,
          loaded: Object.fromEntries(SIZES.map((s) => [s, Number(qty[s]) || 0])),
          driverName: driver,
          vehicleNumber: vehicle,
          notes: notes || undefined,
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="mt-8 w-full max-w-md rounded-lg bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {line ? `Load ${line.customerName}` : "Walk-in loading"}
          </h2>
          <button onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!line && (
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Customer</label>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputCls}>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {available != null && (
          <p
            className={`mb-3 rounded-md px-3 py-2 text-xs ${
              available > 0 ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"
            }`}
          >
            Ledger holds {formatMoney(available)}. Payment first, truck second — the invoice
            refuses to exceed this.
          </p>
        )}

        <label className="mb-1 block text-xs font-medium text-muted-foreground">Boxes loaded, by size</label>
        <div className="mb-3 grid grid-cols-3 gap-2">
          {SIZES.map((s) => (
            <div key={s}>
              <label className="mb-0.5 block text-[10px] text-muted-foreground">{SIZE_LABEL[s]}</label>
              <input
                type="number"
                min="0"
                value={qty[s] ?? ""}
                onChange={(e) => setQty({ ...qty, [s]: e.target.value })}
                className={inputCls}
              />
            </div>
          ))}
        </div>

        {overStock.length > 0 && (
          <p className="mb-2 text-xs text-destructive">
            Not enough in store: {overStock.map((s) => `${SIZE_LABEL[s]} has ${data.stockBySize?.[s] ?? 0}`).join(", ")}
          </p>
        )}

        {line && deviation !== null && (
          <p className={`mb-2 text-xs ${Math.abs(deviation) > 10 ? "text-warning" : "text-muted-foreground"}`}>
            {totalBoxes} against {line.boxes} committed ({deviation > 0 ? "+" : ""}
            {deviation.toFixed(0)}%){Math.abs(deviation) > 10 && " — outside the usual ±10%"}
          </p>
        )}

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Driver</label>
            <input value={driver} onChange={(e) => setDriver(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Vehicle</label>
            <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} className={inputCls} placeholder="AS 12 AB 1234" />
          </div>
        </div>
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Notes</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </div>

        {estimate != null && totalBoxes > 0 && (
          <p className="mb-2 text-sm">
            Invoice will come to about <span className="font-semibold">{formatMoney(estimate)}</span>
            <span className="text-xs text-muted-foreground"> before tax</span>
            {available != null && estimate > available && (
              <span className="ml-2 font-medium text-destructive">
                — exceeds the ledger by {formatMoney(estimate - available)}
              </span>
            )}
          </p>
        )}
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={
              saving ||
              totalBoxes <= 0 ||
              !driver ||
              !vehicle ||
              overStock.length > 0 ||
              (available != null && estimate != null && estimate > available)
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Load & raise invoice
          </button>
        </div>
      </div>
    </div>
  );
}
