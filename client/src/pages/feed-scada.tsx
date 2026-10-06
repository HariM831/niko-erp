/**
 * Feed Mill › SCADA Batches — what the mill's SCADA weighed.
 *
 * Every batch the WinCC PC logged, copied here by the helper on that PC: set
 * against actual for each bin, read by what the bin held at the time. A record
 * beside production, not production (the user, 6 Oct 2026) — nothing on this
 * page moves stock or posts.
 *
 * Bin and recipe names are the SCADA's own spelling ("DOGS", "Layer  3"); the
 * names panel says what each means in niko. An unmapped name is still counted,
 * under its own spelling, so a total never quietly drops kilos.
 */
import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { DateInput } from "../components/date-input";
import { SearchSelect } from "../components/search-select";
import { localYmd } from "../lib/utils";

interface Usage {
  batches: number;
  materials: Array<{ key: string; name: string; mapped: boolean; setKg: number; actKg: number }>;
  days: Array<{ day: string; batches: number; setKg: number; actKg: number; byMaterial: Record<string, { setKg: number; actKg: number }> }>;
  recipes: Array<{ recipeName: string; formulaName: string | null; batches: number; setKg: number; actKg: number }>;
  unmapped: { bins: string[]; recipes: string[] };
}

interface BatchRow {
  id: string;
  batchedAt: string;
  recipeName: string;
  formulaName: string | null;
  batchSeq: number | null;
  setTotalKg: number;
  actTotalKg: number;
  bins: Array<{ bin: number; name: string | null; setKg: number; actKg: number; itemName: string | null }>;
}

interface Names {
  bins: Array<{ name: string; itemId?: string; itemName?: string }>;
  recipes: Array<{ name: string; formulaId?: string; formulaName?: string }>;
  items: Array<{ id: string; name: string }>;
  formulas: Array<{ id: string; name: string; version: number }>;
}

const kg = (n: number) => Math.round(n).toLocaleString("en-IN");
const tonnes = (n: number) => (n / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 });
/** Over by more than this reads as worth a look; the scales are not that loose. */
const WATCH_PCT = 2;

