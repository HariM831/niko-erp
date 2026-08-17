/**
 * Production — pick a formula, say how many batches, hit Produce.
 *
 * That is the whole ceremony. The tonnage is in stock the moment the button is
 * hit, costed at material prices plus overhead; there is no slip and no pending
 * state, because the slip was the old system and it is retired. A mistake is a
 * VOID — journal reversed, feed withdrawn — not a draft stage in front of every
 * real run.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Factory } from "lucide-react";
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
  const [formulaId, setFormulaId] = useState("");
  const [batchCount, setBatchCount] = useState("1");
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
      api<{ number: string; actualOutputKg: string; costPerKg: string }>(
        "/api/feed/production/produce",
        {
          method: "POST",
          body: {
            formulaId,
            batchCount: Number(batchCount),
            orderDate: new Date().toISOString().slice(0, 10),
          },
        },
      ),
    onSuccess: (r) => {
      setDone(
        `${r.number} — ${kg(r.actualOutputKg)} produced at ${inr(Number(r.costPerKg))}/kg, in stock and ready to transfer`,
      );
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

  const chosen = groups?.find((g) => g.active?.id === formulaId);
  const outputKg = chosen?.active ? Number(chosen.active.batchSizeKg) * (Number(batchCount) || 0) : 0;

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
      <header className="border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Production</h1>
        <p className="text-[13px] text-gray-500">
          A formula, a batch count, Produce — the feed is in stock and ready to transfer
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
            <div className="mb-3 flex items-center gap-2">
              <Factory size={16} className="text-brand-500" />
              <span className="text-[15px] font-semibold">Produce</span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <label className="label-required">Formula *</label>
                <select value={formulaId} onChange={(e) => setFormulaId(e.target.value)} className="input">
                  <option value="">Choose…</option>
                  {groups
                    ?.filter((g) => g.active)
                    .map((g) => (
                      <option key={g.active!.id} value={g.active!.id}>
                        {g.name} — {Number(g.active!.batchSizeKg).toLocaleString("en-IN")} kg/batch
                      </option>
                    ))}
                </select>
              </div>
              <div className="w-24">
                <label className="label-required">Batches *</label>
                <input
                  value={batchCount}
                  onChange={(e) => setBatchCount(e.target.value)}
                  inputMode="numeric"
                  className="input text-right"
                />
              </div>
              <button
                onClick={() => {
                  setDone(null);
                  setError(null);
                  produce.mutate();
                }}
                disabled={!formulaId || !(Number(batchCount) > 0) || produce.isPending}
                className="btn-primary"
              >
                {produce.isPending ? "Producing…" : "Produce"}
              </button>
            </div>
            {/* Production is spoken of in batches; the tonnage is arithmetic,
                so it reads as a line of its own rather than on the button. */}
            {outputKg > 0 && (
              <div className="mt-2 text-[13px] text-gray-600">
                {batchCount} batch{Number(batchCount) === 1 ? "" : "es"} ×{" "}
                {Number(chosen!.active!.batchSizeKg).toLocaleString("en-IN")} kg ={" "}
                <span className="font-medium text-gray-900">{kg(outputKg)}</span>
              </div>
            )}
            <p className="mt-2 text-[11px] text-gray-400">
              Costed at each material's current price plus the milling overhead, capitalised into
              Feed Stock. A wrong run is voided — reversed on the ledger, not erased from it.
            </p>
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
