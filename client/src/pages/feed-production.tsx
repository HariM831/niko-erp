/**
 * Production — pick the formulas, say how many batches of each, hit Produce.
 *
 * That is the whole ceremony. The tonnage is in stock the moment the button is
 * hit, costed at material prices plus overhead; there is no slip and no pending
 * state, because the slip was the old system and it is retired. A mistake is a
 * VOID — journal reversed, feed withdrawn — not a draft stage in front of every
 * real run.
 */
import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Factory, Plus, X } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import { useAuth } from "../auth";
import { StatusBadge } from "../components/status-badge";
import { useLocalSearch } from "../components/search-context";
import { SearchSelect } from "../components/search-select";
import { localYmd } from "../lib/utils";
import { type SearchField, useAdvancedSearch } from "../components/advanced-search";
import { FORMULATION_CATEGORIES } from "@shared/item-categories";

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

/**
 * A formula by name, so a search spans its versions; an ingredient finds the
 * runs that consumed it. Pending is left out of Status: it was the printed
 * slip, which is retired, so no run is ever in it now.
 */
function productionFields(groups: FormulaGroup[] | undefined, costs: boolean): SearchField[] {
  return [
    { key: "number", label: "Production#", kind: "text" },
    { key: "date", label: "Date Range", kind: "dateRange" },
    { key: "formula", label: "Formula", kind: "select", options: (groups ?? []).map((g) => g.name) },
    { key: "materialId", label: "Ingredient", kind: "item", itemCategories: FORMULATION_CATEGORIES },
    { key: "status", label: "Status", kind: "select", options: ["completed", "void"] },
    { key: "batches", label: "Batches Range", kind: "numberRange" },
    { key: "output", label: "Output Range (kg)", kind: "numberRange" },
    // Cost is for those who hold feed_mill.costs; the server drops it for the rest.
    ...(costs ? [{ key: "costPerKg", label: "Cost per kg Range", kind: "numberRange" as const }] : []),
  ];
}

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

  /* The picker, not the full list: issuing a batch means choosing a formula by
     name, and the recipe behind that name is a separate right. */
  const { data: groups } = useQuery<FormulaGroup[]>({
    queryKey: ["feed-formula-picker"],
    queryFn: () => api("/api/feed/formulas/picker"),
  });
  // "Search in Production" is answered by the server, which looks through
  // every run ever made, not just the newest hundred this page loads to browse.
  // The advanced criteria travel with it and combine with the top-bar term.
  const term = useLocalSearch("Production", "feed-mill:production").trim();
  const { can } = useAuth();
  const costs = can("feed_mill", "costs");
  const fields = useMemo(() => productionFields(groups, costs), [groups, costs]);
  const adv = useAdvancedSearch("Production", fields);
  const searching = !!term || adv.active;
  const params = new URLSearchParams({ ...(term ? { search: term } : {}), ...adv.criteria }).toString();
  const { data: rows } = useQuery<ProductionRow[]>({
    queryKey: ["feed-production", term, adv.criteria],
    queryFn: () => api(`/api/feed/production/orders${params ? `?${params}` : ""}`),
    placeholderData: keepPreviousData,
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
            orderDate: localYmd(),
          },
        },
      ),
    onSuccess: (made) => {
      setDone(
        made.length === 1
          ? `${made[0]!.number} — ${kg(made[0]!.actualOutputKg)} produced${made[0]!.costPerKg != null ? ` at ${inr(Number(made[0]!.costPerKg))}/kg` : ""}, in stock and ready to transfer`
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
  // While searching, every matching day is shown, not three; the day totals
  // are then of what matched.
  const found = rows ?? [];
  const byDay = (() => {
    const all = [...new Set(found.map((r) => r.orderDate))].sort().reverse();
    const days = searching ? all : all.slice(0, 3);
    return days.map((day) => {
      const dayRows = found.filter((r) => r.orderDate === day);
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
      <header className="page-header flex items-center justify-between gap-2 px-6 py-3">
        <h1 className="text-lg font-semibold">Production</h1>
        {adv.button}
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
                  <SearchSelect
                    value={r.formulaId || null}
                    onChange={(id) =>
                      setRuns((rs) => rs.map((x, j) => (j === i ? { ...x, formulaId: id ?? "" } : x)))
                    }
                    options={live.map((g) => ({
                      id: g.active!.id,
                      label: g.name,
                      sub: `${Number(g.active!.batchSizeKg).toLocaleString("en-IN")} kg/batch`,
                    }))}
                    placeholder="Choose…"
                  />
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

          {searching && !byDay.length && (
            <p className="p-4 text-center text-[13px] text-gray-400">
              {term ? <>No run matches “{term}”.</> : "No run matches the search."}
            </p>
          )}

          {byDay.map(({ day, rows: dayRows, totalKg, totalValue }) => (
            <div key={day} className="card mb-3 overflow-hidden">
              <div className="flex items-baseline justify-between border-b bg-gray-50 px-4 py-1.5">
                <span className="text-[12px] font-semibold text-gray-700">{formatDate(day)}</span>
                <span className="text-[11px] tabular-nums text-gray-500">
                  {kg(totalKg)}
                  {costs && <> · {inr(totalValue)}</>}
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
                    {costs && (
                      <span className="text-[12px] tabular-nums text-gray-500">
                        {r.costPerKg == null ? "—" : `${inr(Number(r.costPerKg))}/kg`}
                      </span>
                    )}
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
            {!searching && rows && !rows.length && (
              <p className="card p-4 text-center text-[13px] text-gray-400">Nothing produced yet.</p>
            )}
          </div>
        </div>
      </div>
      {adv.dialog}
    </div>
  );
}
