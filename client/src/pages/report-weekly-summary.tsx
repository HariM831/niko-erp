import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Weekly Management Summary.
 *
 * One row per age WEEK for one batch — not per calendar week, and not for the
 * farm as a whole. Age is what every breed guide is published against, so a
 * report keyed on anything else compares an 18-week bird with a 60-week one and
 * calls the difference performance.
 *
 * The standard sits under each actual rather than in its own column: the
 * question a manager asks is "is this number good", and printing the answer
 * next to the number is the shortest path to it. Green is at-or-better, red is
 * worse, with no tolerance band — a band is a second opinion nobody agreed on.
 *
 * Rearing weeks are shown with the egg columns blank rather than dropped. The
 * pullet weeks decide the lay curve; a report starting at week 18 hides the
 * cause of what it is reporting.
 *
 * This is the only place the cost per egg appears. It is behind `reports.view`,
 * which the people entering daily records do not have — see the Farms module,
 * where the same figures show without a rupee anywhere.
 */

interface Week {
  week: number;
  hasData: boolean;
  phase: "rear" | "lay";
  henDayPct: string | null;
  stdHenDayPct: string | null;
  cumHenDayEggs: string | null;
  cumMortPct: string | null;
  stdCumMortPct: string | null;
  cumHenHousedEggs: string | null;
  cumFeedKgPerBird: string | null;
  feedGPerBirdDay: string | null;
  stdFeedGPerBirdDay: string | null;
  feedPerEggWeekG: string | null;
  waterMlPerBirdDay: string | null;
  bodyWeightKg: string | null;
  stdBodyWeightKg: string | null;
  eggWeightG: string | null;
  stdEggWeightG: string | null;
  feedPerEggCumG: string | null;
  cumCostPerEgg: string | null;
  costIncomplete: boolean;
}

interface Batch {
  id: string;
  code: string;
  status: string;
  hatchDate: string;
  placedCount: number;
  breed: string;
  location: string;
  houses: string | null;
}

/** Which way is good. Mortality and feed conversion are better when lower. */
type Direction = "high" | "low";

interface Col {
  key: keyof Week;
  std?: keyof Week;
  label: string;
  unit?: string;
  /** Blank during rearing — a pullet lays no eggs, and 0% is not the same as none. */
  layOnly?: boolean;
  dp: number;
  good?: Direction;
  /** Only on the report, never in the Farms module. */
  money?: boolean;
}

const COLS: Col[] = [
  { key: "bodyWeightKg", std: "stdBodyWeightKg", label: "Body wt", unit: "kg", dp: 3, good: "high" },
  { key: "cumMortPct", std: "stdCumMortPct", label: "Cum mort", unit: "%", dp: 2, good: "low" },
  { key: "henDayPct", std: "stdHenDayPct", label: "Hen-day", unit: "%", dp: 1, layOnly: true, good: "high" },
  { key: "cumHenDayEggs", label: "Cum eggs/hen", dp: 1, layOnly: true, good: "high" },
  { key: "cumHenHousedEggs", label: "Eggs/hen housed", dp: 1, layOnly: true, good: "high" },
  { key: "eggWeightG", std: "stdEggWeightG", label: "Egg wt", unit: "g", dp: 1, layOnly: true, good: "high" },
  {
    key: "feedGPerBirdDay",
    std: "stdFeedGPerBirdDay",
    label: "Feed",
    unit: "g/b/d",
    dp: 0,
  },
  { key: "cumFeedKgPerBird", label: "Cum feed/bird", unit: "kg", dp: 2 },
  { key: "feedPerEggWeekG", label: "Feed/egg", unit: "g", dp: 0, layOnly: true, good: "low" },
  { key: "feedPerEggCumG", label: "Cum feed/egg", unit: "g", dp: 0, layOnly: true, good: "low" },
  { key: "waterMlPerBirdDay", label: "Water", unit: "mL/b/d", dp: 0 },
  { key: "cumCostPerEgg", label: "Cum cost/egg", unit: "₹", dp: 2, layOnly: true, good: "low", money: true },
];