function Variance({ set, act }: { set: number; act: number }) {
  if (!set) return <span className="text-gray-400">—</span>;
  const pct = ((act - set) / set) * 100;
  const tone = Math.abs(pct) >= WATCH_PCT ? (pct > 0 ? "text-red-600" : "text-amber-600") : "text-gray-600";
  return (
    <span className={`tabular-nums ${tone}`}>
      {pct > 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localYmd(d);
}

export function FeedScadaPage() {
  const { can } = useAuth();
  const mayMap = can("feed_mill", "manage_formulas");
  const qc = useQueryClient();
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(localYmd());
  const [showBatches, setShowBatches] = useState(false);
  const [showNames, setShowNames] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const range = `from=${from}&to=${to}`;

  const { data: usage } = useQuery<Usage>({
    queryKey: ["scada", "usage", from, to],
    queryFn: () => api(`/api/scada/usage?${range}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const { data: batches } = useQuery<BatchRow[]>({
    queryKey: ["scada", "batches", from, to],
    queryFn: () => api(`/api/scada/batches?${range}&limit=500`),
    enabled: showBatches,
    placeholderData: keepPreviousData,
  });
  const { data: names } = useQuery<Names>({
    queryKey: ["scada", "names"],
    queryFn: () => api("/api/scada/names"),
    enabled: showNames || !!usage?.unmapped.bins.length || !!usage?.unmapped.recipes.length,
  });

  const map = useMutation({
    mutationFn: (body: { kind: "bin" | "recipe"; name: string; itemId?: string | null; formulaId?: string | null }) =>
      api("/api/scada/names", { method: "PUT", body }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["scada"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  const totals = useMemo(() => {
    const m = usage?.materials ?? [];
    return { set: m.reduce((s, x) => s + x.setKg, 0), act: m.reduce((s, x) => s + x.actKg, 0) };
  }, [usage]);
  const unmappedCount = (usage?.unmapped.bins.length ?? 0) + (usage?.unmapped.recipes.length ?? 0);

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-6 py-3">
        <h1 className="text-lg font-semibold">SCADA Batches</h1>
        <div className="flex items-center gap-2 text-[13px]">
          <DateInput value={from} onChange={(e) => setFrom(e.target.value)} max={to} className="w-36" />
          <span className="text-gray-400">to</span>
          <DateInput value={to} onChange={(e) => setTo(e.target.value)} min={from} className="w-36" />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-surface p-3 lg:p-6">
        <div className="mx-auto max-w-5xl space-y-4">
          <p className="text-[12px] text-gray-500">
            As the mill's SCADA weighed them, copied from the SCADA PC. A record beside production — nothing here moves
            stock or posts.
          </p>
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>
          )}

          {unmappedCount > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
              {usage!.unmapped.bins.length > 0 && <div>Bin names not linked to a material: {usage!.unmapped.bins.join(", ")}</div>}
              {usage!.unmapped.recipes.length > 0 && <div>Recipes not linked to a formula: {usage!.unmapped.recipes.join(", ")}</div>}
              <button className="mt-1 text-[12px] font-medium underline" onClick={() => setShowNames(true)}>
                Link them
              </button>
            </div>
          )}

          {/* ── Ingredient usage ── */}
          <div className="card p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <div className="flex items-center gap-2">
                <Cpu size={16} className="text-brand-500" />
                <span className="text-[15px] font-semibold">Ingredient usage</span>
              </div>
              <span className="text-[12px] text-gray-500">
                {(usage?.batches ?? 0).toLocaleString("en-IN")} batches · {tonnes(totals.act)} t weighed
              </span>
            </div>
            {!usage?.materials.length ? (
              <p className="text-[13px] text-gray-400">No batches in these dates.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b text-left text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="py-1.5">Material</th>
                    <th className="py-1.5 text-right">Set kg</th>
                    <th className="py-1.5 text-right">Actual kg</th>
                    <th className="py-1.5 text-right">Difference</th>
                    <th className="py-1.5 text-right">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.materials.map((m) => (
                    <tr key={m.key} className="border-b border-gray-100">
                      <td className="py-1.5">
                        {m.name}
                        {!m.mapped && <span className="ml-1.5 text-[11px] text-amber-600">SCADA name</span>}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{kg(m.setKg)}</td>
                      <td className="py-1.5 text-right tabular-nums">{kg(m.actKg)}</td>
                      <td className="py-1.5 text-right tabular-nums">{kg(m.actKg - m.setKg)}</td>
                      <td className="py-1.5 text-right">
                        <Variance set={m.setKg} act={m.actKg} />
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-1.5">Total</td>
                    <td className="py-1.5 text-right tabular-nums">{kg(totals.set)}</td>
                    <td className="py-1.5 text-right tabular-nums">{kg(totals.act)}</td>
                    <td className="py-1.5 text-right tabular-nums">{kg(totals.act - totals.set)}</td>
                    <td className="py-1.5 text-right">
                      <Variance set={totals.set} act={totals.act} />
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          {/* ── By day and by recipe ── */}
          {!!usage?.days.length && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card p-4">
                <div className="mb-2 text-[15px] font-semibold">By day</div>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b text-left text-[11px] uppercase tracking-wide text-gray-500">
                      <th className="py-1.5">Day</th>
                      <th className="py-1.5 text-right">Batches</th>
                      <th className="py-1.5 text-right">Actual t</th>
                      <th className="py-1.5 text-right">Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.days.map((d) => (
                      <tr key={d.day} className="border-b border-gray-100">
                        <td className="py-1.5">
                          {new Date(`${d.day}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{d.batches}</td>
                        <td className="py-1.5 text-right tabular-nums">{tonnes(d.actKg)}</td>
                        <td className="py-1.5 text-right">
                          <Variance set={d.setKg} act={d.actKg} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card p-4">
                <div className="mb-2 text-[15px] font-semibold">By recipe</div>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b text-left text-[11px] uppercase tracking-wide text-gray-500">
                      <th className="py-1.5">SCADA recipe</th>
                      <th className="py-1.5">niko formula</th>
                      <th className="py-1.5 text-right">Batches</th>
                      <th className="py-1.5 text-right">Actual t</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.recipes.map((r) => (
                      <tr key={r.recipeName} className="border-b border-gray-100">
                        <td className="py-1.5">{r.recipeName}</td>
                        <td className="py-1.5">{r.formulaName ?? <span className="text-amber-600">not linked</span>}</td>
                        <td className="py-1.5 text-right tabular-nums">{r.batches}</td>
                        <td className="py-1.5 text-right tabular-nums">{tonnes(r.actKg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Every batch ── */}
          <div className="card p-4">
            <button className="text-[15px] font-semibold" onClick={() => setShowBatches((v) => !v)}>
              {showBatches ? "▾" : "▸"} Every batch
            </button>
            {showBatches && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b text-left text-[11px] uppercase tracking-wide text-gray-500">
                      <th className="py-1.5 pr-2">Time</th>
                      <th className="py-1.5 pr-2">Recipe</th>
                      <th className="py-1.5 pr-2 text-right">#</th>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((b) => (
                        <th key={b} className="py-1.5 pr-2 text-right">
                          Bin {b}
                        </th>
                      ))}
                      <th className="py-1.5 text-right">Set / Act</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(batches ?? []).map((b) => (
                      <tr key={b.id} className="border-b border-gray-100 align-top">
                        <td className="whitespace-nowrap py-1 pr-2">
                          {new Date(b.batchedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td className="py-1 pr-2">{b.recipeName}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{b.batchSeq ?? ""}</td>
                        {b.bins.map((x) => (
                          <td key={x.bin} className="py-1 pr-2 text-right" title={x.itemName ?? x.name ?? ""}>
                            {x.setKg || x.actKg ? (
                              <>
                                <div className="text-[10px] text-gray-400">{x.name}</div>
                                <div className="tabular-nums">
                                  {x.setKg}/<span className={Math.abs(x.actKg - x.setKg) > Math.max(2, x.setKg * 0.03) ? "text-red-600" : ""}>{x.actKg}</span>
                                </div>
                              </>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        ))}
                        <td className="whitespace-nowrap py-1 text-right tabular-nums">
                          {kg(b.setTotalKg)} / {kg(b.actTotalKg)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {batches?.length === 500 && <p className="mt-2 text-[11px] text-gray-400">The newest 500 shown — narrow the dates for older ones.</p>}
              </div>
            )}
          </div>

          {/* ── Names ── */}
          <div className="card p-4">
            <button className="text-[15px] font-semibold" onClick={() => setShowNames((v) => !v)}>
              {showNames ? "▾" : "▸"} SCADA names
            </button>
            {showNames && names && (
              <div className="mt-3 grid gap-6 lg:grid-cols-2">
                <div>
                  <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-gray-500">Bin material → niko material</div>
                  {names.bins.map((b) => (
                    <div key={b.name} className="mb-1.5 flex items-center gap-2 text-[13px]">
                      <span className="w-28 shrink-0 font-mono">{b.name}</span>
                      {mayMap ? (
                        <div className="flex-1">
                          <SearchSelect
                            value={b.itemId ?? null}
                            onChange={(id) => map.mutate({ kind: "bin", name: b.name, itemId: id })}
                            options={names.items.map((i) => ({ id: i.id, label: i.name }))}
                            placeholder="Choose a material…"
                          />
                        </div>
                      ) : (
                        <span>{b.itemName ?? <span className="text-amber-600">not linked</span>}</span>
                      )}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-gray-500">SCADA recipe → niko formula</div>
                  {names.recipes.map((r) => (
                    <div key={r.name} className="mb-1.5 flex items-center gap-2 text-[13px]">
                      <span className="w-28 shrink-0 font-mono">{r.name}</span>
                      {mayMap ? (
                        <div className="flex-1">
                          <SearchSelect
                            value={r.formulaId ?? null}
                            onChange={(id) => map.mutate({ kind: "recipe", name: r.name, formulaId: id })}
                            options={names.formulas.map((f) => ({ id: f.id, label: f.name, sub: `v${f.version}` }))}
                            placeholder="Choose a formula…"
                          />
                        </div>
                      ) : (
                        <span>{r.formulaName ?? <span className="text-amber-600">not linked</span>}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
