/**
 * Production — pick the formulas, say how many batches of each, hit Produce.
 *
 * That is the whole ceremony. The tonnage is in stock the moment the button is
 * hit, costed at material prices plus overhead; there is no slip and no pending
 * state, because the slip was the old system and it is retired. A mistake is a
 * VOID — journal reversed, feed withdrawn — not a draft stage in front of every
 * real run.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Factory, Plus, X } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import { StatusBadge } from "../components/status-badge";

interface FormulaGroup {
  name: string;
  active: { id: string; version: number; batchSizeKg: string; outputItemName: string | null } | null;
}

interface ProductionRow {
  id: string;
  number: string;
  status: string;
  orderDate: string;
  batchCount: number;
  outputKg: string | null;
  inputValue: string | null;
  overheadValue: string | null;
  costPerKg: string | null;
  voidReason: string | null;
  formulaName: string;
  formulaVersion: number;
}

const kg = (v: string | number | null | undefined) =>
  v == null ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;
const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function FeedProductionPage() {
  const qc = useQueryClient();
  /**
   * A run is a list, not a formula. A morning at the mill is several recipes
   * one after another, and making that one action rather than four is the
   * difference between a record of what happened and four records of what
   * somebody remembered to enter.
   */
  const [runs, setRuns] = useState<Array<{ formulaId: string; batchCount: string }>>([
    { formulaId: "", batchCount: "1" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const { data: groups } = useQuery<FormulaGroup[]>({
    queryKey: ["feed-formulas"],
    queryFn: () => api("/api/feed/formulas"),
  });
  const { data: rows } = useQuery<ProductionRow[]>({
    queryKey: ["feed-production"],
    queryFn: () => api("/api/feed/production/orders"),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["feed-production"] });
    void qc.invalidateQueries({ queryKey: ["feed-transfer-context"] });
  };

  const produce = useMutation({
    mutationFn: () =>
      api<Array<{ number: string; actualOutputKg: string; costPerKg: string }>>(
        "/api/feed/production/produce",
        {
          method: "POST",
          body: {
            runs: usable.map((r) => ({
              formulaId: r.formulaId,
              batchCount: Number(r.batchCount),
            })),
            orderDate: new Date().toISOString().slice(0, 10),
          },
        },
      ),
    onSuccess: (made) => {
      setDone(
        made.length === 1
          ? `${made[0]!.number} — ${kg(made[0]!.actualOutputKg)} produced at ${inr(Number(made[0]!.costPerKg))}/kg, in stock and ready to transfer`
          : `${made.length} runs produced — ${kg(made.reduce((s, m) => s + Number(m.actualOutputKg), 0))} in stock and ready to transfer`,
      );
      setRuns([{ formulaId: "", batchCount: "1" }]);
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not produce"),
  });

  const voidRun = useMutation({
    mutationFn: (id: string) =>
      api(`/api/feed/production/orders/${id}/void`, { method: "POST", body: { reason: voidReason } }),
    onSuccess: () => {
      setDone("Production voided — journal reversed, feed withdrawn");
      setVoiding(null);
      setVoidReason("");
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not void"),
  });

  const live = groups?.filter((g) => g.active) ?? [];
  const batchKg = (id: string) => Number(live.find((g) => g.active!.id === id)?.active!.batchSizeKg ?? 0);
  const usable = runs.filter((r) => r.formulaId && Number(r.batchCount) > 0);
  const outputKg = usable.reduce((s, r) => s + batchKg(r.formulaId) * Number(r.batchCount), 0);
  // The same recipe twice would each read stock as though the other had not
  // happened, so it is caught here as well as on the server.
  const duplicated = new Set(usable.map((r) => r.formulaId)).size !== usable.length;

  /**
   * The last three days that saw production, newest first, each with its own
   * total. Three DATES WITH DATA rather than three calendar days, so a quiet
   * weekend does not blank the screen.
   */
  const byDay = (() => {
    const days = [...new Set((rows ?? []).map((r) => r.orderDate))].sort().reverse().slice(0, 3);
    return days.map((day) => {
      const dayRows = (rows ?? []).filter((r) => r.orderDate === day);
      const live = dayRows.filter((r) => r.status !== "void");
      return {
        day,
        rows: dayRows,
        totalKg: live.reduce((s, r) => s + Number(r.outputKg ?? 0), 0),
        totalValue: live.reduce(
          (s, r) => s + Number(r.inputValue ?? 0) + Number(r.overheadValue ?? 0),
          0,
        ),
      };
    });
  })();

  return (
    <div className="flex h-full flex-col">
      <header className="page-header px-6 py-3">
        <h1 className="text-lg font-semibold">Production</h1>
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
            <div className="mb-3 flex items-center gap-2">
              <Factory size={16} className="text-brand-500" />
              <span className="text-[15px] font-semibold">Produce</span>
            </div>
            {runs.map((r, i) => (
              <div key={i} className="mb-2 flex flex-wrap items-end gap-3">
                <div className="min-w-56 flex-1">
                  {i === 0 && <label className="label-required">Formula *</label>}
                  <select
                    value={r.formulaId}
                    onChange={(e) =>
                      setRuns((rs) => rs.map((x, j) => (j === i ? { ...x, formulaId: e.target.value } : x)))
                    }
                    className="input"
                  >
                    <option value="">Choose…</option>
                    {live.map((g) => (
                      <option key={g.active!.id} value={g.active!.id}>
                        {g.name} — {Number(g.active!.batchSizeKg).toLocaleString("en-IN")} kg/batch
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-24">
                  {i === 0 && <label className="label-required">Batches *</label>}
                  <input
                    value={r.batchCount}
                    onChange={(e) =>
                      setRuns((rs) => rs.map((x, j) => (j === i ? { ...x, batchCount: e.target.value } : x)))
                    }
                    inputMode="numeric"
                    className="input text-right"
                  />
                </div>
                <div className="w-28 pb-2 text-right text-[13px] tabular-nums text-gray-600">
                  {r.formulaId && Number(r.batchCount) > 0
                    ? kg(batchKg(r.formulaId) * Number(r.batchCount))
                    : ""}
                </div>
                <button
                  onClick={() => setRuns((rs) => rs.filter((_, j) => j !== i))}
                  disabled={runs.length === 1}
                  title="Take this formula out of the run"
                  className="pb-2 text-gray-300 hover:text-red-600 disabled:invisible"
                >
                  <X size={15} />
                </button>
              </div>
            ))}

            <div className="mt-1 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setRuns((rs) => [...rs, { formulaId: "", batchCount: "1" }])}
                className="flex items-center gap-1 text-[13px] text-brand-600 hover:underline"
              >
                <Plus size={14} /> Add formula
              </button>
              {/* Production is spoken of in batches; the tonnage is arithmetic,
                  so it reads as a line of its own rather than on the button. */}
              {outputKg > 0 && (
                <span className="text-[13px] text-gray-600">
                  {usable.length} formula{usable.length === 1 ? "" : "s"} ={" "}
                  <span className="font-medium text-gray-900">{kg(outputKg)}</span>
                </span>
              )}
              {duplicated && (
                <span className="text-[12px] text-red-600">
                  A formula is listed twice — add its batches together.
                </span>
              )}
              <button
                onClick={() => {
                  setDone(null);
                  setError(null);
                  produce.mutate();
                }}
                disabled={!usable.length || duplicated || produce.isPending}
                className="btn-primary ml-auto"
              >
                {produce.isPending ? "Producing…" : "Produce"}
              </button>
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
              <div key={r.id} className="border-b border-gray-100 px-4 py-2 last:border-0">
                <div className="flex items-baseline justify-between">
                  <div className="min-w-0">
                    <span className="font-mono text-[13px] font-semibold">{r.number}</span>
                    <span className={`ml-2 text-[12px] ${r.status === "void" ? "text-gray-400 line-through" : "text-gray-600"}`}>
                      {r.formulaName} v{r.formulaVersion} · {r.batchCount} batch{r.batchCount === 1 ? "" : "es"} ·{" "}
                      {kg(r.outputKg)}
                    </span>
                    {r.status === "void" && <StatusBadge status="void" />}
                  </div>
                  <div className="flex shrink-0 items-center gap-3 pl-3">
                    <span className="text-[12px] tabular-nums text-gray-500">
                      {r.costPerKg == null ? "—" : `${inr(Number(r.costPerKg))}/kg`}
                    </span>
                    {r.status === "completed" && (
                      <button
                        onClick={() => {
                          setVoiding(voiding === r.id ? null : r.id);
                          setVoidReason("");
                        }}
                        className="text-[11px] text-gray-400 hover:text-red-600"
                      >
                        Void
                      </button>
                    )}
                  </div>
                </div>
                {r.status === "void" && r.voidReason && (
                  <div className="text-[11px] text-gray-400">{r.voidReason}</div>
                )}
                {voiding === r.id && (
                  <div className="mt-1.5 flex gap-2">
                    <input
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      placeholder="Why is this run being voided?"
                      className="input h-8 flex-1 text-[12px]"
                      autoFocus
                    />
                    <button
                      onClick={() => voidRun.mutate(r.id)}
                      disabled={voidReason.trim().length < 3 || voidRun.isPending}
                      className="btn-secondary h-8 text-[12px] text-red-700"
                    >
                      Void it
                    </button>
                  </div>
                )}
              </div>
              ))}
            </div>
          ))}
          <div>
            {rows && !rows.length && (
              <p className="card p-4 text-center text-[13px] text-gray-400">Nothing produced yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
