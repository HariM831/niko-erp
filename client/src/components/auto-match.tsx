import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";

interface Proposal {
  line: { id: string; date: string; direction: "credit" | "debit"; amount: string; description: string | null; utr: string | null };
  match: {
    journalEntryId: string;
    entryNumber: string;
    date: string;
    typeLabel: string;
    party: string | null;
    reference: string | null;
    docPath: string;
  };
  sameRef: boolean;
  samePayer: boolean;
}

/**
 * Auto-match: the lines with one confident fit in the books — the same amount
 * within three days, and the bank's reference or the payer to tie them — set
 * out for the person to tick through before anything is matched. Whatever is
 * left stays uncategorized for the pane.
 */
export function AutoMatchReview({
  bankAccountId,
  onClose,
  onDone,
}: {
  bankAccountId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["auto-match", bankAccountId],
    queryFn: () => api<{ uncategorized: number; proposals: Proposal[] }>(`/api/banking/accounts/${bankAccountId}/auto-match`),
  });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setTicked(new Set(data.proposals.map((p) => p.line.id)));
  }, [data]);

  const proposals = data?.proposals ?? [];
  const allOn = proposals.length > 0 && ticked.size === proposals.length;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const pairs = proposals
        .filter((p) => ticked.has(p.line.id))
        .map((p) => ({ bankTransactionId: p.line.id, journalEntryId: p.match.journalEntryId }));
      const out = await api<{ matched: number; failed: Array<{ bankTransactionId: string; error: string }> }>(
        `/api/banking/accounts/${bankAccountId}/auto-match`,
        { method: "POST", body: { pairs } },
      );
      await qc.invalidateQueries();
      onDone(
        `Matched ${out.matched} line${out.matched === 1 ? "" : "s"}.` +
          (out.failed.length ? ` ${out.failed.length} no longer fit and were left: ${out.failed[0]!.error}` : ""),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto-match failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b bg-gray-50 px-6 py-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[14px] font-semibold">Auto-match</h3>
          <p className="text-xs text-gray-500">
            Each line below has exactly one transaction in the books with the same amount within three days, tied by the bank's
            reference or the payer the statement names. Untick any you doubt; nothing is matched until you confirm.
          </p>
        </div>
        <button onClick={onClose} className="text-[13px] text-gray-500 hover:underline">
          Close
        </button>
      </div>

      {!data ? (
        <p className="py-6 text-center text-sm text-gray-400">Looking for matches…</p>
      ) : !proposals.length ? (
        <p className="py-6 text-center text-sm text-gray-500">
          None of the {data.uncategorized} uncategorized lines has a match certain enough to make without you. Open a line to
          match or categorize it.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[13px]">
            <span className="font-semibold text-green-700">{proposals.length}</span> of {data.uncategorized} uncategorized lines
            can be matched. The other {data.uncategorized - proposals.length} stay for you.
          </p>
          <div className="max-h-[28rem] overflow-auto rounded border bg-white">
            <table className="w-full text-[12px]">
              <thead className="table-head sticky top-0">
                <tr>
                  <th className="w-8 border-b border-[#ece3d5] px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={allOn}
                      onChange={() => setTicked(allOn ? new Set() : new Set(proposals.map((p) => p.line.id)))}
                    />
                  </th>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5">Statement</th>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5 text-right">Amount</th>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5">Matches</th>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5">Why</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => {
                  const on = ticked.has(p.line.id);
                  return (
                    <tr key={p.line.id} className={`border-b border-[#ece3d5] align-top ${on ? "" : "opacity-50"}`}>
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setTicked((t) => {
                              const next = new Set(t);
                              if (next.has(p.line.id)) next.delete(p.line.id);
                              else next.add(p.line.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="text-gray-500">{formatDate(p.line.date)}</div>
                        <div className="max-w-80 break-words">{p.line.description ?? p.line.utr ?? "—"}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        <div>{formatMoney(p.line.amount)}</div>
                        <div className="text-[11px] text-gray-400">{p.line.direction === "credit" ? "Deposit" : "Withdrawal"}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <div>
                          {p.match.typeLabel}{" "}
                          <a href={p.match.docPath} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                            {p.match.entryNumber}
                          </a>
                        </div>
                        <div className="text-gray-500">
                          {formatDate(p.match.date)}
                          {p.match.party ? ` · ${p.match.party}` : ""}
                        </div>
                        {p.match.reference && <div className="text-[11px] text-gray-400">{p.match.reference}</div>}
                      </td>
                      <td className="space-x-1 px-2 py-1.5 whitespace-nowrap">
                        {p.sameRef && (
                          <span className="rounded bg-blue-100 px-1.5 text-[10px] font-semibold uppercase text-blue-700">Same ref</span>
                        )}
                        {p.samePayer && (
                          <span className="rounded bg-green-100 px-1.5 text-[10px] font-semibold uppercase text-green-700">Same payer</span>
                        )}
                        {p.line.date !== p.match.date && (
                          <span className="rounded bg-gray-100 px-1.5 text-[10px] font-semibold uppercase text-gray-600">
                            {Math.round((Date.parse(p.match.date) - Date.parse(p.line.date)) / 86_400_000) > 0 ? "+" : ""}
                            {Math.round((Date.parse(p.match.date) - Date.parse(p.line.date)) / 86_400_000)}d
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button onClick={() => void confirm()} disabled={busy || !ticked.size} className="btn-primary">
              Match {ticked.size} line{ticked.size === 1 ? "" : "s"}
            </button>
            <button onClick={onClose} className="text-[13px] text-gray-500 hover:underline">
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
