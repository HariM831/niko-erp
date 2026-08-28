/**
 * Formulas — the recipes the mill produces to.
 *
 * Two views, and the split is the point. "All formulas" compares every live
 * recipe side by side, because a formula read on its own says almost nothing.
 * Opening one puts it in the solver, because the interesting question about a
 * single formula is never "what is in it" — the comparison already answers
 * that — but "given today's prices, what should be in it".
 *
 * There is deliberately no plain editor any more. Typing kilos into a form is a
 * worse tool than a pencil: it cannot tell you the mix misses the standard, and
 * it cannot tell you what the change costs. The solver does both, and saving
 * from it still supersedes — a production order records the exact version it
 * was made to, so an old batch stays readable against the recipe of its day.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../api";
import { FormulaMatrix } from "../components/formula-matrix";
import { FormulaSolver } from "../components/formula-solver";

interface FormulaGroup {
  name: string;
  active: { version: number; batchSizeKg: string; lines: unknown[] } | null;
}

const kg = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

export function FeedFormulasPage() {
  /** null = the comparison. "" = a formula that does not exist yet. */
  const [selected, setSelected] = useState<string | null>(null);

  const { data: groups } = useQuery<FormulaGroup[]>({
    queryKey: ["feed-formulas"],
    queryFn: () => api("/api/feed/formulas"),
  });

  const entry = (key: string | null, title: string, sub: string) => (
    <button
      onClick={() => setSelected(key)}
      className={`shrink-0 whitespace-nowrap rounded-lg border px-3 py-1.5 text-left hover:bg-gray-50 lg:block lg:w-full lg:rounded-none lg:border-0 lg:border-b lg:border-gray-100 lg:py-2 ${selected === key ? "border-brand-300 bg-brand-50" : "border-gray-200"}`}
    >
      <div className="truncate text-[13px] font-medium text-gray-900">{title}</div>
      <div className="hidden text-[11px] text-gray-400 lg:block">{sub}</div>
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-start justify-between gap-2 px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold">Formulas</h1>
          </div>
        <button
          onClick={() => setSelected("")}
          className="btn-secondary flex shrink-0 items-center gap-1"
        >
          <Plus size={14} /> New formula
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex shrink-0 gap-2 overflow-x-auto border-b bg-white p-2 lg:w-56 lg:flex-col lg:gap-0 lg:overflow-x-visible lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-0">
          {entry(null, "All formulas", "Side by side, with cost per kg")}
          {groups?.map((g) => (
            <div key={g.name}>
              {entry(
                g.name,
                g.name,
                g.active
                  ? `v${g.active.version} · ${g.active.lines.length} materials · ${kg(Number(g.active.batchSizeKg))} kg`
                  : "no live version",
              )}
            </div>
          ))}
          {groups && !groups.length && (
            <p className="p-4 text-[13px] text-gray-400">No formulas yet.</p>
          )}
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-surface p-3 lg:p-5">
          <div className="mx-auto max-w-5xl">
            {selected === null ? (
              <FormulaMatrix onPick={(n) => setSelected(n)} />
            ) : (
              <FormulaSolver
                key={selected}
                selected={selected === "" ? null : selected}
                onSaved={(name) => setSelected(name)}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
