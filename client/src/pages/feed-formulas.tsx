/**
 * Formulas — the recipes the mill produces to.
 *
 * The editor's one non-negotiable: the lines must add to the batch size,
 * because a batch IS its recipe. The running total sits beside the target and
 * goes green when they agree, which is faster than any error message.
 *
 * Saving supersedes. A production order records the exact version it was made
 * to, so an old batch stays readable against the recipe of its day.
 */
import { useEffect, useMemo, useState } from "react";
import { FormulaMatrix } from "../components/formula-matrix";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import { LIFE_STAGES, LIFE_STAGE_LABELS, type LifeStage } from "@shared/feed";

interface FormulaLine {
  itemId: string;
  itemName: string;
  quantityKg: string;
  minPercent: string | null;
  maxPercent: string | null;
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
    effectiveFrom: string;
    lines: FormulaLine[];
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

interface DraftLine {
  itemId: string;
  quantityKg: string;
  minPercent: string;
  maxPercent: string;
}

const kg = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

export function FeedFormulasPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [outputItemId, setOutputItemId] = useState("");
  const [stage, setStage] = useState<string>("");
  const [batchSizeKg, setBatchSizeKg] = useState("1000");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const { data: groups } = useQuery<FormulaGroup[]>({
    queryKey: ["feed-formulas"],
    queryFn: () => api("/api/feed/formulas"),
  });
  const { data: ingredients } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["feed-nutrients"],
    queryFn: () => api("/api/feed/nutrients"),
  });
  const { data: outputs } = useQuery<Array<{ id: string; name: string; trackInventory: boolean }>>({
    queryKey: ["feed-formula-outputs"],
    queryFn: () => api("/api/feed/formulas/output-items"),
  });

  const current = groups?.find((g) => g.name === selected);

  // Deliberately no auto-select: nothing picked means the comparison, which is
  // what somebody opening Formulas actually came to see. Landing straight in
  // the first formula's editor also put a save button under an idle cursor.

  useEffect(() => {
    if (!current?.active) return;
    setName(current.name);
    setOutputItemId(current.active.outputItemId);
    setStage(current.active.stage ?? "");
    setBatchSizeKg(String(Number(current.active.batchSizeKg)));
    setLines(
      current.active.lines.map((l) => ({
        itemId: l.itemId,
        quantityKg: String(Number(l.quantityKg)),
        minPercent: l.minPercent == null ? "" : String(Number(l.minPercent)),
        maxPercent: l.maxPercent == null ? "" : String(Number(l.maxPercent)),
      })),
    );
    setError(null);
  }, [current]);

  const startNew = () => {
    setSelected("");
    setName("");
    setOutputItemId("");
    setStage("");
    setBatchSizeKg("1000");
    setLines([{ itemId: "", quantityKg: "", minPercent: "", maxPercent: "" }]);
    setSaved(null);
    setError(null);
  };

  const lineTotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.quantityKg) || 0), 0),
    [lines],
  );
  const target = Number(batchSizeKg) || 0;
  const balanced = Math.abs(lineTotal - target) <= 0.5;

  const save = useMutation({
    mutationFn: () =>
      api<{ savedVersion: number }>("/api/feed/formulas", {
        method: "POST",
        body: {
          name: name.trim(),
          outputItemId,
          stage: stage || null,
          batchSizeKg: batchSizeKg.trim(),
          effectiveFrom: new Date().toISOString().slice(0, 10),
          lines: lines
            .filter((l) => l.itemId && l.quantityKg.trim())
            .map((l) => ({
              itemId: l.itemId,
              quantityKg: l.quantityKg.trim(),
              minPercent: l.minPercent.trim() || null,
              maxPercent: l.maxPercent.trim() || null,
            })),
        },
      }),
    onSuccess: (r) => {
      setSaved(`${name.trim()} saved as version ${r.savedVersion}`);
      setSelected(name.trim());
      void qc.invalidateQueries({ queryKey: ["feed-formulas"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  const patch = (i: number, next: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...next } : l)));

  const usable = lines.filter((l) => l.itemId && l.quantityKg.trim());
  const blocked = !name.trim() || !outputItemId || !usable.length || !balanced || target <= 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between border-b bg-white px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Formulas</h1>
          <p className="text-[13px] text-gray-500">
            What goes into a batch, and the item that comes out of it
          </p>
        </div>
        <button onClick={startNew} className="btn-secondary flex shrink-0 items-center gap-1">
          <Plus size={14} /> New formula
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-44 shrink-0 overflow-y-auto border-r bg-white lg:w-60">
          {/* The comparison is the landing view: a formula means almost nothing
              read on its own. Picking one from here opens it for editing. */}
          <button
            onClick={() => {
              setSelected(null);
              setSaved(null);
            }}
            className={`block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 ${
              selected === null ? "bg-brand-50" : ""
            }`}
          >
            <div className="text-[13px] font-medium text-gray-900">All formulas</div>
            <div className="text-[11px] text-gray-400">Side by side, with cost per kg</div>
          </button>
          {groups?.map((g) => (
            <button
              key={g.name}
              onClick={() => {
                setSelected(g.name);
                setSaved(null);
              }}
              className={`block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 ${
                selected === g.name ? "bg-brand-50" : ""
              }`}
            >
              <div className="truncate text-[13px] font-medium text-gray-900">{g.name}</div>
              <div className="text-[11px] text-gray-400">
                {g.active
                  ? `v${g.active.version} · ${g.active.lines.length} ingredients · ${kg(Number(g.active.batchSizeKg))} kg`
                  : "retired"}
              </div>
            </button>
          ))}
          {groups && !groups.length && (
            <p className="p-4 text-[13px] text-gray-400">No formulas yet.</p>
          )}
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-surface p-3 lg:p-6">
          {/* The editor is a form and wants a measure; the comparison is a
              table and wants the width. */}
          <div className={`mx-auto ${selected === null ? "max-w-6xl" : "max-w-3xl"}`}>
            {saved && (
              <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-800">
                {saved}
              </div>
            )}
            {error && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                {error}
              </div>
            )}

            {selected === null ? (
              <FormulaMatrix onPick={(n) => setSelected(n)} />
            ) : (
            <>
            <div className="card p-5">
              <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="col-span-2">
                  <label className="label-required">Formula name *</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Layer Mash 1" className="input" />
                </div>
                <div>
                  <label className="label">Life stage</label>
                  <select value={stage} onChange={(e) => setStage(e.target.value)} className="input">
                    <option value="">—</option>
                    {LIFE_STAGES.map((s) => (
                      <option key={s} value={s}>
                        {LIFE_STAGE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label-required">Batch size (kg) *</label>
                  <input
                    value={batchSizeKg}
                    onChange={(e) => setBatchSizeKg(e.target.value)}
                    inputMode="decimal"
                    className="input text-right"
                  />
                </div>
                <div className="col-span-2 md:col-span-4">
                  <label className="label-required">Produces *</label>
                  <select value={outputItemId} onChange={(e) => setOutputItemId(e.target.value)} className="input">
                    <option value="">Choose the finished feed item…</option>
                    {outputs?.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                        {o.trackInventory ? "" : " (not inventory-tracked)"}
                      </option>
                    ))}
                  </select>
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    The finished feed is an item like any other, so production receives it into stock
                    and a transfer draws it down. Only inventory-tracked items can be produced.
                  </p>
                </div>
              </div>

              <div className="label mb-1">Ingredients</div>
              {/* Fixed layout so the material column takes what the sized ones
                  leave; min-width + scroll so a narrow pane scrolls the table
                  instead of crushing the select to a chevron. */}
              <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] table-fixed">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-gray-400">
                    <th className="pb-1 text-left font-semibold">Material</th>
                    <th className="w-28 pb-1 text-right font-semibold">kg / batch</th>
                    <th className="w-20 pb-1 text-right font-semibold">min %</th>
                    <th className="w-20 pb-1 text-right font-semibold">max %</th>
                    <th className="w-8 pb-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="py-1 pr-2">
                        <select
                          value={l.itemId}
                          onChange={(e) => patch(i, { itemId: e.target.value })}
                          className="input h-8 text-[13px]"
                        >
                          <option value="">Choose…</option>
                          {ingredients?.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          value={l.quantityKg}
                          onChange={(e) => patch(i, { quantityKg: e.target.value })}
                          inputMode="decimal"
                          className="input h-8 text-right text-[13px]"
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          value={l.minPercent}
                          onChange={(e) => patch(i, { minPercent: e.target.value })}
                          inputMode="decimal"
                          placeholder="—"
                          className="input h-8 text-right text-[12px]"
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          value={l.maxPercent}
                          onChange={(e) => patch(i, { maxPercent: e.target.value })}
                          inputMode="decimal"
                          placeholder="—"
                          className="input h-8 text-right text-[12px]"
                        />
                      </td>
                      <td className="py-1 text-right">
                        <button
                          onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                          className="text-gray-300 hover:text-red-600"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>

              <div className="mt-2 flex items-center justify-between">
                <button
                  onClick={() => setLines((ls) => [...ls, { itemId: "", quantityKg: "", minPercent: "", maxPercent: "" }])}
                  className="flex items-center gap-1 text-[13px] text-brand-600 hover:underline"
                >
                  <Plus size={14} /> Add ingredient
                </button>
                {/* The recipe IS the batch. Green when they agree beats any error. */}
                <div className={`text-[13px] font-medium tabular-nums ${balanced && target > 0 ? "text-green-700" : "text-amber-600"}`}>
                  {kg(lineTotal)} of {kg(target)} kg
                  {balanced && target > 0 ? " ✓" : ` · ${kg(target - lineTotal)} kg to place`}
                </div>
              </div>

              <div className="mt-3 flex items-center justify-end gap-2 border-t pt-3">
                <button
                  onClick={() => {
                    setSaved(null);
                    setError(null);
                    save.mutate();
                  }}
                  disabled={blocked || save.isPending}
                  className="btn-primary"
                >
                  Save as version {(current?.history[0]?.version ?? 0) + 1}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-gray-400">
                Saving makes a new version and retires the current one. A production order records the
                exact version it was made to, so an old batch stays readable against its own recipe.
                Min/max % are the formulator's inclusion limits for the ingredient.
              </p>
            </div>

            {current && current.history.length > 0 && (
              <div className="card mt-4 p-5">
                <div className="label mb-2">Version history</div>
                {current.history.map((h) => (
                  <div key={h.version} className="flex justify-between border-b border-gray-100 py-1.5 text-[12px] last:border-0">
                    <span>
                      v{h.version}
                      {h.isActive && <span className="ml-1.5 text-[11px] text-green-700">active</span>}
                      <span className="ml-2 text-gray-500">{h.lineCount} ingredients</span>
                    </span>
                    <span className="text-[11px] text-gray-400">
                      {formatDate(h.effectiveFrom)} · {h.createdByName ?? "—"} · {h.producedOrders} order
                      {h.producedOrders === 1 ? "" : "s"} produced
                    </span>
                  </div>
                ))}
              </div>
            )}
            </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
