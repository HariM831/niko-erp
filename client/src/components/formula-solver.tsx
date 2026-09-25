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
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, Lock, LockOpen, Plus, X } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import { SearchSelect } from "./search-select";
import { LIFE_STAGES, LIFE_STAGE_LABELS, NUTRIENTS, nutrientLabel, type LifeStage } from "@shared/feed";
import { localYmd } from "../lib/utils";

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
  kind: "nutrient" | "inclusion" | "conflict";
  key: string;
  label: string;
  asked: string;
  best: number | null;
  detail: string;
  with?: Array<{ key: string; asked: string }>;
  easeTo?: number | null;
}

interface SolveResponse {
  feasible: boolean;
  message?: string;
  blockers?: Blocker[];
  solution: Record<string, number>;
  /** Whether this viewer may see costs; the cost fields are absent otherwise. */
  costs: boolean;
  rawCostPerKg?: number;
  costPerKg?: number;
  nutritionAnalysis: Record<string, number>;
  unmeasured: Array<{ ingredientName: string; nutrients: string[] }>;
  shadowPrices?: Array<{
    ingredientId: string;
    ingredientName: string;
    currentPrice: number;
    breakEvenPrice: number | null;
    wouldEnter: boolean;
    insight: string;
  }>;
  standardVersion: number;
  standard: Array<{ nutrient: string; minValue: number | null; maxValue: number | null }>;
  prices?: Record<string, number | null>;
  unpriced: string[];
  /** Bounds moved for this solve only, from what the standard asks to what the solve was held to. */
  eased?: Array<{ nutrient: string; from: { min: number | null; max: number | null }; to: { min: number | null; max: number | null } }>;
  /** For a failed solve: unpriced materials richer in a clashing nutrient than the standard asks — price them before easing anything. */
  leftOutRich?: Array<{ nutrient: string; materials: Array<{ name: string; value: number }> }>;
}

interface StandardResponse {
  stage: LifeStage;
  version: number | null;
  /** g/bird/day the figures are written for; null for a standard never scaled. */
  referenceIntakeG?: number | null;
  params: Array<{ nutrient: string; minValue: number | null; maxValue: number | null }>;
}

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: string) => (v.trim() === "" ? null : Number(v));

/** "a", "a and b", "a, b and c". */
const joinWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

interface IntakeResponse {
  formula: string;
  transfers: { from: string; to: string } | null;
  houses: Array<{ houseId: string; code: string; receivedKg: number; days: number; from: string | null; to: string | null; birds: number | null; intakeG: number | null }>;
  intakeG: number | null;
}
interface MaterialInfo {
  id: string;
  name: string;
  feedIngredient: boolean;
  priced: boolean;
  measured: number;
  /** Carries a value for some nutrient the standard bounds. An additive does not. */
  contributes: boolean;
  priceBasis?: "delivered" | "last bill" | "standing price" | "never bought" | "not per kg";
  pricedOn?: string | null;
}
interface AnalyseResponse {
  standardVersion: number | null;
  nutritionAnalysis: Record<string, number>;
  costs: boolean;
  rawCostPerKg?: number;
  costPerKg?: number;
  prices?: Record<string, number | null>;
  materials: MaterialInfo[];
}
type Ease = Record<string, { min?: number | null; max?: number | null }>;

/** A value that settles `ms` after the last change — the edited mix is re-read once typing pauses. */
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const pct2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dpOf = (key: string) => (key === "me" ? 0 : 3);
const fmtN = (key: string, v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: dpOf(key), maximumFractionDigits: dpOf(key) });
/** Room for the solver's three-decimal rounding, so a figure held exactly at its bound reads met. */
const tol = (v: number) => Math.max(0.0006, Math.abs(v) * 1e-4);
const within = (b: { minValue: number | null; maxValue: number | null }, v: number) =>
  (b.minValue == null || v >= b.minValue - tol(b.minValue)) && (b.maxValue == null || v <= b.maxValue + tol(b.maxValue));
const askedText = (key: string, b: { minValue: number | null; maxValue: number | null }) =>
  b.minValue != null && b.maxValue != null
    ? `${fmtN(key, b.minValue)}–${fmtN(key, b.maxValue)}`
    : b.minValue != null
      ? `≥ ${fmtN(key, b.minValue)}`
      : b.maxValue != null
        ? `≤ ${fmtN(key, b.maxValue)}`
        : "—";

