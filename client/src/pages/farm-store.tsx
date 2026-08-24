/**
 * The farm store — what the farm is holding, received, and issued.
 *
 * A window onto the SAME inventory ledger the rest of the system keeps,
 * summed at this farm's stores. Goods billed through Purchases with this farm
 * as receiving site appear here on their own; what this screen adds is the
 * farm gate's two moves — receive without a bill in hand, issue to a shed —
 * both of which write the core ledger, never a private one.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, PackageOpen } from "lucide-react";
import { api } from "../api";

interface Store {
  id: string;
  code: string;
  name: string;
  kind: string;
}

interface StockRow {
  itemId: string;
  name: string;
  unit: string;
  category: string | null;
  reorderLevel: string | null;
  stockLocationId: string;
  qty: string;
  value: string;
  lastMoved: string;
}

interface CatalogueItem {
  id: string;
  name: string;
  unit: string;
  category: string | null;
}

interface Entry {
  id: string;
  date: string;
  itemName: string;
  unit: string;
  quantity: string;
  value: string;
  sourceType: string;
  notes: string | null;
  storeName: string;
}

interface FarmLocation {
  id: string;
  code: string;
  name: string;
  isPrimary: boolean;
}

interface BoardRow {
  houseId: string;
  code: string;
}

const num = (v: string | number, dp = 0) =>
  Number(v).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const fmtDate = (d: string) =>
  new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

/** What put the row in the ledger, in words a storekeeper uses. */
const SOURCE_LABEL: Record<string, string> = {
  bill: "Purchase bill",
  farm_store_receipt: "Received at farm",
  farm_store_issue: "Issued",
  inventory_adjustment: "Adjustment",
  feed_mill: "Feed mill",
  feed_transfer: "Feed transfer",
};

