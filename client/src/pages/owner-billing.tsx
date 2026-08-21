import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";

/**
 * Owner billing — what passed between Amino and the people who own sheds.
 *
 * Nandamuri owns L2–L3, Luit Valley owns L4–L5, and the rearing houses are
 * Amino's. So each month Amino sells them feed, sells them the pullets that
 * were housed, and buys the eggs back.
 *
 * The draft is shown before anything is raised, and every figure is traceable
 * to a delivery, a transfer or a day's lay. Raising posts an invoice and a
 * bill; a month cannot be raised twice, and a month with any unpriced line
 * cannot be raised at all — the button says why rather than going quiet.
 */

interface DraftLine {
  kind: "feed" | "birds" | "eggs";
  description: string;
  qty: number;
  unit: string;
  rate: number | null;
  amount: number | null;
  problem?: string;
}

interface Draft {
  owner: { id: string; name: string };
  period: string;
  from: string;
  to: string;
  invoiceLines: DraftLine[];
  billLines: DraftLine[];
  invoiceTotal: number;
  billTotal: number;
  billed: { invoiceId: string | null; billId: string | null; at: string } | null;
  problems: string[];
}

const money = (v: number) =>
  `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (v: number, unit: string) =>
  `${v.toLocaleString("en-IN", { maximumFractionDigits: unit === "kg" ? 2 : 0 })} ${unit}`;

/** Last month, since that is the one that gets billed. */
function lastMonth() {
  const d = new Date();
  d.setDate(0);
  return d.toISOString().slice(0, 7);
}

const monthLabel = (p: string) =>
  new Date(`${p}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

