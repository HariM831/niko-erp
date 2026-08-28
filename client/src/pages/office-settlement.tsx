/**
 * Station 6 — Settlement. A truck becomes a payable.
 *
 * The only desk screen of the six, so unlike the stations it reads like the
 * rest of the books: what the vendor billed, what we are not paying for, and
 * the chain of who did what on the way here. The chain matters — this is the
 * last point at which anybody sees the whole journey before it collapses into
 * a bill and a credit note.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { StatusBadge } from "../components/status-badge";

interface QueueRow {
  id: string;
  number: string;
  vehicleNumber: string;
  vendorName: string | null;
  ageMinutes: number;
  lineCount: number;
  lineSummary: string | null;
  linesRejected: number;
  netWeightKg: string | null;
}

interface CtxLine {
  id: string;
  lineNo: number;
  itemName: string | null;
  status: string;
  billQuantityKg: string;
  allocatedNetKg: string | null;
  shortageKg: string | null;
  agreedRatePerKg: string | null;
  qcRejectionReason: string | null;
}

interface Context {
  receipt: {
    id: string;
    number: string;
    vehicleNumber: string;
    vendorBillNumber: string | null;
    vendorBillDate: string | null;
    grossWeightKg: string | null;
    tareWeightKg: string | null;
    netWeightKg: string | null;
    billTotalAmount: string | null;
    status: string;
  };
  lines: CtxLine[];
  billLines: Array<{ lineId: string; name: string; quantityKg: number; ratePerKg: number; amount: number }>;
  deductions: Array<{ lineId: string; name: string; amount: number; basis: string; ruleId: string | null; ruleVersion: number | null }>;
  goodsValue: number;
  deductionTotal: number;
  netPayable: number;
  billTotalVariance: number | null;
}

/** A deduction is identified by the line it sits on and the rule that made it. */
const keyOf = (d: { lineId: string; ruleId: string | null; name: string }) =>
  `${d.lineId}:${d.ruleId ?? d.name}`;

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const kg = (v: string | number | null | undefined) =>
  v == null ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;