const fmt = (v: string | null, dp: number) =>
  v == null ? "" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** At-or-better is green, worse is red. No band: a band is an opinion. */
function tone(actual: string | null, std: string | null, good?: Direction) {
  if (actual == null || std == null || !good) return "";
  const a = Number(actual);
  const s = Number(std);
  const better = good === "high" ? a >= s : a <= s;
  return better ? "text-emerald-700" : "text-red-600";
}

const dmy = (iso: string) => iso.split("-").reverse().join("/");

export function WeeklySummaryPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const flockId = params.get("flockId") ?? "";

  const { data: picker } = useQuery({
    queryKey: ["farm-batches"],
    queryFn: () => api<{ batches: Batch[] }>("/api/reports/farm-batches"),
  });
  const batches = picker?.batches ?? [];

  // The newest batch is what somebody opening this report almost always wants,
  // so it opens on one rather than on an empty page asking a question.
  useEffect(() => {
    if (!flockId && batches.length) navigate(`/reports/weekly-management-summary?flockId=${batches[0]!.id}`, { replace: true });
  }, [flockId, batches, navigate]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["weekly-summary", flockId],
    queryFn: () =>
      api<{ flock: Batch & { housedOn: string | null; layStartDate: string | null; depletedOn: string | null }; weeks: Week[] }>(
        `/api/reports/weekly-management-summary?flockId=${flockId}`,
      ),
    enabled: !!flockId,
  });

  const weeks = data?.weeks ?? [];
  const flock = data?.flock;
  const [hideEmpty, setHideEmpty] = useState(false);
  const shown = useMemo(() => (hideEmpty ? weeks.filter((w) => w.hasData) : weeks), [weeks, hideEmpty]);
  const incomplete = weeks.some((w) => w.costIncomplete);

  const csv = () => {
    const head = ["Week", "Phase", ...COLS.flatMap((c) => [c.label + (c.unit ? ` (${c.unit})` : ""), c.std ? `${c.label} std` : null].filter(Boolean) as string[])];
    const lines = [head.join(",")];
    for (const w of weeks) {
      const cells: string[] = [String(w.week), w.phase === "lay" ? "Laying" : "Rearing"];
      for (const c of COLS) {
        const blank = c.layOnly && w.phase === "rear";
        cells.push(blank ? "" : ((w[c.key] as string | null) ?? ""));
        if (c.std) cells.push(blank ? "" : ((w[c.std] as string | null) ?? ""));
      }
      lines.push(cells.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${flock?.code ?? "batch"}-weekly-summary.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex h-full flex-col bg-[#f4f4f9]">
      <header className="bg-white px-6 py-2.5">
        <div className="text-[12px] font-medium text-[#4c526c]">Farms</div>
        <div className="flex items-baseline gap-2">
          <h1 className="text-[18px] font-semibold text-[#212529]">Weekly Management Summary</h1>
          {flock && (
            <>
              <span className="text-gray-300">•</span>
              <span className="text-[13px] text-gray-600">
                {flock.code} · {flock.breed} · hatched {dmy(flock.hatchDate)}
              </span>
            </>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-t bg-white px-6 py-2.5">
        <span className="mr-1 text-[13px] text-gray-500">Filters :</span>
        <label className="flex h-8 items-center gap-2 rounded-md border px-3 text-[13px]">
          <span className="text-gray-500">Batch :</span>
          <select
            value={flockId}
            onChange={(e) => navigate(`/reports/weekly-management-summary?flockId=${e.target.value}`)}
            className="max-w-[22rem] bg-transparent outline-none"
          >
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.houses ?? "no house"} · {b.placedCount.toLocaleString("en-IN")} birds
              </option>
            ))}
          </select>
        </label>

        <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-[13px] text-gray-700">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
          Only weeks with records
        </label>

        <button onClick={csv} className="btn-secondary" disabled={!weeks.length}>
          Download CSV
        </button>
        <Link href="/reports" className="ml-auto text-[13px] text-[#1c5bd9] hover:underline">
          All reports
        </Link>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="min-h-full bg-white px-6 py-6">
          {flock && (
            <div className="mb-5 flex flex-wrap gap-x-8 gap-y-1 text-[13px] text-gray-600">
              <span>
                Placed <b className="text-gray-900">{flock.placedCount.toLocaleString("en-IN")}</b>
              </span>
              <span>
                Site <b className="text-gray-900">{flock.location}</b>
              </span>
              <span>
                Houses <b className="text-gray-900">{flock.houses ?? "—"}</b>
              </span>
              <span>
                Housed <b className="text-gray-900">{flock.housedOn ? dmy(flock.housedOn) : "—"}</b>
              </span>
              <span>
                In lay <b className="text-gray-900">{flock.layStartDate ? dmy(flock.layStartDate) : "—"}</b>
              </span>
            </div>
          )}

          {isLoading ? (
            <p className="py-10 text-center text-[13px] text-gray-500">Loading…</p>
          ) : error ? (
            <p className="py-10 text-center text-[13px] text-red-600">
              {error instanceof Error ? error.message : "Failed to run this report."}
            </p>
          ) : !weeks.length ? (
            <p className="py-10 text-center text-[13px] text-gray-500">
              Nothing recorded for this batch yet.
            </p>
          ) : (
            <>
              {/* Wide by nature — the week column and the header both stay put,
                  because a figure in the middle of a 60-week batch is unreadable
                  once you cannot see which week or which column it is in. */}
              <div className="table-surface relative max-h-[70vh] overflow-auto">
                <table className="min-w-full border-separate border-spacing-0 text-[12px]">
                  <thead className="table-head">
                    <tr>
                      <th className="table-th sticky left-0 top-0 z-30">Week</th>
                      {COLS.map((c) => (
                        <th key={String(c.key)} className="table-th sticky top-0 z-20 text-right">
                          {c.label}
                          {c.unit && <span className="ml-1 font-normal text-gray-400">{c.unit}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((w) => {
                      const quiet = !w.hasData;
                      return (
                        <tr key={w.week} className={`table-row ${quiet ? "text-gray-300" : ""}`}>
                          <td
                            className={`table-td sticky left-0 z-10 whitespace-nowrap bg-white ${
                              quiet ? "text-gray-300" : "text-gray-900"
                            }`}
                          >
                            {w.week}
                            <span
                              className={`ml-2 text-[10px] uppercase ${
                                w.phase === "lay" ? "text-brand-600" : "text-gray-400"
                              }`}
                            >
                              {w.phase === "lay" ? "lay" : "rear"}
                            </span>
                          </td>
                          {COLS.map((c) => {
                            // A pullet lays no eggs. Blank, not zero — zero is a
                            // measurement and this is the absence of one.
                            if (c.layOnly && w.phase === "rear") {
                              return <td key={String(c.key)} className="table-td bg-gray-50/40" />;
                            }
                            // A week nobody recorded has no actuals, only a
                            // guide. Printing a cumulative 0.00 there reads as
                            // "no birds died", when what happened is that
                            // nobody wrote anything down.
                            const actual = quiet ? null : (w[c.key] as string | null);
                            const std = c.std ? (w[c.std] as string | null) : null;
                            return (
                              <td key={String(c.key)} className="table-td text-right tabular-nums">
                                <div className={quiet ? "" : tone(actual, std, c.good)}>
                                  {fmt(actual, c.dp) || <span className="text-gray-300">—</span>}
                                  {c.money && w.costIncomplete && actual != null && (
                                    <span title="Some feed had no cost on it" className="ml-0.5 text-amber-600">
                                      *
                                    </span>
                                  )}
                                </div>
                                {std != null && (
                                  <div className="text-[10px] text-gray-400">{fmt(std, c.dp)}</div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-gray-500">
                <span>
                  <span className="text-emerald-700">Green</span> at or better than the guide ·{" "}
                  <span className="text-red-600">red</span> below it. The small figure is the guide.
                </span>
                <span>Weeks with no records are dimmed.</span>
                {incomplete && (
                  <span className="text-amber-600">
                    * some feed was delivered without a cost, so the cost per egg is understated.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
