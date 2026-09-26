/**
 * Clearing a whole party's credit at once.
 *
 * The per-document dialog next door is right when you are standing on the
 * document. It is the wrong shape for a backlog: after the Zoho load, 26
 * customers and 23 vendors were carrying money on account against open
 * documents it plainly settled, and matching them an invoice at a time is
 * sixty screens of the same decision.
 *
 * This shows the party's whole ledger side by side — what is open, what is
 * spare, and which credit the oldest-first rule would put against which
 * document — and posts it only when somebody presses Apply. The proposal is
 * arithmetic, never a guess at which invoice a payment was "really" for; a
 * line that looks wrong is a reason to close this and use the per-document
 * dialog, which is still there.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, formatDate, formatMoney } from "../api";

export interface PlannedApplication {
  documentId: string;
  documentNumber: string;
  kind: "advance" | "credit";
  id: string;
  number: string;
  amount: string;
}

export interface CreditPlan {
  documents: Array<{ id: string; number: string; date: string; balanceDue: string }>;
  credits: Array<{ kind: "advance" | "credit"; id: string; number: string; date: string; amount: string; available: string }>;
  plan: PlannedApplication[];
  totalOwed: string;
  totalAvailable: string;
  totalApplied: string;
  owedAfter: string;
  availableAfter: string;
}

const base = (side: "vendor" | "customer", id: string) =>
  side === "vendor" ? `/api/purchases/vendors/${id}` : `/api/sales/customers/${id}`;

/** What this party has spare and what it would settle, or null while it loads. */
export function useCreditPlan(side: "vendor" | "customer", contactId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["credit-plan", side, contactId],
    queryFn: () => api<CreditPlan>(`${base(side, contactId)}/credit-plan`),
    enabled,
  });
}

export function ApplyCreditPlanDialog({
  side,
  contactId,
  contactName,
  plan,
  onClose,
  onApplied,
}: {
  side: "vendor" | "customer";
  contactId: string;
  contactName: string;
  plan: CreditPlan;
  onClose: () => void;
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<{ documents: number; applied: string }>(`${base(side, contactId)}/apply-credit-plan`, {
        method: "POST",
        // The lines that were on screen, not a fresh calculation: what is
        // posted has to be what was read and agreed.
        body: { plan: plan.plan },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onApplied();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not apply the credits"),
  });

  const documentLabel = side === "vendor" ? "bill" : "invoice";
  const nothing = plan.plan.length === 0;

  /* Grouped for reading: one block per document, its lines beneath it. */
  const byDocument = plan.documents
    .map((d) => ({ doc: d, lines: plan.plan.filter((l) => l.documentId === d.id) }))
    .filter((g) => g.lines.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-3 py-8">
      <div role="dialog" aria-label="Apply credits" className="w-full max-w-4xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-3 sm:px-6">
          <h2 className="text-[15px] font-semibold text-gray-800">Apply {contactName}&rsquo;s credits</h2>
          <button onClick={onClose} aria-label="Close" className="text-2xl leading-none text-gray-400 hover:text-gray-700">
            ×
          </button>
        </div>

        {error && <p className="border-b bg-red-50 px-5 py-2 text-[13px] text-red-700 sm:px-6">{error}</p>}

        <div className="px-5 py-4 sm:px-6">
          {nothing ? (
            <p className="py-6 text-center text-[13px] text-gray-500">
              {plan.credits.length === 0
                ? `${contactName} has nothing spare on their ledger.`
                : `${contactName} has ${formatMoney(plan.totalAvailable)} spare, but no open ${documentLabel} to put it against.`}
            </p>
          ) : (
            <>
              <p className="mb-3 text-[13px] text-gray-600">
                Oldest {documentLabel} first, settled with the oldest credit that has anything left. Read it
                before you post it — nothing here guesses which {documentLabel} a payment was meant for.
              </p>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="py-1.5 text-left font-semibold">Applied to</th>
                    <th className="py-1.5 text-left font-semibold">From</th>
                    <th className="py-1.5 text-right font-semibold">Amount</th>
                    <th className="py-1.5 text-right font-semibold">Left on it</th>
                  </tr>
                </thead>
                <tbody>
                  {byDocument.map(({ doc, lines }) => {
                    const applied = lines.reduce((s, l) => s + Number(l.amount), 0);
                    const after = Number(doc.balanceDue) - applied;
                    return lines.map((l, i) => (
                      <tr key={`${l.documentId}:${l.id}`} className="border-b border-gray-100">
                        <td className="py-2">
                          {i === 0 && (
                            <>
                              <div className="font-medium text-gray-800">{doc.number}</div>
                              <div className="text-[12px] text-gray-500">
                                {formatDate(doc.date)} · {formatMoney(doc.balanceDue)} open
                              </div>
                            </>
                          )}
                        </td>
                        <td className="py-2">
                          <span className="text-gray-800">{l.number}</span>
                          <span className="ml-2 text-[12px] text-gray-500">
                            {l.kind === "advance" ? "advance" : "credit note"}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums">{formatMoney(l.amount)}</td>
                        <td className="py-2 text-right tabular-nums text-gray-600">
                          {i === lines.length - 1 ? (
                            <span className={after === 0 ? "font-medium text-green-700" : ""}>
                              {after === 0 ? "settled" : formatMoney(after.toFixed(2))}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ));
                  })}
                </tbody>
              </table>

              <div className="mt-4 flex justify-end">
                <div className="w-80 space-y-1 text-[13px]">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Open before</span>
                    <span className="tabular-nums">{formatMoney(plan.totalOwed)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Credit available</span>
                    <span className="tabular-nums">{formatMoney(plan.totalAvailable)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-1">
                    <span className="text-gray-600">Applied by this</span>
                    <strong className="tabular-nums">{formatMoney(plan.totalApplied)}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Still open after</span>
                    <strong className="tabular-nums">{formatMoney(plan.owedAfter)}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Still spare after</span>
                    <strong className="tabular-nums">{formatMoney(plan.availableAfter)}</strong>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3 sm:px-6">
          <button
            onClick={() => save.mutate()}
            disabled={nothing || save.isPending}
            className="btn-primary disabled:opacity-50"
          >
            {save.isPending ? "Applying…" : `Apply ${formatMoney(plan.totalApplied)}`}
          </button>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