export function SettlementPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // Edited amounts, keyed by deduction. A rule proposes; a person disposes.
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const { data: queue } = useQuery<QueueRow[]>({
    queryKey: ["office", "queue", "settlement"],
    queryFn: () => api("/api/office/queue/settlement"),
    refetchInterval: 30_000,
  });
  const { data: ctx } = useQuery<Context>({
    queryKey: ["office", "settlement", selected],
    queryFn: () => api(`/api/office/receipts/${selected}/settlement-context`),
    enabled: !!selected,
  });

  const settle = useMutation({
    mutationFn: () =>
      api<{ bill: { number: string; total: string }; deducted: string }>(
        `/api/office/receipts/${selected}/settle`,
        {
          method: "POST",
          body: {
            billTotalVarianceReason: reason || undefined,
            deductions: charging.map((d) => ({
              lineId: d.lineId,
              name: d.name,
              amount: d.amount.toFixed(2),
              basis: d.basis,
              ruleId: d.ruleId,
              ruleVersion: d.ruleVersion,
            })),
          },
        },
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["office"] });
      setDone(
        Number(r.deducted) > 0
          ? `${r.bill.number} raised for ${inr(Number(r.bill.total))} — ${inr(Number(r.deducted))} deducted on the bill`
          : `${r.bill.number} raised for ${inr(Number(r.bill.total))}`,
      );
      setSelected(null);
      setReason("");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not settle"),
  });

  // A gap against the vendor's printed total is expected whenever QC refused a
  // line; it needs a reason on the record either way.
  // Null means the vendor total was never captured — nothing to reconcile against.
  /**
   * A quality deduction is a judgement, not a formula.
   *
   * A rule can price a shortage — the weighbridge says how many kilos are
   * missing. It cannot price the state of the goods: that is somebody at the
   * bench deciding what this load is worth, and there is no reading to compute
   * it from. So the row is always offered and always blank, and because a
   * deduction of zero is not charged, leaving it alone costs the vendor
   * nothing. A rule that guessed would have to be corrected on every truck,
   * and the one truck nobody corrected is the one that gets paid wrong.
   */
  const manual = (ctx?.lines ?? [])
    .filter((l) => l.status !== "qc_rejected")
    .map((l) => ({
      lineId: l.id,
      name:
        (ctx?.lines.filter((x) => x.status !== "qc_rejected").length ?? 0) > 1
          ? `Quality deductions — ${l.itemName ?? "line"}`
          : "Quality deductions",
      amount: 0,
      basis: "Entered by hand — nothing is charged unless a figure is put here",
      ruleId: null as string | null,
      ruleVersion: null as number | null,
    }));
  const offered = [...(ctx?.deductions ?? []), ...manual];

  const charging = offered
    .filter((d) => !dropped.has(keyOf(d)))
    .map((d) => ({ ...d, amount: Number(edited[keyOf(d)] ?? d.amount) }))
    .filter((d) => Number.isFinite(d.amount) && d.amount > 0);
  const deductionTotal = charging.reduce((s, d) => s + d.amount, 0);
  const netPayable = (ctx?.goodsValue ?? 0) - deductionTotal;

  const variance = ctx?.billTotalVariance == null ? null : Math.abs(ctx.billTotalVariance);
  const needsReason = variance != null && variance > 1;

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="page-header -mx-4 mb-4 flex items-baseline justify-between gap-4 px-4 py-3 sm:-mx-6 sm:px-6">
        <h1 className="text-[19px] font-semibold text-gray-900">Settlement</h1>
        <span className="text-[13px] text-gray-500">{queue?.length ?? 0} pending</span>
      </div>

      {done && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-800">
          {done}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card overflow-hidden">
          {!queue?.length && (
            <div className="p-6 text-center text-[13px] text-gray-400">Nothing waiting to be settled.</div>
          )}
          {queue?.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                setSelected(r.id);
                setError(null);
                setDone(null);
                setEdited({});
                setDropped(new Set());
              }}
              className={`block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 ${
                selected === r.id ? "bg-brand-50" : ""
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[13px] font-semibold text-gray-900">{r.number}</span>
                <span className="text-[11px] text-gray-400">{r.ageMinutes}m</span>
              </div>
              <div className="text-[12px] text-gray-500">
                {r.vendorName ?? "Vendor not identified"} · {r.vehicleNumber}
              </div>
              <div className="text-[11px] text-gray-400">
                Net {kg(r.netWeightKg)}
                {r.linesRejected > 0 && <span className="ml-2 text-red-600">{r.linesRejected} rejected</span>}
              </div>
            </button>
          ))}
        </div>

        <div className="card p-4">
          {!ctx ? (
            <p className="text-[13px] text-gray-400">Pick a receipt to settle.</p>
          ) : (
            <>
              <div className="mb-3 flex items-baseline justify-between border-b border-gray-100 pb-2">
                <div>
                  <div className="font-mono text-[14px] font-semibold text-gray-900">{ctx.receipt.number}</div>
                  <div className="text-[11px] text-gray-400">
                    Bill {ctx.receipt.vendorBillNumber ?? "—"} · {ctx.receipt.vehicleNumber}
                  </div>
                </div>
                <StatusBadge status={ctx.receipt.status} />
              </div>

              <div className="label">Line items</div>
              {ctx.lines.map((l) => {
                const billed = ctx.billLines.find((b) => b.lineId === l.id);
                return (
                  <div key={l.id} className="border-b border-gray-100 py-2 text-[12px]">
                    <div className="flex justify-between">
                      <span className={l.status === "qc_rejected" ? "text-gray-400" : "text-gray-900"}>
                        {l.itemName}
                      </span>
                      <span className="tabular-nums font-medium text-gray-900">
                        {billed ? inr(billed.amount) : "₹0.00"}
                      </span>
                    </div>
                    {l.status === "qc_rejected" ? (
                      <div className="text-gray-400">
                        Rejected at QC · returned — {l.qcRejectionReason ?? "no reason recorded"}
                      </div>
                    ) : (
                      <div className="text-gray-500">
                        {kg(l.allocatedNetKg)} received of {kg(l.billQuantityKg)} billed
                        {Number(l.shortageKg) > 0 && (
                          <span className="ml-1 text-amber-600">· short {kg(l.shortageKg)}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="mt-2 flex justify-between text-[13px]">
                <span className="text-gray-600">Goods value</span>
                <span className="tabular-nums font-medium">{inr(ctx.goodsValue)}</span>
              </div>

              {offered.length > 0 && (
                <div className="mt-3">
                  <div className="label">Deductions — negative lines on the bill</div>
                  {offered.map((d) => {
                    const key = keyOf(d);
                    const off = dropped.has(key);
                    const value = edited[key] ?? (d.ruleId == null ? "" : d.amount.toFixed(2));
                    // A hand-entered figure has nothing to be adjusted from.
                    const proposed = d.ruleId != null;
                    const changed = proposed && !off && Math.abs(Number(value) - d.amount) > 0.005;
                    return (
                      <div key={key} className={`border-b border-gray-100 py-1.5 ${off ? "opacity-45" : ""}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-[12px] ${off ? "text-gray-400 line-through" : "text-gray-700"}`}>
                            {d.name}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="text-[12px] text-amber-700">−₹</span>
                            <input
                              value={value}
                              disabled={off}
                              onChange={(e) => setEdited((s) => ({ ...s, [key]: e.target.value }))}
                              inputMode="decimal"
                              className="input h-7 w-28 text-right text-[12px] disabled:bg-gray-50"
                            />
                            <button
                              onClick={() =>
                                setDropped((s) => {
                                  const next = new Set(s);
                                  if (next.has(key)) next.delete(key);
                                  else next.add(key);
                                  return next;
                                })
                              }
                              title={off ? "Charge it after all" : "Waive this deduction"}
                              className="w-5 text-[13px] text-gray-400 hover:text-gray-700"
                            >
                              {off ? "↺" : "×"}
                            </button>
                          </div>
                        </div>
                        <div className="pr-[124px] text-[11px] text-gray-400">
                          {d.basis}
                          {changed && (
                            <span className="ml-1 text-amber-600">
                              · adjusted from {inr(d.amount)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 flex justify-between border-t border-gray-200 pt-2 text-[15px] font-semibold">
                <span>Net payable</span>
                <span className="tabular-nums">{inr(netPayable)}</span>
              </div>

              <div className="mt-3 rounded-lg bg-gray-50 p-2 text-[11px] text-gray-500">
                <div className="mb-1 font-semibold text-gray-600">The chain</div>
                <div>Gross {kg(ctx.receipt.grossWeightKg)} · Tare {kg(ctx.receipt.tareWeightKg)} · Net {kg(ctx.receipt.netWeightKg)}</div>
                <div>Vendor billed {ctx.receipt.billTotalAmount ? inr(Number(ctx.receipt.billTotalAmount)) : "—"}</div>
              </div>

              {needsReason && (
                <div className="mt-3">
                  <label className="label-required">
                    Why does this differ from the vendor's total by {inr(variance ?? 0)}? *
                  </label>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} className="input" />
                </div>
              )}

              <button
                className="btn-primary mt-4 w-full"
                disabled={settle.isPending || (needsReason && !reason.trim())}
                onClick={() => {
                  setError(null);
                  settle.mutate();
                }}
              >
                Settle &amp; raise payable
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
