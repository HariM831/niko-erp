/**
 * Every live formula in one table, and what each one delivers.
 *
 * Read across a row, not down a column. A recipe on its own says very little;
 * four side by side say immediately that soya is what makes the chick mash
 * dear, and that limestone triples as the bird comes into lay. That comparison
 * is the whole reason this screen exists, so the layout is a matrix rather than
 * four stacked tables somebody has to hold in their head.
 *
 * Every figure is computed on the server — the cost a person reads here is the
 * one production will charge, from the same milling preferences.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

interface Head {
  id: string;
  name: string;
  version: number;
  stage: string | null;
  outputItemName: string | null;
  effectiveFrom: string;
  totalKg: number;
  materialCost: number;
  outputKg: number;
  overhead: number;
  costPerFinishedKg: number;
  thinAnalysis: Array<{ name: string; kg: number; measured: number }>;
}
interface Ingredient {
  itemId: string;
  name: string;
  ratePerKg: number;
  qty: Record<string, number>;
}
interface Nutrient {
  key: string;
  label: string;
  unit: string;
  group: string;
  values: Record<string, number>;
  blindKg: Record<string, number>;
}
interface Matrix {
  formulas: Head[];
  ingredients: Ingredient[];
  nutrients: Nutrient[];
  withoutLive: string[];
}

const GROUPS: Array<{ group: string; label: string }> = [
  { group: "energy", label: "Energy" },
  { group: "proximate", label: "Proximates" },
  { group: "mineral", label: "Minerals" },
  { group: "amino", label: "Digestible amino acids" },
];

const money = (v: number) =>
  v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kgs = (v: number) =>
  v.toLocaleString("en-IN", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 3 });

export function FormulaMatrix({ onPick }: { onPick?: (name: string) => void }) {
  const { data, isLoading } = useQuery<Matrix>({
    queryKey: ["feed-formula-matrix"],
    queryFn: () => api("/api/feed/formulas/matrix"),
  });

  if (isLoading) return <p className="p-4 text-[13px] text-gray-400">Loading…</p>;
  if (!data?.formulas.length) {
    return (
      <div className="card p-6 text-center text-[13px] text-gray-500">
        No formula has a live version yet.
      </div>
    );
  }

  const f = data.formulas;
  const col = "w-[86px] px-2 py-1.5 text-right tabular-nums";
  const head = "px-2 py-1.5 text-right text-[12px] font-medium text-gray-500";

  return (
    <div className="space-y-6">
      <div className="card overflow-hidden">
        <div className="border-b border-gray-100 px-4 py-2.5">
          <div className="text-[13px] font-semibold text-gray-900">Formulas</div>
          <div className="text-[12px] text-gray-500">Live version of each, kg per batch</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="px-3 py-1.5 text-left text-[12px] font-medium text-gray-500">
                  Ingredient
                </th>
                <th className={`${head} w-[70px]`}>₹/kg</th>
                {f.map((x) => (
                  <th key={x.id} className={`${head} w-[86px]`}>
                    <button
                      onClick={() => onPick?.(x.name)}
                      className="text-[12px] font-semibold text-gray-900 hover:text-brand-700 hover:underline"
                      title={`Open ${x.name}`}
                    >
                      {x.name}
                    </button>
                    <div className="font-normal text-gray-400">v{x.version}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.ingredients.map((ing) => (
                <tr key={ing.itemId} className="border-b border-gray-100">
                  <td className="whitespace-nowrap px-3 py-1.5">{ing.name}</td>
                  <td className={`${col} w-[70px] text-gray-500`}>{money(ing.ratePerKg)}</td>
                  {f.map((x) => (
                    <td
                      key={x.id}
                      className={`${col} ${ing.qty[x.id] ? "" : "text-gray-300"}`}
                    >
                      {ing.qty[x.id] ? kgs(ing.qty[x.id]!) : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot className="text-gray-700">
              <tr className="border-t border-gray-200 font-semibold">
                <td className="px-3 py-2">Batch total, kg</td>
                <td />
                {f.map((x) => (
                  <td key={x.id} className={col}>
                    {kgs(x.totalKg)}
                  </td>
                ))}
              </tr>
              <tr className="text-gray-500">
                <td className="px-3 py-1">Material cost</td>
                <td />
                {f.map((x) => (
                  <td key={x.id} className={col}>
                    {money(x.materialCost)}
                  </td>
                ))}
              </tr>
              {/* Named rather than folded into the rate, because a mill that
                  changes its overhead should see which figure moved. */}
              <tr className="text-gray-500">
                <td className="px-3 py-1">Milling overhead</td>
                <td />
                {f.map((x) => (
                  <td key={x.id} className={col}>
                    {money(x.overhead)}
                  </td>
                ))}
              </tr>
              <tr className="text-gray-500">
                <td className="px-3 py-1">Yield after moisture, kg</td>
                <td />
                {f.map((x) => (
                  <td key={x.id} className={col}>
                    {kgs(x.outputKg)}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-gray-200">
                <td className="px-3 py-2.5 text-[14px] font-semibold text-gray-900">
                  Cost per finished kg
                </td>
                <td />
                {f.map((x) => (
                  <td key={x.id} className={`${col} text-[15px] font-semibold text-gray-900`}>
                    ₹{money(x.costPerFinishedKg)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-gray-100 px-4 py-2.5">
          <div className="text-[13px] font-semibold text-gray-900">Nutrient profile</div>
          <div className="text-[12px] text-gray-500">Weighted across each mix, per kg</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="px-3 py-1.5 text-left text-[12px] font-medium text-gray-500">
                  Nutrient
                </th>
                {f.map((x) => (
                  <th key={x.id} className={`${head} w-[86px] text-gray-900`}>
                    {x.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GROUPS.map(({ group, label }) => {
                const rows = data.nutrients.filter((n) => n.group === group);
                if (!rows.length) return null;
                return (
                  <>
                    <tr key={group}>
                      <td
                        colSpan={f.length + 1}
                        className="px-3 pb-1 pt-3 text-[12px] text-gray-500"
                      >
                        {label}
                      </td>
                    </tr>
                    {rows.map((n) => (
                      <tr key={n.key} className="border-b border-gray-100">
                        <td className="px-3 py-1.5">
                          {n.label}
                          <span className="ml-1 text-gray-400">{n.unit}</span>
                        </td>
                        {f.map((x) => {
                          // Flagged only where the silence is big enough to
                          // move the figure. Below that the note under the
                          // table covers it, and marking every cell marks
                          // nothing.
                          const blind = (n.blindKg[x.id] ?? 0) / (x.totalKg || 1) > 0.05;
                          return (
                            <td key={x.id} className={col}>
                              {n.values[x.id]?.toFixed(n.unit === "%" ? 3 : 1)}
                              {/* An ingredient with nothing on file counts as
                                  zero, which understates the mix. Flagged where
                                  it happens rather than in a footnote nobody
                                  reads — a phosphorus source carrying no
                                  phosphorus is how a ration reads short of a
                                  limit it actually meets. */}
                              {blind && (
                                <span
                                  className="ml-0.5 cursor-help text-amber-600"
                                  title={`${kgs(n.blindKg[x.id] ?? 0)} kg of this mix has no ${n.label.toLowerCase()} on file — counted as zero`}
                                >
                                  *
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
        {f.some((x) => x.thinAnalysis.length > 0) && (
          <div className="border-t border-gray-100 px-4 py-2.5 text-[11px] text-gray-500">
            {/* The honest health warning on the whole table. An ingredient with
                nothing on file counts as zero, so every figure above is a floor
                rather than an estimate — a phosphorus source carrying no
                phosphorus is how a ration reads short of a limit it meets. */}
            <div className="mb-1">
              Anything not on file counts as zero, so these are floors, not estimates. Fill the
              gaps in Feed Mill → Nutrient Profiles.
            </div>
            {f
              .filter((x) => x.thinAnalysis.length > 0)
              .map((x) => (
                <div key={x.id}>
                  <span className="font-medium text-gray-600">{x.name}</span>{" "}
                  {x.thinAnalysis
                    .slice(0, 4)
                    .map((t) => `${t.name} (${t.measured}/20)`)
                    .join(", ")}
                  {x.thinAnalysis.length > 4 && ` +${x.thinAnalysis.length - 4} more`}
                </div>
              ))}
          </div>
        )}
      </div>

      {data.withoutLive.length > 0 && (
        <p className="text-[12px] text-gray-500">
          Not shown, no live version: {data.withoutLive.join(", ")}.
        </p>
      )}
    </div>
  );
}