export function FarmStorePage() {
  const [farms, setFarms] = useState<FarmLocation[]>([]);
  const [locationId, setLocationId] = useState("");
  const [stores, setStores] = useState<Store[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [houses, setHouses] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"receive" | "issue" | null>(null);

  useEffect(() => {
    api<{ locations: FarmLocation[] }>("/api/farms/store/locations").then((d) => {
      setFarms(d.locations);
      if (d.locations[0]) setLocationId(d.locations[0].id);
      else setLoading(false);
    });
    api<{ board: BoardRow[] }>("/api/farms/iot/board")
      .then((d) => setHouses(d.board))
      .catch(() => setHouses([]));
  }, []);

  const load = () => {
    if (!locationId) return;
    setLoading(true);
    Promise.all([
      api<{ stores: Store[]; stock: StockRow[]; catalogue: CatalogueItem[] }>(
        `/api/farms/store/${locationId}/stock`,
      ),
      api<{ entries: Entry[] }>(`/api/farms/store/${locationId}/entries`),
    ])
      .then(([s, e]) => {
        setStores(s.stores);
        setStock(s.stock);
        setCatalogue(s.catalogue);
        setEntries(e.entries);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, [locationId]);

  /**
   * One row per item, houses' feed holdings folded in as their own column
   * group. The main store is what this screen manages; house stock is shown
   * because "where is it" is the storekeeper's whole question.
   */
  const byItem = useMemo(() => {
    const mainIds = new Set(stores.filter((s) => s.kind === "main").map((s) => s.id));
    const map = new Map<
      string,
      { name: string; unit: string; category: string | null; reorderLevel: string | null; main: number; houses: number }
    >();
    for (const r of stock) {
      const held = map.get(r.itemId) ?? {
        name: r.name,
        unit: r.unit,
        category: r.category,
        reorderLevel: r.reorderLevel,
        main: 0,
        houses: 0,
      };
      map.set(r.itemId, held);
      if (mainIds.has(r.stockLocationId)) held.main += Number(r.qty);
      else held.houses += Number(r.qty);
    }
    return [...map.entries()]
      .map(([itemId, v]) => ({ itemId, ...v }))
      .filter((v) => Math.abs(v.main) > 0.0005 || Math.abs(v.houses) > 0.0005)
      .sort((a, b) => (a.category ?? "zz").localeCompare(b.category ?? "zz") || a.name.localeCompare(b.name));
  }, [stock, stores]);

  return (
    <div className="min-h-full bg-soil-50 p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-yolk-400 to-yolk-600 text-white shadow-sm">
            <PackageOpen className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-soil-900">Farm store</h1>
            <p className="text-sm text-soil-400">
              The same inventory the books keep, seen at the farm. Billed goods land here on their own.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {farms.length > 1 && (
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              {farms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setDialog("receive")}
            className="inline-flex items-center gap-1.5 rounded-md bg-yolk-500 px-3 py-2 text-sm font-medium text-white hover:bg-yolk-600"
          >
            <ArrowDownToLine className="h-4 w-4" /> Receive
          </button>
          <button
            onClick={() => setDialog("issue")}
            className="btn-yolk-secondary"
          >
            <ArrowUpFromLine className="h-4 w-4" /> Issue
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">reading…</div>
      ) : (
        <>
          {/* ── On hand ── */}
          <div className="mb-2 flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-yolk-100 text-yolk-700">
              <PackageOpen className="h-3 w-3" />
            </span>
            <span className="text-[13px] font-bold text-soil-900">On hand</span>
          </div>
          {!byItem.length ? (
            <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-6 text-sm text-muted-foreground shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
              <PackageOpen className="h-5 w-5" />
              Nothing on the shelves yet. Receive a delivery, or bill goods to this farm in Purchases.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-soil-100">
                    <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Item</th>
                    <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Category</th>
                    <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-soil-400">Store</th>
                    <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-soil-400">In sheds</th>
                    <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-soil-400">Total</th>
                    <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {byItem.map((r) => {
                    const total = r.main + r.houses;
                    const low = r.reorderLevel != null && total < Number(r.reorderLevel);
                    return (
                      <tr key={r.itemId} className="border-b border-soil-100/70 last:border-0 transition-colors hover:bg-yolk-50/70">
                        <td className="px-3 py-2 font-medium">
                          {r.name}
                          {low && (
                            <span className="ml-2 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                              low
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 capitalize text-muted-foreground">{r.category ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(r.main, 1)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {r.houses ? num(r.houses, 1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{num(total, 1)}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.unit}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── The ledger ── */}
          <div className="mb-2 mt-6 flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-soil-100 text-soil-600">
              <ArrowUpFromLine className="h-3 w-3" />
            </span>
            <span className="text-[13px] font-bold text-soil-900">Recent movements</span>
          </div>
          <div className="overflow-x-auto rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-soil-100">
                  <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Date</th>
                  <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Item</th>
                  <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-soil-400">Qty</th>
                  <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Kind</th>
                  <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Store</th>
                  <th className="whitespace-nowrap bg-soil-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Notes</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const qty = Number(e.quantity);
                  return (
                    <tr key={e.id} className="border-b border-soil-100/70 last:border-0 transition-colors hover:bg-yolk-50/70">
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(e.date)}</td>
                      <td className="px-3 py-2">{e.itemName}</td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${qty < 0 ? "text-destructive" : "text-success"}`}
                      >
                        {qty > 0 ? "+" : ""}
                        {num(qty, 1)} {e.unit}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {SOURCE_LABEL[e.sourceType] ?? e.sourceType}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{e.storeName}</td>
                      <td className="max-w-[280px] truncate px-3 py-2 text-muted-foreground">{e.notes ?? ""}</td>
                    </tr>
                  );
                })}
                {!entries.length && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                      No movements yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {dialog && (
        <MoveDialog
          kind={dialog}
          locationId={locationId}
          catalogue={catalogue}
          houses={houses}
          onHand={new Map(byItem.map((r) => [r.itemId, r.main]))}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Defined OUTSIDE the dialog on purpose: a component created inside a render
 * is a new type every render, so React remounts its children and a person
 * typing loses focus after every character.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
const inputCls = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

function MoveDialog({
  kind,
  locationId,
  catalogue,
  houses,
  onHand,
  onClose,
  onDone,
}: {
  kind: "receive" | "issue";
  locationId: string;
  catalogue: CatalogueItem[];
  houses: BoardRow[];
  onHand: Map<string, number>;
  onClose: () => void;
  onDone: () => void;
}) {
  // Issues offer only what the store actually holds; receipts offer the catalogue.
  const options =
    kind === "issue" ? catalogue.filter((c) => (onHand.get(c.id) ?? 0) > 0) : catalogue;

  const [itemId, setItemId] = useState(options[0]?.id ?? "");
  const [quantity, setQuantity] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rate, setRate] = useState("");
  const [lotNo, setLotNo] = useState("");
  const [expiry, setExpiry] = useState("");
  const [vendor, setVendor] = useState("");
  const [reference, setReference] = useState("");
  const [houseId, setHouseId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const item = catalogue.find((c) => c.id === itemId);
  const held = onHand.get(itemId) ?? 0;

  const submit = async () => {
    setError(null);
    if (!itemId) return setError("Pick an item");
    if (!quantity || Number(quantity) <= 0) return setError("Quantity must be positive");
    setSaving(true);
    try {
      await api(`/api/farms/store/${kind}`, {
        method: "POST",
        body:
          kind === "receive"
            ? {
                locationId,
                itemId,
                quantity: Number(quantity),
                date,
                ratePerUnit: rate ? Number(rate) : undefined,
                lotNo: lotNo || undefined,
                expiryDate: expiry || undefined,
                vendorName: vendor || undefined,
                reference: reference || undefined,
                notes: notes || undefined,
              }
            : {
                locationId,
                itemId,
                quantity: Number(quantity),
                date,
                houseId: houseId || undefined,
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
      <div className="mt-10 w-full max-w-md rounded-lg bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-semibold">{kind === "receive" ? "Receive goods" : "Issue from store"}</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          {kind === "receive"
            ? "For goods arriving without a bill — a purchase billed to this farm lands in the store by itself."
            : "Takes stock off this farm's shelf. Name the shed when it went to one."}
        </p>

        <div className="space-y-3">
          <Field label="Item">
            <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={inputCls}>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={`Quantity${item ? ` (${item.unit})` : ""}`}>
              <input
                type="number"
                min="0"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className={inputCls}
              />
              {kind === "issue" && itemId && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">{num(held, 1)} on hand</p>
              )}
            </Field>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </Field>
          </div>

          {kind === "receive" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Rate per unit (optional)">
                  <input type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Vendor (optional)">
                  <input value={vendor} onChange={(e) => setVendor(e.target.value)} className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Batch / lot no (optional)">
                  <input value={lotNo} onChange={(e) => setLotNo(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Expiry (optional)">
                  <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={inputCls} />
                </Field>
              </div>
              <Field label="Delivery note / reference (optional)">
                <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
              </Field>
            </>
          ) : (
            <Field label="To shed (optional)">
              <select value={houseId} onChange={(e) => setHouseId(e.target.value)} className={inputCls}>
                <option value="">— general use —</option>
                {houses.map((h) => (
                  <option key={h.houseId} value={h.houseId}>
                    {h.code}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Notes (optional)">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
          </Field>
        </div>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-yolk-500 px-3 py-2 text-sm font-medium text-white hover:bg-yolk-600 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {kind === "receive" ? "Receive" : "Issue"}
          </button>
        </div>
      </div>
    </div>
  );
}