/**
 * The formulator workbench — docs/formulator-workbench-plan.md.
 *
 * The live recipe and the solved mix side by side against the stage's
 * standard, what the difference costs, and everything that would quietly
 * change a solve (no price, no analysis, not a feed ingredient) said before
 * Solve is pressed. Additives the standard never asks for — premix, salt,
 * a pigment — open locked at their amount, since a least-cost solve would
 * otherwise drop them as pure cost.
 */
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
  const [solvedWith, setSolvedWith] = useState("");
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [ease, setEase] = useState<Ease>({});
  /** Scale the standard to what the sheds on this feed eat — on unless turned off. */
  const [byIntake, setByIntake] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const defaultsFor = useRef<string | null>(null);

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
  // What the sheds on this formula eat — from the feed transfers and their
  // last seven days of records — and the standard scaled to it. A layer
  // standard is written for one intake; birds eating less need it denser.
  const intakeQ = useQuery<IntakeResponse>({
    queryKey: ["formulator-intake", selected],
    queryFn: () => api(`/api/feed/formulator/intake?formula=${encodeURIComponent(selected ?? "")}`),
    enabled: !!selected,
  });
  const refIntake = standard?.referenceIntakeG ?? null;
  const actualIntake = intakeQ.data?.intakeG ?? null;
  const canScale = refIntake != null && actualIntake != null && actualIntake > 0;
  const scaling = canScale && byIntake;
  const factor = scaling ? refIntake! / actualIntake! : 1;
  const sc = (v: number | null) => (v == null ? null : Math.round(v * factor * 1000) / 1000);
  const params = (standard?.params ?? []).map((p) => (factor === 1 ? p : { ...p, minValue: sc(p.minValue), maxValue: sc(p.maxValue) }));
  const written = new Map((standard?.params ?? []).map((p) => [p.nutrient, p]));

  const current = groups?.find((g) => g.name === selected);
  const lines = current?.active?.lines ?? [];

  /** Opening a formula loads its own materials and its own inclusion limits. */
  useEffect(() => {
    setResult(null);
    setEdited({});
    setEase({});
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

  /** The live recipe as percentages of its own lines, so it always adds to 100. */
  const nowMix = useMemo(() => {
    const total = lines.reduce((s, l) => s + Number(l.quantityKg), 0);
    return total > 0 ? Object.fromEntries(lines.map((l) => [l.itemId, (Number(l.quantityKg) / total) * 100])) : {};
  }, [lines]);
  const hasNow = lines.length > 0;

  const nowQ = useQuery<AnalyseResponse>({
    queryKey: ["formulator-analyse", stage, pool.join(","), "now", JSON.stringify(nowMix)],
    queryFn: () => api("/api/feed/formulator/analyse", { method: "POST", body: { stage, itemIds: pool, mix: nowMix } }),
    enabled: pool.length > 0,
  });
  const info = useMemo(() => new Map((nowQ.data?.materials ?? []).map((m) => [m.id, m])), [nowQ.data]);
  const costs = !!(nowQ.data?.costs ?? result?.costs);
  const prices = result?.prices ?? nowQ.data?.prices;

  const isLocked = (id: string) => {
    const l = limits[id];
    return !!l && l.min.trim() !== "" && l.min.trim() === l.max.trim();
  };

  /**
   * Additives open locked: a line whose item carries nothing the standard
   * bounds, and that has no limit of its own, is fixed at its amount in the
   * live recipe. Once per formula version and stage, so an unlock sticks.
   */
  useEffect(() => {
    if (!nowQ.data || !current?.active) return;
    const key = `${current.name}:${current.active.version}:${stage}`;
    if (defaultsFor.current === key) return;
    defaultsFor.current = key;
    setLimits((prev) => {
      const next = { ...prev };
      for (const l of current.active!.lines) {
        const m = info.get(l.itemId);
        const own = prev[l.itemId];
        if (!m || m.contributes || (own && (own.min.trim() || own.max.trim()))) continue;
        const at = (nowMix[l.itemId] ?? 0).toFixed(2);
        next[l.itemId] = { min: at, max: at };
      }
      return next;
    });
  }, [nowQ.data, current, stage, info, nowMix]);

  const limitsBody = () =>
    Object.fromEntries(
      Object.entries(limits)
        .filter(([id]) => pool.includes(id))
        .map(([id, v]) => [id, { min: num(v.min) ?? undefined, max: num(v.max) ?? undefined }])
        .filter(([, v]) => (v as { min?: number; max?: number }).min != null || (v as { min?: number; max?: number }).max != null),
    );
  const inputsKey = JSON.stringify([stage, pool, limits, scaling ? actualIntake : null]);
  const stale = !!result && solvedWith !== inputsKey;

  const solve = useMutation({
    mutationFn: (withEase: Ease) =>
      api<SolveResponse>("/api/feed/formulator/solve", {
        method: "POST",
        body: {
          stage,
          itemIds: pool,
          limits: limitsBody(),
          ...(Object.keys(withEase).length ? { ease: withEase } : {}),
          ...(scaling ? { intakeG: actualIntake } : {}),
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      setSolvedWith(inputsKey);
      setEdited(Object.fromEntries(Object.entries(r.solution).map(([id, p]) => [id, String(p)])));
      setError(null);
    },
    onError: (e) => {
      setResult(null);
      setError(e instanceof ApiError ? e.message : "Could not solve");
    },
  });
  const runSolve = (withEase: Ease = ease) => {
    setEase(withEase);
    solve.mutate(withEase);
  };

  const byId = useMemo(() => new Map((materials ?? []).map((m) => [m.id, m])), [materials]);
  const lineName = useMemo(() => new Map(lines.map((l) => [l.itemId, l.itemName])), [lines]);
  const nameOf = (id: string) => info.get(id)?.name ?? byId.get(id)?.name ?? lineName.get(id) ?? "—";

  const solvedMix = useMemo(
    () => Object.fromEntries(Object.entries(edited).map(([id, v]) => [id, Number(v) || 0])),
    [edited],
  );
  const mixPct = Object.entries(solvedMix).map(([id, p]) => ({ id, pct: p })).filter((x) => x.pct > 0);
  const mixTotal = mixPct.reduce((s, x) => s + x.pct, 0);
  const feasible = !!result?.feasible;
  const editedChanged =
    feasible && Object.keys({ ...result!.solution, ...solvedMix }).some((id) => Math.abs((solvedMix[id] ?? 0) - (result!.solution[id] ?? 0)) > 0.0005);
  const settled = useSettled(JSON.stringify(solvedMix), 300);
  const solQ = useQuery<AnalyseResponse>({
    queryKey: ["formulator-analyse", stage, pool.join(","), "solved", settled],
    queryFn: () => api("/api/feed/formulator/analyse", { method: "POST", body: { stage, itemIds: pool, mix: JSON.parse(settled) } }),
    enabled: feasible && editedChanged,
  });
  const solvedAnalysis = feasible ? (editedChanged ? solQ.data?.nutritionAnalysis : result!.nutritionAnalysis) : undefined;
  const solvedCost = feasible ? (editedChanged ? solQ.data?.costPerKg : result!.costPerKg) : undefined;
  const nowCost = hasNow ? nowQ.data?.costPerKg : undefined;
  // A cost that counts an unpriced material as free has to say so.
  const unpricedIds = new Set(pool.filter((id) => info.get(id) && !info.get(id)!.priced));
  const nowUnpriced = pool.filter((id) => unpricedIds.has(id) && (nowMix[id] ?? 0) > 0);
  const solvedUnpriced = feasible ? pool.filter((id) => unpricedIds.has(id) && (solvedMix[id] ?? 0) > 0) : [];

  const addable = (materials ?? []).filter((m) => !pool.includes(m.id));
  const heldTo = new Map((result?.standard ?? []).map((b) => [b.nutrient, b]));
  const easedKeys = new Set((result?.eased ?? []).map((e) => e.nutrient));

  // Which rows a failed solve is about.
  const clash = new Set<string>();
  for (const b of result && !result.feasible ? result.blockers ?? [] : []) {
    if (b.kind !== "inclusion") clash.add(b.key);
    for (const w of b.with ?? []) clash.add(w.key);
  }

  // Before Solve: everything that would quietly change the answer.
  const leftOut = (id: string) => {
    const m = info.get(id);
    return !!m && !isLocked(id) && (!m.feedIngredient || !m.priced);
  };
  const noPrice = pool.filter((id) => info.get(id) && !info.get(id)!.priced && info.get(id)!.feedIngredient && !isLocked(id));
  const lockedNoPrice = pool.filter((id) => info.get(id) && !info.get(id)!.priced && isLocked(id));
  const notFeed = pool.filter((id) => info.get(id) && !info.get(id)!.feedIngredient && !isLocked(id));
  const noNutrients = pool.filter((id) => info.get(id)?.measured === 0 && !leftOut(id));
  const lockedCount = pool.filter(isLocked).length;
  const names = (ids: string[]) => joinWords(ids.map(nameOf));

  const toggleLock = (id: string) =>
    setLimits((s) => {
      if (isLocked(id)) return { ...s, [id]: { min: "", max: "" } };
      const at = (nowMix[id] ?? solvedMix[id] ?? 0).toFixed(2);
      return { ...s, [id]: { min: at, max: at } };
    });

  /** Ease the lead bound of a failed solve to what the materials reach — this solve only. */
  /** The eased figure itself — rounded inward so it stays reachable, and the same number the button shows. */
  const easedValue = (key: string, best: number): { min?: number; max?: number } | null => {
    const b = params.find((p) => p.nutrient === key);
    if (!b) return null;
    const step = key === "me" ? 1 : 0.001;
    if (b.minValue != null && best < b.minValue) return { min: Number((Math.floor(best / step) * step).toFixed(3)) };
    if (b.maxValue != null && best > b.maxValue) return { max: Number((Math.ceil(best / step) * step).toFixed(3)) };
    return null;
  };
  const easeTo = (key: string, best: number) => {
    const e = easedValue(key, best);
    if (e) runSolve({ ...ease, [key]: e });
  };

  const inputCls = "h-6 w-[52px] rounded border border-gray-200 px-1 text-right text-[11px] tabular-nums disabled:bg-gray-50 disabled:text-gray-400";
  const saveReady = feasible && Math.abs(mixTotal - 100) <= 0.05;

  return (
    <>
      {/* The bar: which recipe, against what, what the solve changes in money, and the two actions. */}
      <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold text-gray-900">{selected || "New formula"}</span>
          {current?.active && <span className="text-[12px] text-gray-500">v{current.active.version}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-gray-500">against</span>
          <SearchSelect
            value={stage}
            onChange={(id) => {
              if (!id || id === stage) return;
              setStage(id as LifeStage);
              setResult(null);
              setEase({});
            }}
            options={LIFE_STAGES.map((s) => ({ id: s, label: LIFE_STAGE_LABELS[s] }))}
            allowClear={false}
            keepOrder
            className="w-40"
            buttonClassName="input h-8 py-0 text-[13px]"
          />
        </div>
        {costs && (nowCost != null || solvedCost != null) && (
          <div className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-400">Per finished kg</span>
            {nowCost != null && <span className="text-[15px] font-bold">{inr(nowCost)}</span>}
            {nowCost != null && nowUnpriced.length > 0 && (
              <span className="text-[11px] text-amber-700" title="These have no price, so the cost counts them as free">
                excl. {joinWords(nowUnpriced.map(nameOf))}
              </span>
            )}
            {solvedCost != null && (
              <>
                {nowCost != null && <span className="text-gray-400">→</span>}
                <span className="text-[15px] font-bold">{inr(solvedCost)}</span>
                {solvedUnpriced.length > 0 && (
                  <span className="text-[11px] text-amber-700" title="Locked without a price, so the cost counts them as free">
                    excl. {joinWords(solvedUnpriced.map(nameOf))}
                  </span>
                )}
                {nowCost != null && Math.abs(solvedCost - nowCost) >= 0.005 && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${
                      solvedCost > nowCost ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"
                    }`}
                  >
                    {solvedCost > nowCost ? "+" : "−"}
                    {inr(Math.abs(solvedCost - nowCost))} · {solvedCost > nowCost ? "+" : "−"}₹
                    {Math.round(Math.abs(solvedCost - nowCost) * 1000).toLocaleString("en-IN")} a tonne
                  </span>
                )}
              </>
            )}
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => runSolve()}
            disabled={solve.isPending || pool.length === 0 || !params.length}
            className={feasible && !stale ? "btn-secondary flex items-center gap-1.5" : "btn-primary flex items-center gap-1.5"}
          >
            <Calculator size={14} />
            {solve.isPending ? "Solving…" : result ? "Solve again" : "Solve"}
          </button>
          <button onClick={() => setSaveOpen(true)} disabled={!saveReady} className="btn-primary">
            {current ? `Save as v${(current.active?.version ?? 0) + 1}` : "Save as new formula"}
          </button>
        </div>
      </div>

      {selected && (
        <div className="mb-3 flex gap-1 border-b border-gray-200">
          {(["solve", "history"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${
                tab === t ? "border-brand-500 font-semibold text-brand-700" : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {t === "solve" ? "Workbench" : `History (${current?.history.length ?? 0})`}
            </button>
          ))}
        </div>
      )}

      {tab === "history" && current ? (
        <div className="card p-4">
          {current.history.map((h) => (
            <div key={h.version} className="flex justify-between border-b border-gray-100 py-2 text-[13px] last:border-0">
              <span>
                v{h.version}
                {h.isActive && <span className="ml-1.5 text-[11px] text-green-700">live</span>}
                <span className="ml-2 text-gray-500">{h.lineCount} materials</span>
              </span>
              <span className="text-[11px] text-gray-400">
                {formatDate(h.effectiveFrom)} · {h.createdByName ?? "—"} · {h.producedOrders} order{h.producedOrders === 1 ? "" : "s"} produced
              </span>
            </div>
          ))}
          {!current.history.length && <p className="text-[13px] text-gray-400">No versions yet.</p>}
        </div>
      ) : (
        <div className="grid gap-3">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
          {!params.length && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
              {LIFE_STAGE_LABELS[stage]} has no live feed standard, so there is nothing to solve against. Set one under Settings →
              Feed Mill → Feed Standards.
            </div>
          )}

          {/* Readiness — said before Solve, not discovered after it. */}
          {pool.length > 0 && nowQ.data && (noPrice.length + lockedNoPrice.length + notFeed.length + noNutrients.length + lockedCount > 0) && (
            <div className="flex flex-wrap gap-2 text-[12px]">
              {noPrice.length > 0 && (
                <span className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-red-700">
                  No price — {names(noPrice)} {noPrice.length === 1 ? "has" : "have"} never been billed and carr{noPrice.length === 1 ? "ies" : "y"} no price on the item, so a solve leaves {noPrice.length === 1 ? "it" : "them"} out.
                </span>
              )}
              {lockedNoPrice.length > 0 && (
                <span className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-800">
                  Locked without a price — {names(lockedNoPrice)}: in the mix, left out of the cost.
                </span>
              )}
              {noNutrients.length > 0 && (
                <span className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-800">
                  No nutrients on file — {names(noNutrients)}: counted as zero.
                </span>
              )}
              {notFeed.length > 0 && (
                <span className="rounded-md border border-soil-200 bg-soil-50 px-2.5 py-1 text-soil-600">
                  Not a feed ingredient — {names(notFeed)}: left out unless locked.
                </span>
              )}
              {lockedCount > 0 && (
                <span className="rounded-md border border-soil-200 bg-soil-50 px-2.5 py-1 text-soil-600">
                  {lockedCount} locked at a fixed amount
                </span>
              )}
            </div>
          )}

          {selected && intakeQ.data && (
            <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-[12.5px] text-gray-700">
              {intakeQ.data.houses.length === 0 ? (
                <span className="text-gray-500">No feed transfers of {selected} on file, so there is no intake to scale the standard to — it is used as written.</span>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                  <div className="min-w-0 space-y-0.5">
                    <div>
                      Fed to <span className="font-semibold">{joinWords(intakeQ.data.houses.map((h) => h.code))}</span>
                      <span className="text-gray-500">
                        {" "}(transfers {intakeQ.data.transfers ? `${formatDate(intakeQ.data.transfers.from)} – ${formatDate(intakeQ.data.transfers.to)}` : ""})
                      </span>
                      {actualIntake != null && (
                        <>
                          , eating <span className="font-semibold tabular-nums">{actualIntake.toFixed(1)} g</span> a bird a day over their last 7 days
                        </>
                      )}
                      .
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-[11.5px] text-gray-500">
                      {intakeQ.data.houses.map((h) => (
                        <span key={h.houseId} className="tabular-nums">
                          {h.code}: {h.intakeG == null ? "no records" : `${h.intakeG.toFixed(1)} g`}
                          {h.birds != null && ` · ${h.birds.toLocaleString("en-IN")} birds`}
                          {h.from && h.to && ` · ${formatDate(h.from)} – ${formatDate(h.to)}`}
                        </span>
                      ))}
                    </div>
                    {canScale && (
                      <div className="text-[11.5px] text-gray-500">
                        {LIFE_STAGE_LABELS[stage]} is written for {refIntake} g
                        {scaling
                          ? `, so every requirement is ×${factor.toFixed(3)} (${refIntake} ÷ ${actualIntake!.toFixed(1)}) — energy included, since the guide gives it per bird per day.`
                          : " — the requirements below are as written."}
                        {scaling && Math.abs(actualIntake! - refIntake!) > 10 && (
                          <span className="ml-1 text-amber-700">
                            That is outside the guide's own table ({refIntake! - 10}–{refIntake! + 10} g), so the figures are scaled beyond it.
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {canScale && (
                    <label className="flex shrink-0 items-center gap-2 text-[12px] text-gray-600">
                      <input type="checkbox" checked={byIntake} onChange={(e) => setByIntake(e.target.checked)} className="accent-brand-500" />
                      Scale to this intake
                    </label>
                  )}
                </div>
              )}
            </div>
          )}

          {stale && (
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600">
              The materials or their limits have changed since this solve — Solve again to see the effect.
            </div>
          )}

          {feasible && (result!.eased ?? []).length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
              <span>
                Solved with{" "}
                {joinWords(result!.eased!.map((e) => `${nutrientLabel(e.nutrient)} eased to ${askedText(e.nutrient, { minValue: e.to.min, maxValue: e.to.max })}`))}
                {" — "}this solve only; the {LIFE_STAGE_LABELS[stage]} standard is unchanged and this mix does not meet it.
              </span>
              <button onClick={() => runSolve({})} className="btn-ghost h-7 text-[12px]">
                Solve to the standard
              </button>
            </div>
          )}

          {result && !result.feasible && (
            <div className="rounded-xl border border-red-200 bg-red-50/60 p-3.5">
              <div className="text-[13px] font-semibold text-red-700">{result.message}</div>
              {(result.leftOutRich ?? []).length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-[12.5px] text-amber-800">
                  <span className="font-semibold">Price these first. </span>
                  {joinWords(
                    (() => {
                      const seen = new Map<string, string[]>();
                      for (const r of result.leftOutRich!) for (const m of r.materials) seen.set(m.name, [...(seen.get(m.name) ?? []), `${fmtN(r.nutrient, m.value)} ${nutrientLabel(r.nutrient)}`]);
                      return [...seen].map(([n, what]) => `${n} (${what.join(", ")})`);
                    })(),
                  )}{" "}
                  {(result.leftOutRich ?? []).flatMap((r) => r.materials).length === 1 ? "carries" : "carry"} what this solve is short of, but
                  {" "}has no price, so the solve left it out. Easing a bound works around a material that is only missing a price.
                </div>
              )}
              {(result.blockers ?? []).map((b) => (
                <div key={`${b.key}:${b.with?.map((w) => w.key).join(",") ?? ""}`} className="mt-2 border-l-2 border-red-300 pl-2.5">
                  <div className="text-[13px] font-medium text-gray-900">
                    {b.kind === "conflict" && b.with
                      ? joinWords([b.key, ...b.with.map((w) => w.key)].map(nutrientLabel))
                      : b.kind === "nutrient"
                        ? nutrientLabel(b.key)
                        : b.label}
                    <span className="ml-2 text-[12px] font-normal text-gray-500">
                      asked {b.asked}
                      {b.with?.map((w) => <span key={w.key}>, {w.asked}</span>)}
                    </span>
                  </div>
                  <div className="text-[12px] text-gray-600">
                    {b.kind === "conflict" && b.with
                      ? b.best == null
                        ? "Each can be met alone, not all together."
                        : `Each can be met alone, not all together. Meeting the others, the best ${nutrientLabel(b.key)} these materials reach is ${b.best}.`
                      : b.detail}
                  </div>
                  {b.kind !== "inclusion" && (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {/* Eased to what every OTHER bound allows, so the one click lands on a
                          mix — the clash group's own figure can still leave another bound short. */}
                      {(b.easeTo ?? (b.kind === "nutrient" ? b.best : null)) != null && (
                        <button onClick={() => easeTo(b.key, (b.easeTo ?? b.best)!)} className="btn-secondary h-7 text-[12px]">
                          Try with {nutrientLabel(b.key)} at {(() => { const e = easedValue(b.key, (b.easeTo ?? b.best)!); return fmtN(b.key, e?.min ?? e?.max ?? (b.easeTo ?? b.best)!); })()} — this solve only
                        </button>
                      )}
                      <button
                        onClick={() => addRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                        className="btn-ghost h-7 text-[12px]"
                      >
                        Add a material richer in {b.kind === "conflict" ? "them" : "it"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            {/* ── Materials ── */}
            <div className="card overflow-hidden">
              <div className="flex items-baseline justify-between border-b border-gray-100 px-3 py-2">
                <span className="text-[13px] font-semibold">Materials</span>
                <span className="text-[11px] text-gray-400">% of the mix{costs ? " · ₹ per kg as bought" : ""}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-[12px]">
                  <thead className="table-head">
                    <tr className="border-b border-gray-100">
                      <th className="px-2 py-1 text-left font-medium">Material</th>
                      {costs && <th className="px-1 py-1 text-right font-medium">₹/kg</th>}
                      <th className="px-1 py-1 text-center font-medium" title="Fix at an exact percentage">Lock</th>
                      <th className="px-1 py-1 text-right font-medium">Min</th>
                      <th className="px-1 py-1 text-right font-medium">Max</th>
                      {hasNow && <th className="px-1.5 py-1 text-right font-medium">Now</th>}
                      {feasible && <th className="px-1.5 py-1 text-right font-medium">Solved</th>}
                      {feasible && hasNow && <th className="px-1.5 py-1 text-right font-medium">Change</th>}
                      <th className="w-6" />
                    </tr>
                  </thead>
                  <tbody>
                    {pool.map((id) => {
                      const m = info.get(id);
                      const locked = isLocked(id);
                      const out = leftOut(id);
                      const now = nowMix[id] ?? 0;
                      const sol = solvedMix[id] ?? 0;
                      const d = sol - now;
                      return (
                        <tr key={id} className={`border-b border-gray-100 ${out ? "text-gray-400" : ""}`}>
                          <td className="px-2 py-1">
                            <span className={`font-medium ${out ? "line-through" : "text-gray-900"}`}>{nameOf(id)}</span>
                            {m && !m.feedIngredient && (
                              <span className="ml-1.5 rounded bg-soil-100 px-1 py-px text-[10px] text-soil-600" title="Not marked as a feed ingredient — mark it on the item's Nutrition tab, or lock it to keep it in the mix">
                                not a feed ingredient
                              </span>
                            )}
                            {m && !m.priced && <span className="ml-1.5 rounded bg-red-50 px-1 py-px text-[10px] text-red-700">no price</span>}
                            {m && m.measured === 0 && m.feedIngredient && <span className="ml-1.5 rounded bg-amber-50 px-1 py-px text-[10px] text-amber-700">no nutrients</span>}
                            {m && m.measured > 0 && m.measured < NUTRIENTS.length && (
                              <span className="ml-1 cursor-help text-amber-600" title={`Only ${m.measured} of ${NUTRIENTS.length} nutrients on file — the rest count as zero`}>
                                *
                              </span>
                            )}
                          </td>
                          {costs && (
                            <td
                              className={`px-1 py-1 text-right tabular-nums ${m?.priceBasis === "standing price" ? "text-amber-700" : "text-gray-500"}`}
                              title={
                                m?.priceBasis === "delivered" || m?.priceBasis === "last bill"
                                  ? `${m.priceBasis === "delivered" ? "Delivered cost of the last load" : "Last bill"}, ${m.pricedOn ? formatDate(m.pricedOn) : ""}`
                                  : m?.priceBasis === "standing price"
                                    ? "Never billed — the price typed on the item"
                                    : m?.priceBasis === "not per kg"
                                      ? "Bought by the pack with no pack weight on the item — no honest price per kg"
                                      : "Never bought and no price on the item"
                              }
                            >
                              {prices?.[id] == null ? "—" : Number(prices[id]).toFixed(2)}
                            </td>
                          )}
                          <td className="px-1 py-0.5 text-center">
                            <button
                              onClick={() => toggleLock(id)}
                              aria-pressed={locked}
                              title={locked ? `Locked at ${limits[id]?.min}% — click to free it` : "Lock at its amount in the recipe"}
                              className={`inline-grid h-6 w-6 place-items-center rounded border ${
                                locked ? "border-soil-900 bg-soil-900 text-white" : "border-gray-200 text-gray-300 hover:text-gray-500"
                              }`}
                            >
                              {locked ? <Lock size={12} /> : <LockOpen size={12} />}
                            </button>
                          </td>
                          {(["min", "max"] as const).map((k) => (
                            <td key={k} className="px-1 py-0.5 text-right">
                              <input
                                value={limits[id]?.[k] ?? ""}
                                disabled={locked}
                                onChange={(e) => setLimits((s) => ({ ...s, [id]: { min: "", max: "", ...s[id], [k]: e.target.value } }))}
                                inputMode="decimal"
                                aria-label={`${k} % for ${nameOf(id)}`}
                                className={inputCls}
                              />
                            </td>
                          ))}
                          {hasNow && <td className="px-1.5 py-1 text-right tabular-nums">{now > 0 ? pct2(now) : <span className="text-gray-300">—</span>}</td>}
                          {feasible && (
                            <td className="px-1.5 py-0.5 text-right">
                              {out ? (
                                <span className="text-[11px]">left out</span>
                              ) : (
                                <input
                                  value={edited[id] ?? "0"}
                                  onChange={(e) => setEdited((s) => ({ ...s, [id]: e.target.value }))}
                                  inputMode="decimal"
                                  aria-label={`Solved % for ${nameOf(id)}`}
                                  className={`h-6 w-[62px] rounded border px-1 text-right text-[12px] font-semibold tabular-nums ${
                                    Math.abs(sol - (result!.solution[id] ?? 0)) > 0.0005 ? "border-yolk-400 bg-yolk-50" : "border-gray-200"
                                  }`}
                                />
                              )}
                            </td>
                          )}
                          {feasible && hasNow && (
                            <td className="px-1.5 py-1 text-right">
                              {out || Math.abs(d) < 0.005 ? (
                                <span className="text-gray-300">—</span>
                              ) : (
                                <span className="inline-flex items-center justify-end gap-1.5">
                                  <span className={`h-1.5 rounded-full ${d > 0 ? "bg-yolk-500" : "bg-soil-400"}`} style={{ width: `${Math.min(56, Math.abs(d) * 3)}px` }} />
                                  <span className={`w-11 text-right tabular-nums ${d > 0 ? "text-yolk-700" : "text-soil-600"}`}>
                                    {d > 0 ? "+" : "−"}
                                    {pct2(Math.abs(d))}
                                  </span>
                                </span>
                              )}
                            </td>
                          )}
                          <td className="pr-1">
                            <button
                              onClick={() => setPool((p) => p.filter((x) => x !== id))}
                              className="text-gray-300 hover:text-red-600"
                              title="Take out of consideration"
                            >
                              <X size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {!pool.length && (
                      <tr>
                        <td colSpan={9} className="px-2 py-3 text-center text-gray-400">
                          Add the materials you are willing to buy.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {pool.length > 0 && (hasNow || feasible) && (
                    <tfoot>
                      <tr className="border-t border-gray-200 bg-gray-50 font-semibold">
                        <td className="px-2 py-1.5">Total</td>
                        {costs && <td />}
                        <td />
                        <td />
                        <td />
                        {hasNow && <td className="px-1.5 py-1.5 text-right tabular-nums">100.00</td>}
                        {feasible && (
                          <td className={`px-1.5 py-1.5 text-right tabular-nums ${Math.abs(mixTotal - 100) <= 0.05 ? "" : "text-red-600"}`}>
                            {pct2(mixTotal)}
                          </td>
                        )}
                        {feasible && hasNow && <td />}
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              <div ref={addRef} className="border-t border-gray-100 p-2">
                <SearchSelect
                  value={null}
                  onChange={(id) => id && setPool((p) => [...p, id])}
                  options={addable.map((m) => ({ id: m.id, label: m.name }))}
                  placeholder="+ Add material…"
                  allowClear={false}
                  buttonClassName="input h-7 py-0 text-[12px]"
                />
              </div>
              {feasible && Math.abs(mixTotal - 100) > 0.05 && (
                <div className="border-t border-gray-100 px-3 py-2 text-[12px] text-red-600">The mix must add to 100% before it can be saved.</div>
              )}
            </div>

            {/* ── Against the standard ── */}
            <div className="card overflow-hidden">
              <div className="flex items-baseline justify-between border-b border-gray-100 px-3 py-2">
                <span className="text-[13px] font-semibold">
                  Against {LIFE_STAGE_LABELS[stage]}
                  {standard?.version && <span className="ml-1.5 text-[11px] font-normal text-gray-400">v{standard.version}</span>}
                  {scaling && <span className="ml-1.5 text-[11px] font-normal text-gray-500">at {actualIntake!.toFixed(1)} g/bird/day</span>}
                </span>
                <span className="text-[11px] text-gray-400">
                  {feasible && solvedAnalysis
                    ? `solved mix meets ${params.filter((p) => within(heldTo.get(p.nutrient) ?? p, solvedAnalysis[p.nutrient] ?? 0) && within(p, solvedAnalysis[p.nutrient] ?? 0)).length} of ${params.length}`
                    : hasNow && nowQ.data
                      ? `live recipe misses ${params.filter((p) => !within(p, nowQ.data!.nutritionAnalysis[p.nutrient] ?? 0)).length} of ${params.length}`
                      : ""}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-[12px]">
                  <thead className="table-head">
                    <tr className="border-b border-gray-100">
                      <th className="px-2 py-1 text-left font-medium">Nutrient</th>
                      <th className="px-1.5 py-1 text-right font-medium">Asked</th>
                      {hasNow && <th className="px-1.5 py-1 text-right font-medium">Now</th>}
                      {feasible && <th className="px-1.5 py-1 text-right font-medium">Solved</th>}
                      <th className="px-2 py-1 text-left font-medium">Where it sits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {params.map((p) => {
                      const vn = hasNow ? nowQ.data?.nutritionAnalysis[p.nutrient] : undefined;
                      const vs = solvedAnalysis?.[p.nutrient];
                      const hit = clash.has(p.nutrient);
                      const eased = easedKeys.has(p.nutrient);
                      return (
                        <tr key={p.nutrient} className={`border-b border-gray-100 ${hit ? "bg-red-50/70" : ""}`} style={hit ? { boxShadow: "inset 3px 0 0 #dc2626" } : undefined}>
                          <td className="px-2 py-1">{nutrientLabel(p.nutrient)}</td>
                          <td
                            className="px-1.5 py-1 text-right tabular-nums text-gray-600"
                            title={scaling && written.get(p.nutrient) ? `Written as ${askedText(p.nutrient, written.get(p.nutrient)!)} for ${refIntake} g/bird/day` : undefined}
                          >
                            {askedText(p.nutrient, p)}
                            {eased && (
                              <span className="ml-1 rounded bg-amber-50 px-1 py-px text-[10px] text-amber-700" title="Eased for this solve only">
                                eased {askedText(p.nutrient, heldTo.get(p.nutrient)!)}
                              </span>
                            )}
                          </td>
                          {hasNow && (
                            <td className="px-1.5 py-1 text-right tabular-nums">
                              {vn == null ? "—" : (
                                <>
                                  {fmtN(p.nutrient, vn)}
                                  {!feasible && <Verdict ok={within(p, vn)} />}
                                </>
                              )}
                            </td>
                          )}
                          {feasible && (
                            <td className="px-1.5 py-1 text-right tabular-nums">
                              {vs == null ? "…" : (
                                <>
                                  {fmtN(p.nutrient, vs)}
                                  <Verdict ok={within(p, vs)} />
                                </>
                              )}
                            </td>
                          )}
                          <td className="px-2 py-1">
                            <TwoMarkStrip min={p.minValue} max={p.maxValue} now={vn} solved={vs} />
                          </td>
                        </tr>
                      );
                    })}
                    {!params.length && (
                      <tr>
                        <td colSpan={5} className="px-2 py-3 text-center text-gray-400">No standard set for this stage.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {params.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-100 px-3 py-2 text-[11px] text-gray-500">
                  {hasNow && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-soil-600 bg-white" /> Live recipe
                    </span>
                  )}
                  {feasible && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded-full bg-yolk-600" /> Solved mix
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 w-4 rounded-sm bg-green-200" /> Inside the standard
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 w-4 rounded-sm bg-red-200" /> Outside it
                  </span>
                </div>
              )}
            </div>
          </div>

          {feasible && result!.unmeasured.length > 0 && (
            <details className="text-[12px] text-amber-700">
              <summary className="cursor-pointer">
                Counted as zero where no figure is on file — {joinWords(result!.unmeasured.map((u) => u.ingredientName))}
              </summary>
              <div className="mt-1 space-y-0.5 pl-4">
                {result!.unmeasured.map((u) => (
                  <div key={u.ingredientName}>
                    {u.ingredientName}: {u.nutrients.map(nutrientLabel).join(", ")}
                  </div>
                ))}
              </div>
            </details>
          )}

          {feasible && (hasNow || (result!.shadowPrices?.length ?? 0) > 0) && (
            <div className="grid items-start gap-3 lg:grid-cols-2">
              {hasNow && (
                <div className="card overflow-hidden">
                  <div className="flex items-baseline justify-between border-b border-gray-100 px-3 py-2">
                    <span className="text-[13px] font-semibold">What v{(current?.active?.version ?? 0) + 1} changes</span>
                    <span className="text-[11px] text-gray-400">points of the mix</span>
                  </div>
                  <div className="grid gap-1 px-3 py-2 text-[12.5px]">
                    {pool
                      .map((id) => ({ id, d: (solvedMix[id] ?? 0) - (nowMix[id] ?? 0) }))
                      .filter((x) => Math.abs(x.d) >= 0.05 && !leftOut(x.id))
                      .sort((a, b) => b.d - a.d)
                      .map(({ id, d }) => (
                        <div key={id} className="flex justify-between gap-3">
                          <span>
                            {nameOf(id)}
                            {(solvedMix[id] ?? 0) < 0.005 && <span className="ml-1.5 rounded bg-soil-100 px-1 py-px text-[10px] text-soil-600">out</span>}
                            {(nowMix[id] ?? 0) < 0.005 && <span className="ml-1.5 rounded bg-yolk-100 px-1 py-px text-[10px] text-yolk-700">new</span>}
                          </span>
                          <span className={`tabular-nums ${d > 0 ? "text-yolk-700" : "text-soil-600"}`}>
                            {d > 0 ? "+" : "−"}
                            {pct2(Math.abs(d))}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
              {(result!.shadowPrices?.length ?? 0) > 0 && (
                <div className="card overflow-hidden">
                  <div className="border-b border-gray-100 px-3 py-2">
                    <div className="text-[13px] font-semibold">Left out, and what would bring it back</div>
                    <div className="text-[11px] text-gray-400">Break-even price — buy under it and the mix gets cheaper</div>
                  </div>
                  <div className="grid gap-2.5 px-3 py-2.5">
                    {result!.shadowPrices!.map((s) => (
                      <div key={s.ingredientId} className="grid grid-cols-[minmax(0,1fr)_140px] items-center gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[12.5px] font-medium">{s.ingredientName}</div>
                          <div className="text-[11.5px] text-gray-500">
                            {s.breakEvenPrice == null ? s.insight : `now ${inr(s.currentPrice)} · comes back under ${inr(s.breakEvenPrice)}`}
                          </div>
                        </div>
                        {s.breakEvenPrice != null && <PriceGap now={s.currentPrice} breakEven={s.breakEvenPrice} />}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {saveOpen && feasible && (
        <SaveDialog
          formulaName={current?.name ?? ""}
          existing={current?.active ?? null}
          stage={stage}
          mix={mixPct.map((m) => ({ itemId: m.id, name: nameOf(m.id), pct: m.pct }))}
          limits={limits}
          eased={(result!.eased ?? []).map((e) => `${nutrientLabel(e.nutrient)} at ${askedText(e.nutrient, { minValue: e.to.min, maxValue: e.to.max })}`)}
          onClose={() => setSaveOpen(false)}
          onSaved={(msg) => {
            setSaveOpen(false);
            setResult(null);
            setEase({});
            defaultsFor.current = null;
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

function Verdict({ ok }: { ok: boolean }) {
  return (
    <span className={`ml-1.5 rounded px-1 py-px text-[10px] font-semibold ${ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
      {ok ? "met" : "short"}
    </span>
  );
}

/**
 * A nutrient's window with the live recipe (hollow) and the solved mix
 * (solid) marked on it — how far each sits inside or outside, not only
 * whether. The shared BandStrip carries one marker; this needs two.
 */
function TwoMarkStrip({ min, max, now, solved }: { min: number | null; max: number | null; now?: number; solved?: number }) {
  const vals = [min, max, now, solved].filter((v): v is number => v != null && Number.isFinite(v));
  if (!vals.length || (min == null && max == null)) return null;
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  const pad = Math.max((hi0 - lo0) * 0.25, Math.abs(hi0) * 0.04, 0.001);
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const W = 130;
  const x = (v: number) => 4 + ((v - lo) / (hi - lo)) * (W - 8);
  const a = min != null ? x(min) : 4;
  const b = max != null ? x(max) : W - 4;
  return (
    <svg width={W} height={16} viewBox={`0 0 ${W} 16`} className="block" aria-hidden>
      <rect x={4} y={5} width={W - 8} height={6} rx={3} fill="#fecaca" />
      <rect x={a} y={5} width={Math.max(2, b - a)} height={6} fill="#bbf7d0" />
      {now != null && Number.isFinite(now) && <circle cx={x(now)} cy={8} r={3.8} fill="#fff" stroke="#6b5a3f" strokeWidth={2} />}
      {solved != null && Number.isFinite(solved) && <circle cx={x(solved)} cy={8} r={3.4} fill="#e06d05" />}
    </svg>
  );
}

/** Today's price against the break-even: how far a quote has to fall. */
function PriceGap({ now, breakEven }: { now: number; breakEven: number }) {
  const W = 140;
  const top = Math.max(now, breakEven) * 1.05;
  const x = (v: number) => 4 + (v / top) * (W - 8);
  return (
    <svg width={W} height={16} viewBox={`0 0 ${W} 16`} className="block" aria-hidden>
      <rect x={4} y={5} width={W - 8} height={6} rx={3} fill="#f1ebdd" />
      <rect x={4} y={5} width={Math.max(2, x(breakEven) - 4)} height={6} rx={3} fill="#bbf7d0" />
      <circle cx={x(breakEven)} cy={8} r={3.4} fill="#15803d" />
      <circle cx={x(now)} cy={8} r={3.4} fill="#6b5a3f" />
    </svg>
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
  eased,
  onClose,
  onSaved,
}: {
  formulaName: string;
  existing: FormulaGroup["active"];
  stage: LifeStage;
  mix: Array<{ itemId: string; name: string; pct: number }>;
  limits: Record<string, { min: string; max: string }>;
  /** Bounds this solve was eased on — the saved mix does not meet the standard as written. */
  eased: string[];
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
          effectiveFrom: localYmd(),
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

        {eased.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
            Solved with {eased.join(" and ")}, eased for this solve — this mix does not meet the standard as written.
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
                <SearchSelect
                  value={outputItemId || null}
                  onChange={(id) => setOutputItemId(id ?? "")}
                  options={(outputs ?? []).map((o) => ({ id: o.id, label: o.name }))}
                  placeholder="Select…"
                />
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
          <thead className="table-head">
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