export function OwnerBillingPage() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(lastMonth());
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ drafts: Draft[] }>({
    queryKey: ["owner-billing", period],
    queryFn: () => api(`/api/owner-billing/drafts?period=${period}`),
  });

  const raise = useMutation({
    mutationFn: (contactId: string) =>
      // `api` stringifies for us — passing a string here double-encodes it,
      // and express.json() is strict enough to refuse a bare JSON string.
      api("/api/owner-billing/raise", { method: "POST", body: { contactId, period } }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["owner-billing"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not raise the documents."),
  });

  const drafts = data?.drafts ?? [];

  return (
    <div className="p-4 md:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Owner billing</h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            Feed and pullets Amino sold them, and the eggs Amino bought back.
          </p>
        </div>
        <div className="w-44">
          <label className="label">Month</label>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="input"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>
      )}

      {isLoading && <p className="text-[13px] text-gray-500">Loading…</p>}

      {!isLoading && !drafts.length && (
        <div className="table-surface p-6 text-center">
          <p className="text-[14px] font-medium text-gray-900">No shed has an owner yet.</p>
          <p className="mt-1 text-[13px] text-gray-500">
            Set an owner on a house under Farms → Houses, and its feed and eggs will appear here.
          </p>
        </div>
      )}

      <div className="space-y-5">
        {drafts.map((d) => {
          const blocked = d.problems.length > 0;
          const nothing = !d.invoiceLines.length && !d.billLines.length;
          return (
            <div key={d.owner.id} className="table-surface">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <h2 className="text-[15px] font-semibold text-gray-900">{d.owner.name}</h2>
                  <p className="text-[12px] text-gray-500">
                    {monthLabel(period)} · {d.from} to {d.to} ·{" "}
                    <Link href={`/sales/customers/${d.owner.id}`} className="s-link">
                      their ledger
                    </Link>
                  </p>
                </div>

                <div className="flex items-center gap-5">
                  {/* Two documents, two totals, no net.
                      The invoice is a receivable and the bill is a payable, and
                      each settles on its own terms. What the owner's account
                      comes to is a LEDGER question — it moves with every
                      payment and credit note on that contact — so it is read
                      from their ledger, not asserted here from one month. */}
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wide text-gray-400">
                      Invoice · receivable
                    </div>
                    <div className="text-[15px] font-semibold tabular-nums text-gray-900">
                      {money(d.invoiceTotal)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wide text-gray-400">
                      Bill · payable
                    </div>
                    <div className="text-[15px] font-semibold tabular-nums text-gray-900">
                      {money(d.billTotal)}
                    </div>
                  </div>

                  {d.billed ? (
                    <div className="flex flex-col items-end gap-1 text-[12px]">
                      <span className="badge badge-green">Billed</span>
                      <span className="flex gap-2">
                        {d.billed.invoiceId && (
                          <Link href={`/sales/invoices/${d.billed.invoiceId}`} className="s-link">
                            Invoice
                          </Link>
                        )}
                        {d.billed.billId && (
                          <Link href={`/purchases/bills/${d.billed.billId}`} className="s-link">
                            Bill
                          </Link>
                        )}
                      </span>
                    </div>
                  ) : (
                    <button
                      onClick={() => raise.mutate(d.owner.id)}
                      disabled={blocked || nothing || raise.isPending}
                      title={
                        blocked
                          ? d.problems.join("; ")
                          : nothing
                            ? "Nothing passed between the two this month"
                            : undefined
                      }
                      className="btn-primary min-h-[36px]"
                    >
                      {raise.isPending ? "Raising…" : "Raise invoice & bill"}
                    </button>
                  )}
                </div>
              </div>

              {/* Every figure traces to a delivery, a housing or a day's lay —
                  a total nobody can take apart is a total nobody trusts. */}
              {(d.invoiceLines.length > 0 || d.billLines.length > 0) && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead className="table-head">
                      <tr>
                        <th className="table-th">What</th>
                        <th className="table-th text-right">Quantity</th>
                        <th className="table-th text-right">Rate</th>
                        <th className="table-th text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      <Section
                        title={`Amino → ${d.owner.name}`}
                        lines={d.invoiceLines}
                        total={d.invoiceTotal}
                        totalLabel="Invoice"
                      />
                      <Section
                        title={`${d.owner.name} → Amino`}
                        lines={d.billLines}
                        total={d.billTotal}
                        totalLabel="Bill"
                      />
                    </tbody>
                  </table>
                </div>
              )}

              {blocked && (
                <div className="px-4 py-3 text-[12px] text-amber-700">
                  {d.problems.map((p) => (
                    <div key={p}>· {p}</div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({
  title,
  lines,
  total,
  totalLabel,
}: {
  title: string;
  lines: DraftLine[];
  total: number;
  totalLabel: string;
}) {
  if (!lines.length) return null;
  return (
    <>
      <tr>
        <td colSpan={4} className="bg-gray-50/60 px-3 py-1.5 text-[11px] uppercase tracking-wide text-gray-500">
          {title}
        </td>
      </tr>
      {lines.map((l, i) => (
        <tr key={`${l.kind}-${i}`} className="table-row">
          <td className="table-td">
            {l.description}
            {l.problem && <div className="text-[11px] text-amber-700">{l.problem}</div>}
          </td>
          <td className="table-td text-right tabular-nums">{qty(l.qty, l.unit)}</td>
          <td className="table-td text-right tabular-nums">
            {/* A dash, never a zero — an owner paid ₹0.00 an egg would not
                notice until the quarter closed. */}
            {l.rate == null ? <span className="text-gray-300">—</span> : `₹${l.rate.toFixed(4)}`}
          </td>
          <td className="table-td text-right tabular-nums">
            {l.amount == null ? <span className="text-gray-300">—</span> : money(l.amount)}
          </td>
        </tr>
      ))}
      <tr>
        <td className="table-td text-right text-[12px] font-medium text-gray-500" colSpan={3}>
          {totalLabel}
        </td>
        <td className="table-td text-right font-semibold tabular-nums">{money(total)}</td>
      </tr>
    </>
  );
}
