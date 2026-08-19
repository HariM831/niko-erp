/**
 * A formula, re-solved against what a life stage asks for.
 *
 * This IS the single-formula view. Opening a recipe used to show a form for
 * typing kilos into, which is a worse tool than a pencil: the interesting
 * question about a formula is never "what is in it" — the comparison answers
 * that — but "given today's prices, what should be in it".
 *
 * A standard on the right, the materials you are willing to buy on the left,
 * solve, and save it as the next version.
 *
 * Nothing numeric travels from this screen: it names a stage, names materials,
 * and sets inclusion limits. Prices come from the stock ledger, analyses from
 * the nutrient profiles, bounds from the live standard — so what the solve says
 * is what production would actually cost today.
 *
 * Two things earn their place beyond the mix itself. An infeasible solve names
 * the bound it cannot meet, because "no solution" tells a nutritionist nothing
 * about what to change. And the shadow prices say, for every material the mix
 * left out, the price at which it would start earning its place — which is what
 * a buyer holds a quote against.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, Plus, X } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import { LIFE_STAGES, LIFE_STAGE_LABELS, nutrientLabel, type LifeStage } from "@shared/feed";

interface Material {
  id: string;
  name: string;
  measured: number;
}

interface FormulaGroup {
  name: string;
  active: {
    id: string;
    version: number;
    outputItemId: string;
    outputItemName: string | null;
    stage: LifeStage | null;
    batchSizeKg: string;
    lines: Array<{ itemId: string; itemName: string; quantityKg: string; minPercent: string | null; maxPercent: string | null }>;
  } | null;
  history: Array<{
    version: number;
    effectiveFrom: string;
    isActive: boolean;
    createdByName: string | null;
    producedOrders: number;
    lineCount: number;
  }>;
}

interface Blocker {
  kind: "nutrient" | "inclusion";
  key: string;
  label: string;
  asked: string;
  best: number | null;
  detail: string;
}

interface SolveResponse {
  feasible: boolean;
  message?: string;
  blockers?: Blocker[];
  solution: Record<string, number>;
  rawCostPerKg: number;
  costPerKg: number;
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
  standard: Array<{ nutrient: string; minValue: number | null; maxValue: number | null }>;
  prices: Record<string, number | null>;
  unpriced: string[];
}

interface StandardResponse {
  stage: LifeStage;
  version: number | null;
  params: Array<{ nutrient: string; minValue: number | null; maxValue: number | null }>;
}

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: string) => (v.trim() === "" ? null : Number(v));

export function FormulaSolver({
  selected,
  onSaved,
}: {
  /** null = a formula that does not exist yet. */
  selected: string | null;
  onSaved: (name: string) => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"solve" | "history">("solve");
  const [stage, setStage] = useState<LifeStage>("layer_1");
  const [pool, setPool] = useState<string[]>([]);
  const [limits, setLimits] = useState<Record<string, { min: string; max: string }>>({});
  const [result, setResult] = useState<SolveResponse | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const { data: materials } = useQuery<Material[]>({
    queryKey: ["feed-nutrients"],
    queryFn: () => api("/api/feed/nutrients"),
  });
  const { data: groups } = useQuery<FormulaGroup[]>({
    queryKey: ["feed-formulas"],
    queryFn: () => api("/api/feed/formulas"),
  });
  const { data: standard } = useQuery<StandardResponse>({
    queryKey: ["feed-standard", stage],
    queryFn: () => api(`/api/feed/formulator/standard/${stage}`),
  });

  const current = groups?.find((g) => g.name === selected);

  /** Opening a formula loads its own materials and its own inclusion limits. */
  useEffect(() => {
    setResult(null);
    setEdited({});
    setError(null);
    if (!current?.active) {
      if (selected !== null) setPool([]);
      return;
    }
    setPool(current.active.lines.map((l) => l.itemId));
    setLimits(
      Object.fromEntries(
        current.active.lines.map((l) => [
          l.itemId,
          {
            min: l.minPercent == null ? "" : String(Number(l.minPercent)),
            max: l.maxPercent == null ? "" : String(Number(l.maxPercent)),
          },
        ]),
      ),
    );
    if (current.active.stage) setStage(current.active.stage);
  }, [current, selected]);

  const solve = useMutation({
    mutationFn: () =>
      api<SolveResponse>("/api/feed/formulator/solve", {
        method: "POST",
        body: {
          stage,
          itemIds: pool,
          limits: Object.fromEntries(
            Object.entries(limits)
              .filter(([id]) => pool.includes(id))
              .map(([id, v]) => [id, { min: num(v.min) ?? undefined, max: num(v.max) ?? undefined }])
              .filter(([, v]) => (v as { min?: number; max?: number }).min != null || (v as { min?: number; max?: number }).max != null),
          ),
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      setEdited(Object.fromEntries(Object.entries(r.solution).map(([id, pct]) => [id, String(pct)])));
      setError(null);
    },
    onError: (e) => {
      setResult(null);
      setError(e instanceof ApiError ? e.message : "Could not solve");
    },
  });

  const byId = useMemo(() => new Map((materials ?? []).map((m) => [m.id, m])), [materials]);
  const nameOf = (id: string) => byId.get(id)?.name ?? "—";

  const mixPct = useMemo(
    () => Object.entries(edited).map(([id, v]) => ({ id, pct: Number(v) || 0 })).filter((x) => x.pct > 0),
    [edited],
  );
  const mixTotal = mixPct.reduce((s, x) => s + x.pct, 0);

  const addable = (materials ?? []).filter((m) => !pool.includes(m.id));

  return (
    <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold text-gray-900">
                {selected ?? "New formula"}
              </span>
              {current?.active && (
                <span className="text-[12px] text-gray-500">v{current.active.version}</span>
              )}
              <span className="ml-2 text-[12px] text-gray-500">solve against</span>
              <div className="w-44">
                <select
                  value={stage}
                  onChange={(e) => {
                    setStage(e.target.value as LifeStage);
                    setResult(null);
                  }}
                  className="input h-8 text-[13px]"
                >
                  {LIFE_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {LIFE_STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => solve.mutate()}
                disabled={solve.isPending || pool.length === 0 || !standard?.params.length}
                className="btn-primary ml-auto flex shrink-0 items-center gap-1.5"
              >
                <Calculator size={14} />
                {solve.isPending ? "Solving…" : "Solve"}
              </button>
            </div>

            {selected && (
              <div className="mb-3 flex gap-1 border-b border-gray-200">
                {(["solve", "history"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${
                      tab === t
                        ? "border-brand-500 font-semibold text-brand-700"
                        : "border-transparent text-gray-500 hover:text-gray-800"
                    }`}
                  >
                    {t === "solve" ? "Solver" : `History (${current?.history.length ?? 0})`}
                  </button>
                ))}
              </div>
            )}

            {tab === "history" && current ? (
              <div className="card p-4">
                {current.history.map((h) => (
                  <div
                    key={h.version}
                    className="flex justify-between border-b border-gray-100 py-2 text-[13px] last:border-0"
                  >
                    <span>
                      v{h.version}
                      {h.isActive && <span className="ml-1.5 text-[11px] text-green-700">live</span>}
                      <span className="ml-2 text-gray-500">{h.lineCount} materials</span>
                    </span>
                    <span className="text-[11px] text-gray-400">
                      {formatDate(h.effectiveFrom)} · {h.createdByName ?? "—"} · {h.producedOrders}{" "}
                      order{h.producedOrders === 1 ? "" : "s"} produced
                    </span>
                  </div>
                ))}
                {!current.history.length && (
                  <p className="text-[13px] text-gray-400">No versions yet.</p>
                )}
              </div>
            ) : (
              <>
                {error && (
                  <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                    {error}
                  </div>
                )}

                {!standard?.params.length && (
                  <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
                    {LIFE_STAGE_LABELS[stage]} has no live feed standard, so there is nothing to
                    solve against. Set one under Settings → Feed Mill → Feed Standards.
                  </div>
                )}

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="card overflow-hidden">
                    <div className="border-b border-gray-100 px-3 py-2 text-[13px] font-semibold">
                      Materials considered
                    </div>
                    <table className="w-full text-[12px]">
                      <thead className="text-gray-500">
                        <tr className="border-b border-gray-100">
                          <th className="px-2 py-1 text-left font-medium">Material</th>
                          <th className="w-[52px] px-1 py-1 text-right font-medium">min %</th>
                          <th className="w-[52px] px-1 py-1 text-right font-medium">max %</th>
                          <th className="w-6" />
                        </tr>
                      </thead>
                      <tbody>
                        {pool.map((id) => (
                          <tr key={id} className="border-b border-gray-100">
                            <td className="px-2 py-1">
                              {nameOf(id)}
                              {(byId.get(id)?.measured ?? 0) < 20 && (
                                <span
                                  className="ml-1 cursor-help text-amber-600"
                                  title={`Only ${byId.get(id)?.measured ?? 0} of 20 nutrients on file — the rest count as zero`}
                                >
                                  *
                                </span>
                              )}
                            </td>
                            {(["min", "max"] as const).map((k) => (
                              <td key={k} className="px-1 py-0.5">
                                <input
                                  value={limits[id]?.[k] ?? ""}
                                  onChange={(e) =>
                                    setLimits((s) => ({
                                      ...s,
                                      [id]: { min: "", max: "", ...s[id], [k]: e.target.value },
                                    }))
                                  }
                                  inputMode="decimal"
                                  className="input h-6 px-1 text-right text-[11px]"
                                />
                              </td>
                            ))}
                            <td className="pr-1">
                              <button
                                onClick={() => setPool((p) => p.filter((x) => x !== id))}
                                title="Take out of the pool"
                                className="text-gray-300 hover:text-red-600"
                              >
                                <X size={13} />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {!pool.length && (
                          <tr>
                            <td colSpan={4} className="px-2 py-3 text-center text-gray-400">
                              Add the materials you are willing to buy.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    <div className="border-t border-gray-100 p-2">
                      <select
                        value=""
                        onChange={(e) => e.target.value && setPool((p) => [...p, e.target.value])}
                        className="input h-7 text-[12px]"
                      >
                        <option value="">+ Add material…</option>
                        {addable.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="card overflow-hidden">
                    <div className="border-b border-gray-100 px-3 py-2">
                      <span className="text-[13px] font-semibold">
                        Requirements — {LIFE_STAGE_LABELS[stage]}
                      </span>
                      {standard?.version && (
                        <span className="ml-2 text-[11px] text-gray-400">v{standard.version}</span>
                      )}
                    </div>
                    <table className="w-full text-[12px]">
                      <thead className="text-gray-500">
                        <tr className="border-b border-gray-100">
                          <th className="px-2 py-1 text-left font-medium">Nutrient</th>
                          <th className="w-[54px] px-1 py-1 text-right font-medium">min</th>
                          <th className="w-[54px] px-1 py-1 text-right font-medium">max</th>
                          <th className="w-[62px] px-2 py-1 text-right font-medium">got</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(standard?.params ?? []).map((p) => {
                          const got = result?.nutritionAnalysis[p.nutrient];
                          // Judged against the bounds the SOLVE was held to, so
                          // a standard edited since cannot make a saved mix
                          // look wrong on a screen that never re-solved.
                          const ok =
                            got == null ||
                            ((p.minValue == null || got >= p.minValue - 0.005) &&
                              (p.maxValue == null || got <= p.maxValue + 0.005));
                          return (
                            <tr key={p.nutrient} className="border-b border-gray-100">
                              <td className="px-2 py-1">{nutrientLabel(p.nutrient)}</td>
                              <td className="px-1 py-1 text-right text-gray-500">
                                {p.minValue ?? "—"}
                              </td>
                              <td className="px-1 py-1 text-right text-gray-500">
                                {p.maxValue ?? "—"}
                              </td>
                              <td
                                className={`px-2 py-1 text-right tabular-nums ${
                                  got == null ? "text-gray-300" : ok ? "text-green-700" : "text-red-600"
                                }`}
                              >
                                {got == null ? "—" : got.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })}
                        {!standard?.params.length && (
                          <tr>
                            <td colSpan={4} className="px-2 py-3 text-center text-gray-400">
                              No standard set for this stage.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {result && !result.feasible && (
                  <div className="card mt-3 border-red-200 p-4">
                    <div className="text-[13px] font-semibold text-red-700">{result.message}</div>
                    {/* The whole point of the diagnosis: what to change. */}
                    {(result.blockers ?? []).map((b) => (
                      <div key={b.key} className="mt-2 border-l-2 border-red-300 pl-2.5">
                        <div className="text-[13px] font-medium text-gray-900">
                          {b.kind === "nutrient" ? nutrientLabel(b.key) : b.label}
                          <span className="ml-2 text-[12px] font-normal text-gray-500">
                            asked {b.asked}
                          </span>
                        </div>
                        <div className="text-[12px] text-gray-600">{b.detail}</div>
                      </div>
                    ))}
                  </div>
                )}

                {result?.feasible && (
                  <>
                    <div className="card mt-3 overflow-hidden">
                      <div className="flex items-baseline justify-between border-b border-gray-100 px-3 py-2">
                        <span className="text-[13px] font-semibold">Solved mix — 100 kg</span>
                        <span className="text-[12px] text-gray-500">
                          raw {inr(result.rawCostPerKg)}/kg · standard v{result.standardVersion}
                        </span>
                      </div>
                      <table className="w-full text-[13px]">
                        <tbody>
                          {Object.keys(result.solution).map((id) => (
                            <tr key={id} className="border-b border-gray-100">
                              <td className="px-3 py-1">{nameOf(id)}</td>
                              <td className="w-[70px] px-2 py-1 text-right text-[12px] text-gray-500">
                                {result.prices[id] == null ? "—" : inr(result.prices[id]!)}
                              </td>
                              <td className="w-[86px] px-2 py-0.5">
                                <input
                                  value={edited[id] ?? ""}
                                  onChange={(e) =>
                                    setEdited((s) => ({ ...s, [id]: e.target.value }))
                                  }
                                  inputMode="decimal"
                                  className="input h-7 text-right text-[12px]"
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-gray-200">
                            <td className="px-3 py-2 font-semibold">Total</td>
                            <td />
                            <td
                              className={`px-2 py-2 text-right font-semibold tabular-nums ${
                                Math.abs(mixTotal - 100) < 0.05 ? "text-gray-900" : "text-red-600"
                              }`}
                            >
                              {mixTotal.toFixed(2)}%
                            </td>
                          </tr>
                          <tr>
                            <td className="px-3 py-2 text-[14px] font-semibold">
                              Cost per finished kg
                            </td>
                            <td />
                            <td className="px-2 py-2 text-right text-[15px] font-semibold">
                              {inr(result.costPerKg)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                      <div className="flex items-center gap-2 border-t border-gray-100 p-2.5">
                        <button
                          onClick={() => setSaveOpen(true)}
                          disabled={Math.abs(mixTotal - 100) > 0.05}
                          className="btn-primary"
                        >
                          {current ? `Save as ${current.name} v${(current.active?.version ?? 0) + 1}` : "Save as new formula"}
                        </button>
                        {Math.abs(mixTotal - 100) > 0.05 && (
                          <span className="text-[12px] text-red-600">
                            The mix must add to 100% before it can be saved.
                          </span>
                        )}
                      </div>
                    </div>

                    {result.unmeasured.length > 0 && (
                      <p className="mt-2 text-[12px] text-amber-700">
                        Counted as zero, so the mix may be short:{" "}
                        {result.unmeasured
                          .map((u) => `${u.ingredientName} (${u.nutrients.map(nutrientLabel).join(", ")})`)
                          .join(" · ")}
                      </p>
                    )}

                    <div className="card mt-3 overflow-hidden">
                      <div className="border-b border-gray-100 px-3 py-2">
                        <div className="text-[13px] font-semibold">
                          What it would take to use the rest
                        </div>
                        <div className="text-[12px] text-gray-500">
                          Break-even price — buy under this and the mix gets cheaper
                        </div>
                      </div>
                      <table className="w-full text-[13px]">
                        <tbody>
                          {result.shadowPrices.map((s) => (
                            <tr key={s.ingredientId} className="border-b border-gray-100 last:border-0">
                              <td className="px-3 py-1.5">{s.ingredientName}</td>
                              <td className="w-[80px] px-2 py-1.5 text-right text-[12px] text-gray-500">
                                {inr(s.currentPrice)}
                              </td>
                              <td className="w-[88px] px-2 py-1.5 text-right tabular-nums">
                                {s.breakEvenPrice == null ? "—" : inr(s.breakEvenPrice)}
                              </td>
                              <td className="px-2 py-1.5 text-[12px] text-gray-500">{s.insight}</td>
                            </tr>
                          ))}
                          {!result.shadowPrices.length && (
                            <tr>
                              <td className="px-3 py-3 text-center text-[12px] text-gray-400">
                                Every priced material is already in the mix.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}

      {saveOpen && result?.feasible && (
        <SaveDialog
          formulaName={current?.name ?? ""}
          existing={current?.active ?? null}
          stage={stage}
          mix={mixPct.map((m) => ({ itemId: m.id, name: nameOf(m.id), pct: m.pct }))}
          limits={limits}
          onClose={() => setSaveOpen(false)}
          onSaved={(msg) => {
            setSaveOpen(false);
            setResult(null);
            void qc.invalidateQueries({ queryKey: ["feed-formulas"] });
            void qc.invalidateQueries({ queryKey: ["feed-formula-matrix"] });
            setError(null);
            setTab("history");
            onSaved(msg);
          }}
        />
      )}
    </>
  );
}

/**
 * Save turns a 100 kg solve into a real batch.
 *
 * The percentages the solver returns are exact to three decimals and nobody
 * weighs 6.183 kg of premix, so this is where they become the numbers an
 * operator will actually scoop — batch size first, then every line editable,
 * with the total kept honest against it. A round-off here is a deliberate act
 * rather than a rounding the code did quietly on the way past.
 */
function SaveDialog({
  formulaName,
  existing,
  stage,
  mix,
  limits,
  onClose,
  onSaved,
}: {
  formulaName: string;
  existing: FormulaGroup["active"];
  stage: LifeStage;
  mix: Array<{ itemId: string; name: string; pct: number }>;
  limits: Record<string, { min: string; max: string }>;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(formulaName);
  const [batch, setBatch] = useState(existing ? String(Number(existing.batchSizeKg)) : "1000");
  const [outputItemId, setOutputItemId] = useState(existing?.outputItemId ?? "");
  const [kg, setKg] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const { data: outputs } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["feed-formula-outputs"],
    queryFn: () => api("/api/feed/formulas/output-items"),
  });

  const target = Number(batch) || 0;
  // Re-scaled whenever the batch changes, but only for lines nobody has typed
  // over: an edited figure is a decision and must survive.
  useEffect(() => {
    setKg((prev) =>
      Object.fromEntries(
        mix.map((m) => [m.itemId, prev[m.itemId] ?? ((m.pct * target) / 100).toFixed(3)]),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const rows = mix.map((m) => ({ ...m, kg: Number(kg[m.itemId] ?? 0) }));
  const total = rows.reduce((s, r) => s + r.kg, 0);
  const balanced = Math.abs(total - target) <= 0.5;

  const rescale = () =>
    setKg(Object.fromEntries(mix.map((m) => [m.itemId, ((m.pct * target) / 100).toFixed(3)])));
  const roundAll = () =>
    setKg((prev) =>
      Object.fromEntries(mix.map((m) => [m.itemId, String(Math.round(Number(prev[m.itemId] ?? 0)))])),
    );

  const save = useMutation({
    mutationFn: () =>
      api<{ savedVersion: number }>("/api/feed/formulas", {
        method: "POST",
        body: {
          name: name.trim(),
          outputItemId,
          stage,
          batchSizeKg: target.toFixed(3),
          effectiveFrom: new Date().toISOString().slice(0, 10),
          lines: rows
            .filter((r) => r.kg > 0)
            .map((r) => ({
              itemId: r.itemId,
              quantityKg: r.kg.toFixed(3),
              // The limits the solve was held to travel with the recipe, so
              // re-solving it next month starts where this one left off.
              minPercent: limits[r.itemId]?.min.trim() || null,
              maxPercent: limits[r.itemId]?.max.trim() || null,
            })),
        },
      }),
    onSuccess: () => onSaved(name.trim()),
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[86vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="text-[15px] font-semibold">
              {existing ? `Save ${formulaName} v${existing.version + 1}` : "Save as a new formula"}
            </div>
            <div className="text-[12px] text-gray-500">
              The solve is per 100 kg. Set the batch and adjust anything that needs to be weighable.
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </div>
        )}

        <div className="mb-3 grid grid-cols-3 gap-3">
          <div className="col-span-1">
            <label className="label-required">Batch size (kg) *</label>
            <input
              value={batch}
              onChange={(e) => setBatch(e.target.value)}
              inputMode="decimal"
              className="input text-right"
            />
          </div>
          {!existing && (
            <>
              <div>
                <label className="label-required">Formula name *</label>
                <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label-required">Output item *</label>
                <select
                  value={outputItemId}
                  onChange={(e) => setOutputItemId(e.target.value)}
                  className="input"
                >
                  <option value="">Select…</option>
                  {outputs?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        <div className="mb-2 flex gap-2">
          <button onClick={rescale} className="btn-ghost text-[12px]">
            Rescale from the solve
          </button>
          <button onClick={roundAll} className="btn-ghost text-[12px]">
            Round to whole kg
          </button>
        </div>

        <table className="w-full text-[13px]">
          <thead className="text-gray-500">
            <tr className="border-b border-gray-200">
              <th className="px-2 py-1 text-left text-[12px] font-medium">Material</th>
              <th className="w-[70px] px-2 py-1 text-right text-[12px] font-medium">%</th>
              <th className="w-[110px] px-2 py-1 text-right text-[12px] font-medium">kg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.itemId} className="border-b border-gray-100">
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1 text-right text-gray-500">
                  {target > 0 ? ((r.kg / target) * 100).toFixed(2) : "—"}
                </td>
                <td className="px-2 py-0.5">
                  <input
                    value={kg[r.itemId] ?? ""}
                    onChange={(e) => setKg((s) => ({ ...s, [r.itemId]: e.target.value }))}
                    inputMode="decimal"
                    className="input h-7 text-right text-[12px]"
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-200">
              <td className="px-2 py-2 font-semibold">Total</td>
              <td />
              <td
                className={`px-2 py-2 text-right font-semibold tabular-nums ${
                  balanced ? "text-green-700" : "text-red-600"
                }`}
              >
                {total.toFixed(3)}
                <span className="ml-1 text-[11px] font-normal text-gray-500">
                  of {target.toFixed(0)}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => save.mutate()}
            disabled={
              save.isPending || !balanced || !name.trim() || !outputItemId || target <= 0
            }
            className="btn-primary"
          >
            {save.isPending ? "Saving…" : existing ? `Save v${existing.version + 1}` : "Save formula"}
          </button>
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          {!balanced && (
            <span className="text-[12px] text-red-600">
              The lines must add to the batch size.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
