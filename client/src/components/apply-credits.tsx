/**
 * Settling a bill or an invoice with money already on the table.
 *
 * A vendor paid in advance, or a credit note raised on a short load, sits on
 * the party's ledger in our favour. The only way to use it from the document
 * used to be Record Payment, which writes a SECOND payment for money that has
 * already gone — that is how SWIFT ended up paid twice on paper.
 *
 * Zoho's dialog, kept close: every spare advance and open credit in one list,
 * each with what it has left, a box to put some of it against this document
 * and "Pay in Full" to use as much as fits, and the running "Final Balance"
 * underneath. Nothing posts to the ledger — the money was already accounted
 * for when it moved — so this only says which document it belongs to.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, formatDate, formatMoney } from "../api";

export interface Credit {
  kind: "advance" | "credit";
  id: string;
  number: string;
  date: string;
  amount: string;
  available: string;
}

export interface CreditsOffer {
  number: string;
  balanceDue: string;
  credits: Credit[];
  total: string;
}

/** Where the credits for this document live, per side. */
const base = (side: "vendor" | "customer", id: string) =>
  side === "vendor" ? `/api/purchases/bills/${id}` : `/api/sales/invoices/${id}`;

/** What a party has spare against this document, or null while it loads. */
export function useCredits(side: "vendor" | "customer", id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["credits", side, id],
    queryFn: () => api<CreditsOffer>(`${base(side, id)}/credits`),
    enabled,
  });
}

export function ApplyCreditsDialog({
  side,
  documentId,
  offer,
  onClose,
  onApplied,
}: {
  side: "vendor" | "customer";
  documentId: string;
  offer: CreditsOffer;
  onClose: () => void;
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const applied = useMemo(
    () => Object.values(amounts).reduce((s, v) => s + Number(v || 0), 0),
    [amounts],
  );
  const balance = Number(offer.balanceDue);
  const left = balance - applied;

  /** As much of this credit as still fits on the document — Zoho's "Pay in Full". */
  const payInFull = (c: Credit) => {
    const others = Object.entries(amounts)
      .filter(([id]) => id !== c.id)
      .reduce((s, [, v]) => s + Number(v || 0), 0);
    const room = Math.max(0, balance - others);
    const use = Math.min(Number(c.available), room);
    setAmounts((a) => ({ ...a, [c.id]: use ? use.toFixed(2) : "" }));
  };

  const save = useMutation({
    mutationFn: () =>
      api(`${base(side, documentId)}/apply-credits`, {
        method: "POST",
        // api() serialises the body itself; handing it a string would post a
        // JSON string containing JSON.
        body: {
          applications: offer.credits
            .filter((c) => Number(amounts[c.id] || 0) > 0)
            .map((c) => ({ kind: c.kind, id: c.id, amount: Number(amounts[c.id]).toFixed(2) })),
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onApplied();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not apply the credits"),
  });

  const overApplied = left < -0.004;
  const nothing = applied <= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-3 py-8">
      <div role="dialog" aria-label="Apply credits" className="w-full max-w-4xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-3 sm:px-6">
          <h2 className="text-[15px] font-semibold text-gray-800">Apply credits to {offer.number}</h2>
          <div className="flex items-center gap-4">
            <span className="text-[13px] text-gray-600">
              Balance: <strong className="tabular-nums">{formatMoney(offer.balanceDue)}</strong>
            </span>
            <button onClick={onClose} aria-label="Close" className="text-2xl leading-none text-gray-400 hover:text-gray-700">
              ×
            </button>
          </div>
        </div>

        {error && <p className="border-b bg-red-50 px-5 py-2 text-[13px] text-red-700 sm:px-6">{error}</p>}

        <div className="overflow-x-auto px-5 py-4 sm:px-6">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wide text-gray-500">
                <th className="py-1.5 text-left font-semibold">Transaction details</th>
                <th className="py-1.5 text-right font-semibold">Amount</th>
                <th className="py-1.5 text-right font-semibold">Available balance</th>
                <th className="w-40 py-1.5 text-right font-semibold">Credits to apply</th>
              </tr>
            </thead>
            <tbody>
              {offer.credits.map((c) => (
                <tr key={c.id} className="border-b border-gray-100">
                  <td className="py-2">
                    <div className="font-medium text-gray-800">
                      {c.kind === "advance"
                        ? side === "vendor"
                          ? "Vendor Advance"
                          : "Customer Advance"
                        : side === "vendor"
                          ? "Vendor Credit"
                          : "Credit Note"}
                    </div>
                    <div className="text-[12px] text-gray-500">
                      {c.number} · {formatDate(c.date)}
                    </div>
                  </td>
                  <td className="py-2 text-right tabular-nums text-gray-600">{formatMoney(c.amount)}</td>
                  <td className="py-2 text-right tabular-nums">{formatMoney(c.available)}</td>
                  <td className="py-2 pl-3 text-right">
                    <input
                      inputMode="decimal"
                      placeholder="Enter amount"
                      value={amounts[c.id] ?? ""}
                      onChange={(e) => setAmounts((a) => ({ ...a, [c.id]: e.target.value }))}
                      className="input h-8 text-right tabular-nums"
                    />
                    <button onClick={() => payInFull(c)} className="mt-1 text-[12px] text-brand-600 hover:underline">
                      Pay in Full
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex justify-end">
            <div className="w-72 space-y-1 text-[13px]">
              <div className="flex justify-between">
                <span className="text-gray-600">Total amount applied</span>
                <strong className="tabular-nums">{formatMoney(applied.toFixed(2))}</strong>
              </div>
              <div className="flex justify-between border-t pt-1">
                <span className="text-gray-600">Final balance</span>
                <strong className={`tabular-nums ${overApplied ? "text-red-600" : ""}`}>
                  {formatMoney(Math.max(left, 0).toFixed(2))}
                </strong>
              </div>
              {overApplied && (
                <p className="text-right text-[12px] text-red-600">
                  That is more than {offer.number} still owes.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3 sm:px-6">
          <button
            onClick={() => save.mutate()}
            disabled={nothing || overApplied || save.isPending}
            className="btn-primary disabled:opacity-50"
          >
            {save.isPending ? "Applying…" : "Apply"}
          </button>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
