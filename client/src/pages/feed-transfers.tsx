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

interface Context {
  feeds: Array<{ itemId: string; formulaName: string; itemName: string; quantity: number; value: number }>;
  locations: Array<{ id: string; name: string; type: string; isPrimary: boolean }>;
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

export function FeedTransfersPage() {
  const qc = useQueryClient();
  const [itemId, setItemId] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

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
          toLocationId: toId,
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

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Feed Transfers</h1>
        <p className="text-[13px] text-gray-500">
          Feed leaving the mill for a shed — consumed on arrival, costed at today's stock value
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-surface p-3 lg:p-6">
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
                  {ctx?.locations
                    .filter((l) => l.id !== fromId)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label-required">Quantity (kg) *</label>
                <input
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  inputMode="decimal"
                  className="input text-right"
                />
                {over && (
                  <p className="mt-0.5 text-[11px] text-red-600">
                    Only {kg(held!.quantity)} in stock.
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

          <div className="card overflow-hidden">
            {rows?.map((r) => (
              <div key={r.id} className="flex items-baseline justify-between border-b border-gray-100 px-4 py-2 last:border-0">
                <div className="min-w-0">
                  <span className="font-mono text-[13px] font-semibold">{r.number}</span>
                  <span className={`ml-2 text-[12px] ${r.status === "void" ? "text-gray-400 line-through" : "text-gray-600"}`}>
                    {r.itemName} · {kg(r.quantityKg)} → {r.toLocationName}
                  </span>
                  {r.status === "void" && <StatusBadge status="void" />}
                </div>
                <span className="shrink-0 pl-3 text-[12px] tabular-nums text-gray-500">
                  {r.value == null ? "—" : inr(Number(r.value))} · {formatDate(r.transferDate)}
                </span>
              </div>
            ))}
            {rows && !rows.length && (
              <p className="p-4 text-center text-[13px] text-gray-400">Nothing transferred yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
