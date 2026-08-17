/**
 * The Formulator — the cheapest mix that still meets the standard.
 *
 * Nothing numeric travels from this screen: it names a stage, ticks materials,
 * and sets inclusion limits. Prices come from the stock ledger, analyses from
 * the nutrient profiles, bounds from the live standard — so what the solve says
 * is what production would actually cost today.
 *
 * The shadow price table is the reason to open this screen without meaning to
 * produce anything: for each material the mix left out, the price at which it
 * would start earning its place. That is what a buyer holds a quote against.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Calculator } from "lucide-react";
import { ApiError, api } from "../api";
import { LIFE_STAGES, LIFE_STAGE_LABELS, nutrientLabel, type LifeStage } from "@shared/feed";

interface IndexRow {
  id: string;
  name: string;
  measured: number;
}

interface SolveResponse {
  feasible: boolean;
  message?: string;
  solution: Record<string, number>;
  rawCostPerKg: number;
  costPerKg: number;
  totalCostPer100kg: number;
  nutritionAnalysis: Record<string, number>;
  unmeasured: Array<{ ingredientName: string; nutrients: string[] }>;
  shadowPrices: Array<{
    ingredientId: string;
    ingredientName: string;
    currentPrice: number;
    breakEvenPrice: number | null;
    wouldEnter: boolean;
    insight: string;
  }>;
  standardVersion: number;
  prices: Record<string, number | null>;
  unpriced: string[];
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function FeedFormulatorPage() {
  const [stage, setStage] = useState<LifeStage>("layer_1");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, { min: string; max: string }>>({});
  const [result, setResult] = useState<SolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: materials } = useQuery<IndexRow[]>({
    queryKey: ["feed-nutrients"],
    queryFn: () => api("/api/feed/nutrients"),
  });

  const considered = useMemo(
    () => (materials ?? []).filter((m) => !excluded.has(m.id)),
    [materials, excluded],
  );

  const solve = useMutation({
    mutationFn: () =>
      api<SolveResponse>("/api/feed/formulator/solve", {
        method: "POST",
        body: {
          stage,
          itemIds: considered.map((m) => m.id),
          limits: Object.fromEntries(
            Object.entries(limits)
              .map(([id, l]) => [
                id,
                {
                  ...(l.min.trim() !== "" ? { min: Number(l.min) } : {}),
                  ...(l.max.trim() !== "" ? { max: Number(l.max) } : {}),
                },
              ])
              .filter(([, l]) => Object.keys(l as object).length > 0),
          ),
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Solve failed"),
  });

  const setLimit = (id: string, patch: Partial<{ min: string; max: string }>) =>
    setLimits((s) => ({ ...s, [id]: { min: "", max: "", ...s[id], ...patch } }));

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Formulator</h1>
        <p className="text-[13px] text-gray-500">
          The cheapest mix that still lands inside the standard — priced from today's stock ledger
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-surface p-3 lg:p-6">
        <div className="mx-auto max-w-3xl">
          <div className="card mb-4 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="label">Life stage</label>
                <select value={stage} onChange={(e) => setStage(e.target.value as LifeStage)} className="input h-9 w-44">
                  {LIFE_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {LIFE_STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => solve.mutate()}
                disabled={solve.isPending || !considered.length}
                className="btn-primary flex items-center gap-1.5"
              >
                <Calculator size={15} />
                {solve.isPending ? "Solving…" : "Solve"}
              </button>
              <span className="pb-2 text-[12px] text-gray-400">
                {considered.length} of {materials?.length ?? 0} materials considered
              </span>
            </div>

            <div className="mt-3 border-t pt-2">
              <div className="label mb-1">Materials</div>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                {materials?.map((m) => {
                  const l = limits[m.id];
                  const out = excluded.has(m.id);
                  return (
                    <div key={m.id} className="flex items-center gap-2 text-[12px]">
                      <label className={`flex min-w-0 flex-1 items-center gap-1.5 ${out ? "text-gray-400" : "text-gray-700"}`}>
                        <input
                          type="checkbox"
                          checked={!out}
                          onChange={(e) =>
                            setExcluded((s) => {
                              const next = new Set(s);
                              if (e.target.checked) next.delete(m.id);
                              else next.add(m.id);
                              return next;
                            })
                          }
                        />
                        <span className="truncate">{m.name}</span>
                        {m.measured === 0 && <span className="shrink-0 text-[10px] text-amber-600">no analysis</span>}
                      </label>
                      {!out && (
                        // Widths on wrappers: `.input` carries w-full and beats a
                        // width utility on the control itself.
                        <div className="flex shrink-0 items-center gap-1">
                          <div className="w-14">
                            <input
                              value={l?.min ?? ""}
                              onChange={(e) => setLimit(m.id, { min: e.target.value })}
                              placeholder="min%"
                              inputMode="decimal"
                              className="input h-6 px-1 text-right text-[11px]"
                            />
                          </div>
                          <div className="w-14">
                            <input
                              value={l?.max ?? ""}
                              onChange={(e) => setLimit(m.id, { max: e.target.value })}
                              placeholder="max%"
                              inputMode="decimal"
                              className="input h-6 px-1 text-right text-[11px]"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          )}

          {result && !result.feasible && (
            <div className="card border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-800">
              {result.message}
            </div>
          )}

          {result?.feasible && (
            <>
              <div className="card mb-4 p-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="label">Optimal mix — per 100 kg</span>
                  <span className="text-[15px] font-semibold text-green-700">
                    {inr(result.costPerKg)}/kg delivered
                    <span className="ml-2 text-[11px] font-normal text-gray-400">
                      raw {inr(result.rawCostPerKg)}/kg · standard v{result.standardVersion}
                    </span>
                  </span>
                </div>
                <table className="w-full text-[13px]">
                  <tbody>
                    {Object.entries(result.solution)
                      .sort(([, a], [, b]) => b - a)
                      .map(([id, pctOf]) => {
                        const m = materials?.find((x) => x.id === id);
                        const price = result.prices[id];
                        return (
                          <tr key={id} className="border-b border-gray-100">
                            <td className="py-1">{m?.name ?? id}</td>
                            <td className="py-1 text-right tabular-nums text-gray-500">
                              {price != null ? `${inr(price)}/kg` : "—"}
                            </td>
                            <td className="w-24 py-1 text-right font-medium tabular-nums">{pctOf.toFixed(2)}%</td>
                            <td className="w-24 py-1 text-right tabular-nums text-gray-500">{pctOf.toFixed(2)} kg</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>

                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t pt-2 sm:grid-cols-3">
                  {Object.entries(result.nutritionAnalysis).map(([k, v]) => (
                    <div key={k} className="flex justify-between text-[12px]">
                      <span className="text-gray-500">{nutrientLabel(k)}</span>
                      <span className="tabular-nums font-medium">{v}</span>
                    </div>
                  ))}
                </div>

                {result.unmeasured.length > 0 && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    Treated as zero for want of a figure:{" "}
                    {result.unmeasured
                      .map((u) => `${u.ingredientName} (${u.nutrients.map(nutrientLabel).join(", ")})`)
                      .join("; ")}
                    . The mix may be better or worse than it reads — measure these before trusting it.
                  </div>
                )}
              </div>

              {result.shadowPrices.length > 0 && (
                <div className="card p-4">
                  <div className="label mb-1">Left out — and the price that would change it</div>
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-gray-400">
                        <th className="pb-1 text-left font-semibold">Material</th>
                        <th className="pb-1 text-right font-semibold">Today</th>
                        <th className="pb-1 text-right font-semibold">Break-even</th>
                        <th className="pb-1 text-left font-semibold sm:pl-4">Reading</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.shadowPrices.map((s) => (
                        <tr key={s.ingredientId} className="border-b border-gray-100">
                          <td className="py-1">{s.ingredientName}</td>
                          <td className="py-1 text-right tabular-nums">{inr(s.currentPrice)}</td>
                          <td className="py-1 text-right tabular-nums font-medium">
                            {s.breakEvenPrice == null ? "—" : inr(s.breakEvenPrice)}
                          </td>
                          <td className="py-1 text-[11px] text-gray-500 sm:pl-4">{s.insight}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[11px] text-gray-400">
                    Break-even is what a quote has to beat. Below it, the material enters the mix and
                    the feed gets cheaper; above it, the current recipe already wins.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
