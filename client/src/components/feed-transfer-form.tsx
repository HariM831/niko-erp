/**
 * Feed Transfers — feed leaving the mill for a shed.
 *
 * Consumption, not relocation: the shed holds no stock, so the kilos leave
 * inventory and the cost returns to the expense account the purchases came
 * from. The stock figure beside the picker is the ceiling — a transfer that
 * would overdraw it is refused by the ledger, so it is refused here first.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import { StatusBadge } from "../components/status-badge";
import { PlatformWeight } from "./platform-weight";

interface Context {
  feeds: Array<{ itemId: string; formulaName: string; itemName: string; quantity: number; value: number }>;
  locations: Array<{ id: string; name: string; type: string; isPrimary: boolean }>;
  houses: Array<{
    id: string;
    code: string;
    purpose: string;
    farmName: string;
    stockLocationId: string;
  }>;
}

interface TransferRow {
  id: string;
  number: string;
  transferDate: string;
  itemName: string;
  quantityKg: string;
  ratePerKg: string | null;
  value: string | null;
  status: string;
  toLocationName: string;
}

const kg = (v: string | number | null | undefined) =>
  v == null ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function FeedTransferForm() {
  const qc = useQueryClient();
  const [itemId, setItemId] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [quantity, setQuantity] = useState("");
  /*
   * A tanker is weighed twice and the feed is the difference.
   *
   * Every feed tanker in the old system's book was weighed empty (~12,800 kg)
   * and again loaded (~31,000 kg) for ~18,200 kg of feed. Taking one reading
   * into Quantity would send a shed the weight of the lorry — nearly double
   * the feed, overdrawing the mill and charging the shed for it — so the two
   * are captured separately and only their difference reaches the field.
   */
  const [emptyKg, setEmptyKg] = useState("");
  const [loadedKg, setLoadedKg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const weighedNet =
    emptyKg && loadedKg ? Number(loadedKg) - Number(emptyKg) : null;
  useEffect(() => {
    if (weighedNet != null && weighedNet > 0) setQuantity(String(weighedNet));
  }, [weighedNet]);

  const { data: ctx } = useQuery<Context>({
    queryKey: ["feed-transfer-context"],
    queryFn: () => api("/api/feed/production/transfers/context"),
  });
  const { data: rows } = useQuery<TransferRow[]>({
    queryKey: ["feed-transfers"],
    queryFn: () => api("/api/feed/production/transfers"),
  });

  useEffect(() => {
    if (!itemId && ctx?.feeds.length) setItemId(ctx.feeds[0]!.itemId);
    // From defaults to the mill, not the first name in the alphabet.
    if (!fromId && ctx?.locations.length) {
      setFromId((ctx.locations.find((l) => l.isPrimary) ?? ctx.locations[0]!).id);
    }
  }, [ctx, itemId, fromId]);

  const held = ctx?.feeds.find((f) => f.itemId === itemId);
  const rate = held && held.quantity > 0 ? held.value / held.quantity : 0;
  const qty = Number(quantity) || 0;

  const send = useMutation({
    mutationFn: () =>
      api<{ number: string }>("/api/feed/production/transfers", {
        method: "POST",
        body: {
          itemId,
          quantityKg: quantity.trim(),
          fromLocationId: fromId,
          toHouseId: toId,
          transferDate: new Date().toISOString().slice(0, 10),
        },
      }),
    onSuccess: (r) => {
      setDone(`${r.number} sent — cost follows the feed to the shed`);
      setError(null);
      setQuantity("");
      void qc.invalidateQueries({ queryKey: ["feed-transfers"] });
      void qc.invalidateQueries({ queryKey: ["feed-transfer-context"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not transfer"),
  });

  const over = held != null && qty > held.quantity;

  /** The last three days that saw transfers, newest first, with day totals. */
  const byDay = (() => {
    const days = [...new Set((rows ?? []).map((r) => r.transferDate))].sort().reverse().slice(0, 3);
    return days.map((day) => {
      const dayRows = (rows ?? []).filter((r) => r.transferDate === day);
      const live = dayRows.filter((r) => r.status !== "void");
      return {
        day,
        rows: dayRows,
        totalKg: live.reduce((s, r) => s + Number(r.quantityKg), 0),
        totalValue: live.reduce((s, r) => s + Number(r.value ?? 0), 0),
      };
    });
  })();

  return (
    <div className="mx-auto max-w-2xl">
          {done && (
            <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-800">
              {done}
            </div>
          )}
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          )}

          <div className="card mb-4 p-5">
            {/* Empty then loaded, in the order the tanker meets the platform:
                it weighs out empty, loads, and weighs again on the way back. */}
            <PlatformWeight
              takes={[
                { label: "Empty", onUse: setEmptyKg },
                { label: "Loaded", onUse: setLoadedKg },
              ]}
            />
            {(emptyKg || loadedKg) && (
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-gray-50 px-3 py-2 text-[12px]">
                <span className="text-gray-500">
                  Empty <span className="tabular-nums text-gray-900">{emptyKg ? kg(emptyKg) : "—"}</span>
                </span>
                <span className="text-gray-500">
                  Loaded <span className="tabular-nums text-gray-900">{loadedKg ? kg(loadedKg) : "—"}</span>
                </span>
                {weighedNet != null && weighedNet > 0 && (
                  <span className="font-medium text-gray-900">→ {kg(weighedNet)} of feed</span>
                )}
                <button
                  className="ml-auto text-gray-400 hover:text-gray-700"
                  onClick={() => {
                    setEmptyKg("");
                    setLoadedKg("");
                  }}
                >
                  Clear
                </button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="label-required">Formula *</label>
                <select value={itemId} onChange={(e) => setItemId(e.target.value)} className="input">
                  {ctx?.feeds.map((f) => (
                    <option key={f.itemId} value={f.itemId}>
                      {f.formulaName} — {Number(f.quantity).toLocaleString("en-IN")} kg in stock
                    </option>
                  ))}
                </select>
                {ctx && !ctx.feeds.length && (
                  <p className="mt-1 text-[12px] text-amber-700">
                    No finished feed in stock — complete a production order first.
                  </p>
                )}
              </div>
              <div>
                <label className="label-required">From *</label>
                <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="input">
                  {ctx?.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label-required">To house *</label>
                <select value={toId} onChange={(e) => setToId(e.target.value)} className="input">
                  <option value="">Choose…</option>
                  {/* Houses, not locations. Offering locations is what let the
                      feed mill appear as somewhere to send feed to. */}
                  {ctx?.houses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.farmName} · {h.code}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label-required">Quantity (kg) *</label>
                <input
                  value={quantity}
                  onChange={(e) => {
                    // Typing wins: the pair above is a convenience, not a lock.
                    setEmptyKg("");
                    setLoadedKg("");
                    setQuantity(e.target.value);
                  }}
                  inputMode="decimal"
                  className="input text-right"
                />
                {over && (
                  <p className="mt-0.5 text-[11px] text-red-600">
                    Only {kg(held!.quantity)} in stock.
                  </p>
                )}
                {weighedNet != null && weighedNet <= 0 && (
                  <p className="mt-0.5 text-[11px] text-red-600">
                    Loaded is not heavier than empty — check which reading went where.
                  </p>
                )}
              </div>
              <div className="flex items-end justify-between">
                <div className="text-[12px] text-gray-500">
                  {qty > 0 && rate > 0 && (
                    <>
                      at {inr(rate)}/kg → <span className="font-medium text-gray-900">{inr(qty * rate)}</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => send.mutate()}
                  disabled={!itemId || !toId || !(qty > 0) || over || send.isPending}
                  className="btn-primary flex items-center gap-1.5"
                >
                  <Send size={14} /> Transfer
                </button>
              </div>
            </div>
          </div>

          {byDay.map(({ day, rows: dayRows, totalKg, totalValue }) => (
            <div key={day} className="card mb-3 overflow-hidden">
              <div className="flex items-baseline justify-between border-b bg-gray-50 px-4 py-1.5">
                <span className="text-[12px] font-semibold text-gray-700">{formatDate(day)}</span>
                <span className="text-[11px] tabular-nums text-gray-500">
                  {kg(totalKg)} · {inr(totalValue)}
                </span>
              </div>
              {dayRows.map((r) => (
              <div key={r.id} className="flex items-baseline justify-between border-b border-gray-100 px-4 py-2 last:border-0">
                <div className="min-w-0">
                  <span className="font-mono text-[13px] font-semibold">{r.number}</span>
                  <span className={`ml-2 text-[12px] ${r.status === "void" ? "text-gray-400 line-through" : "text-gray-600"}`}>
                    {r.itemName} · {kg(r.quantityKg)} → {r.toLocationName}
                  </span>
                  {r.status === "void" && <StatusBadge status="void" />}
                </div>
                <span className="shrink-0 pl-3 text-[12px] tabular-nums text-gray-500">
                  {r.value == null ? "—" : inr(Number(r.value))}
                </span>
              </div>
              ))}
            </div>
          ))}
          <div>
            {rows && !rows.length && (
              <p className="card p-4 text-center text-[13px] text-gray-400">Nothing transferred yet.</p>
            )}
      </div>
    </div>
  );
}
