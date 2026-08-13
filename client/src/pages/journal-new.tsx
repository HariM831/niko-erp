import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatMoney } from "../api";

interface Account {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface TagOption {
  id: string;
  name: string;
  isActive: boolean;
}
interface ReportingTag {
  id: string;
  name: string;
  isActive: boolean;
  options: TagOption[];
}

interface JLine {
  accountId: string;
  debit: string;
  credit: string;
  description: string;
  /** Chosen option per tag. One column per tag makes "one option per tag"
      structural — there is nowhere to put a second vehicle. */
  tags: Record<string, string>;
}

const emptyLine = (): JLine => ({
  accountId: "",
  debit: "",
  credit: "",
  description: "",
  tags: {},
});

export function JournalNewPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState("");
  const [reference, setReference] = useState("");
  const [seriesId, setSeriesId] = useState("");
  const [lines, setLines] = useState<JLine[]>([emptyLine(), emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  // Only offered when the org actually runs more than one series.
  const { data: allSeries } = useQuery({
    queryKey: ["series"],
    queryFn: () =>
      api<Array<{ id: string; name: string; isDefault: boolean; isActive: boolean }>>(
        "/api/settings/series",
      ),
  });
  const series = (allSeries ?? []).filter((s) => s.isActive);
  const { data: allTags } = useQuery({
    queryKey: ["reporting-tags"],
    queryFn: () => api<ReportingTag[]>("/api/reporting-tags"),
  });
  // A tag with no usable options would only add an empty column.
  const tags = (allTags ?? [])
    .filter((t) => t.isActive)
    .map((t) => ({ ...t, options: t.options.filter((o) => o.isActive) }))
    .filter((t) => t.options.length > 0);

  const { totalDebit, totalCredit } = useMemo(() => {
    let d = 0;
    let c = 0;
    for (const l of lines) {
      d += Number(l.debit || 0);
      c += Number(l.credit || 0);
    }
    return { totalDebit: d, totalCredit: c };
  }, [lines]);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.005 && totalDebit > 0;

  const update = (i: number, patch: Partial<JLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/accounting/journals", {
        method: "POST",
        body: {
          entryDate: date,
          narration,
          reference: reference || undefined,
          seriesId: seriesId || undefined,
          lines: lines
            .filter((l) => l.accountId && (Number(l.debit) > 0 || Number(l.credit) > 0))
            .map((l) => ({
              accountId: l.accountId,
              debit: Number(l.debit) > 0 ? Number(l.debit).toFixed(2) : undefined,
              credit: Number(l.credit) > 0 ? Number(l.credit).toFixed(2) : undefined,
              description: l.description || undefined,
              tagOptionIds: Object.values(l.tags).filter(Boolean),
            })),
        },
      });
      await qc.invalidateQueries();
      navigate("/accountant/journals");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Posting failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">New Journal Entry</h1>
        <button onClick={() => navigate("/accountant/journals")} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-5 grid max-w-3xl grid-cols-3 gap-4">
          <div>
            <label className="label-required">Date *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </div>
          <div className="col-span-2">
            <label className="label-required">Narration *</label>
            <input value={narration} onChange={(e) => setNarration(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="label">Reference</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
          </div>
          {series.length > 1 && (
            <div>
              <label className="label">Number Series</label>
              <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)} className={inputCls}>
                {series.map((s) => (
                  <option key={s.id} value={s.isDefault ? "" : s.id}>
                    {s.name}
                    {s.isDefault ? " (Default)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className={tags.length ? "mb-3 overflow-x-auto" : "mb-3"}>
        <table className={`text-[13px] ${tags.length ? "w-max min-w-full" : "w-full max-w-4xl"}`}>
          <thead className="table-head">
            <tr>
              <th className="border border-[#ebeaf2] px-2 py-2">Account</th>
              <th className="w-32 border border-[#ebeaf2] px-2 py-2 text-right">Debit</th>
              <th className="w-32 border border-[#ebeaf2] px-2 py-2 text-right">Credit</th>
              <th className="border border-[#ebeaf2] px-2 py-2">Description</th>
              {tags.map((t) => (
                <th key={t.id} className="w-44 border border-[#ebeaf2] px-2 py-2 whitespace-nowrap">
                  {t.name}
                </th>
              ))}
              <th className="w-8 border border-[#ebeaf2]" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="border border-[#ebeaf2] px-1 py-1">
                  <select value={l.accountId} onChange={(e) => update(i, { accountId: e.target.value })} className={inputCls}>
                    <option value="">Select account…</option>
                    {accounts
                      ?.filter((a) => a.isActive)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                  </select>
                </td>
                <td className="border border-[#ebeaf2] px-1 py-1">
                  <input
                    value={l.debit}
                    onChange={(e) => update(i, { debit: e.target.value, credit: "" })}
                    placeholder="0.00"
                    className={`${inputCls} text-right tabular-nums`}
                  />
                </td>
                <td className="border border-[#ebeaf2] px-1 py-1">
                  <input
                    value={l.credit}
                    onChange={(e) => update(i, { credit: e.target.value, debit: "" })}
                    placeholder="0.00"
                    className={`${inputCls} text-right tabular-nums`}
                  />
                </td>
                <td className="border border-[#ebeaf2] px-1 py-1">
                  <input value={l.description} onChange={(e) => update(i, { description: e.target.value })} className={inputCls} />
                </td>
                {tags.map((t) => (
                  <td key={t.id} className="border border-[#ebeaf2] px-1 py-1">
                    <select
                      value={l.tags[t.id] ?? ""}
                      onChange={(e) =>
                        update(i, { tags: { ...l.tags, [t.id]: e.target.value } })
                      }
                      className={inputCls}
                    >
                      <option value="">—</option>
                      {t.options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
                <td className="border border-[#ebeaf2] text-center">
                  {lines.length > 2 && (
                    <button onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600">
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="border border-[#ebeaf2] px-2 py-2 text-right">Total</td>
              <td className="border border-[#ebeaf2] px-2 py-2 text-right tabular-nums">{formatMoney(totalDebit)}</td>
              <td className="border border-[#ebeaf2] px-2 py-2 text-right tabular-nums">{formatMoney(totalCredit)}</td>
              <td
                colSpan={2 + tags.length}
                className={`border px-2 py-2 ${balanced ? "text-green-700" : "text-amber-700"}`}
              >
                {balanced
                  ? "Balanced ✓"
                  : `Unbalanced by ${formatMoney(Math.abs(totalDebit - totalCredit))}`}
              </td>
            </tr>
          </tfoot>
        </table>
        </div>
        <button onClick={() => setLines((ls) => [...ls, emptyLine()])} className="text-[13px] font-medium text-brand-600 hover:underline">
          + Add line
        </button>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void post()}
          disabled={busy || !date || !balanced || !narration.trim()}
          className="btn-primary"
        >
          Post Journal
        </button>
        <button onClick={() => navigate("/accountant/journals")} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
