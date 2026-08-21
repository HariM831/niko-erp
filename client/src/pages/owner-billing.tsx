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
  date: string;
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
  feedLines: DraftLine[];
  birdLines: DraftLine[];
  eggLines: DraftLine[];
  feedTotal: number;
  birdTotal: number;
  eggTotal: number;
  billed: {
    feedInvoiceId: string | null;
    birdInvoiceId: string | null;
    billId: string | null;
    at: string;
  } | null;
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

const dmy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y!.slice(2)}`;
};

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
          const nothing = !d.feedLines.length && !d.birdLines.length && !d.eggLines.length;
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
                  {/* Three documents, three totals, no net.
                      Feed and pullets invoice out, eggs bill in, and each
                      settles on its own terms. What the owner's account comes
                      to is a LEDGER question — it moves with every payment and
                      credit note on that contact — so it is read from their
                      ledger, not asserted here from one month. */}
                  {(
                    [
                      ["Feed · invoice", d.feedTotal],
                      ["Pullets · invoice", d.birdTotal],
                      ["Eggs · bill", d.eggTotal],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="text-right">
                      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
                      <div
                        className={`text-[15px] font-semibold tabular-nums ${
                          value > 0 ? "text-gray-900" : "text-gray-300"
                        }`}
                      >
                        {value > 0 ? money(value) : "—"}
                      </div>
                    </div>
                  ))}

                  {d.billed ? (
                    <div className="flex flex-col items-end gap-1 text-[12px]">
                      <span className="badge badge-green">Billed</span>
                      <span className="flex gap-2">
                        {d.billed.feedInvoiceId && (
                          <Link href={`/sales/invoices/${d.billed.feedInvoiceId}`} className="s-link">
                            Feed
                          </Link>
                        )}
                        {d.billed.birdInvoiceId && (
                          <Link href={`/sales/invoices/${d.billed.birdInvoiceId}`} className="s-link">
                            Pullets
                          </Link>
                        )}
                        {d.billed.billId && (
                          <Link href={`/purchases/bills/${d.billed.billId}`} className="s-link">
                            Eggs
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
              {(d.feedLines.length > 0 || d.birdLines.length > 0 || d.eggLines.length > 0) && (
                <div className="overflow-x-auto">
                  <Ledger draft={d} />
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

/**
 * The month as a ledger.
 *
 * Debit is what the owner owes Amino — the feed and the pullets sold to them.
 * Credit is what Amino owes the owner — the eggs bought back. Signed the way
 * their account in the books is signed, so this page and their ledger read the
 * same way round.
 *
 * One table in date order rather than three stacked by document type: the month
 * happened in one sequence, and the document each row lands on is a column
 * rather than a heading to scroll past.
 */
function Ledger({ draft }: { draft: Draft }) {
  const rows = [
    ...draft.feedLines.map((l) => ({ l, doc: "Feed invoice", side: "debit" as const })),
    ...draft.birdLines.map((l) => ({ l, doc: "Pullet invoice", side: "debit" as const })),
    ...draft.eggLines.map((l) => ({ l, doc: "Egg bill", side: "credit" as const })),
  ].sort((a, b) => a.l.date.localeCompare(b.l.date));

  const debit = draft.feedTotal + draft.birdTotal;
  const credit = draft.eggTotal;

  return (
    <table className="w-full text-[13px]">
      <thead className="table-head">
        <tr>
          <th className="table-th text-left">Date</th>
          <th className="table-th text-left">Particulars</th>
          <th className="table-th text-left">Document</th>
          <th className="table-th text-right">Quantity</th>
          <th className="table-th text-right">Rate</th>
          <th className="table-th text-right">Debit</th>
          <th className="table-th text-right">Credit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ l, doc, side }, i) => (
          <tr key={`${l.kind}-${i}`} className="table-row">
            <td className="table-td whitespace-nowrap text-gray-500">{dmy(l.date)}</td>
            <td className="table-td">
              {l.description}
              {l.problem && <div className="text-[11px] text-amber-700">{l.problem}</div>}
            </td>
            <td className="table-td text-gray-500">{doc}</td>
            <td className="table-td text-right tabular-nums text-gray-600">{qty(l.qty, l.unit)}</td>
            <td className="table-td text-right tabular-nums text-gray-600">
              {/* A dash, never a zero — an owner paid 0.00 an egg would not
                  notice until the quarter closed. */}
              {l.rate == null ? <span className="text-gray-300">—</span> : l.rate.toFixed(4)}
            </td>
            <td className="table-td text-right tabular-nums">
              {side === "debit" && l.amount != null ? money(l.amount) : ""}
            </td>
            <td className="table-td text-right tabular-nums">
              {side === "credit" && l.amount != null ? money(l.amount) : ""}
            </td>
          </tr>
        ))}
        <tr className="border-t border-gray-300">
          <td className="table-td font-medium text-gray-500" colSpan={5}>
            Total for the month
          </td>
          <td className="table-td text-right font-semibold tabular-nums">{money(debit)}</td>
          <td className="table-td text-right font-semibold tabular-nums">{money(credit)}</td>
        </tr>
      </tbody>
    </table>
  );
}
