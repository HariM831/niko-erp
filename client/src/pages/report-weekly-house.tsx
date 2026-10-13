import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { SearchSelect } from "../components/search-select";

/**
 * Weekly House Report.
 *
 * One layer house, one Monday-to-Sunday week, on one page: the days, the lay
 * and feed-per-egg curves since first egg, the feed in use against its
 * standard, and Dr niko. The page IS the PDF — it is made to be printed and
 * handed over, so the screen shows the sheet itself rather than a second
 * rendering of the same figures that could drift from it.
 *
 * The house's own page opens the same sheet for last week; here any week can
 * be asked for, and the feed's cost per kg is on it.
 */

interface House {
  id: string;
  code: string;
  name: string | null;
}

const dmy = (iso: string) => iso.split("-").reverse().join("/");

/** The Monday of the week holding `day`, and its Sunday — worked in UTC on the bare date. */
function weekOf(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const from = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 6);
  return { from, to: d.toISOString().slice(0, 10) };
}

export function WeeklyHousePage() {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const houseId = params.get("houseId") ?? "";
  const week = params.get("week") ?? "";

  const { data: picker } = useQuery({
    queryKey: ["weekly-house-report-houses"],
    queryFn: () => api<{ houses: House[]; lastWeek: { from: string; to: string } }>("/api/reports/weekly-house-report/houses"),
  });
  const houses = picker?.houses ?? [];

  const go = (h: string, w: string, replace = false) =>
    navigate(`/reports/weekly-house-report?houseId=${h}&week=${w}`, { replace });

  // Opens on the first house and the last full week, rather than on an empty
  // page asking two questions.
  useEffect(() => {
    if (picker && houses.length && (!houseId || !week)) go(houseId || houses[0]!.id, week || picker.lastWeek.from, true);
  }, [picker, houseId, week]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = houseId && week ? `/api/reports/weekly-house-report/${houseId}/report.pdf?week=${week}` : "";

  // Fetched rather than pointed at by the frame, so a house with no laying
  // flock that week says so in words instead of showing raw JSON in a PDF box.
  const [pdf, setPdf] = useState<{ url: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!src) return;
    let dead = false;
    let made: string | null = null;
    setLoading(true);
    setError(null);
    fetch(src, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not make the report (${r.status})`);
        const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? "weekly-report.pdf";
        return { blob: await r.blob(), name };
      })
      .then(({ blob, name }) => {
        if (dead) return;
        made = URL.createObjectURL(blob);
        setPdf({ url: made, name });
      })
      .catch((e: Error) => {
        if (dead) return;
        setPdf(null);
        setError(e.message);
      })
      .finally(() => !dead && setLoading(false));
    return () => {
      dead = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);

  const house = houses.find((h) => h.id === houseId);
  const span = week ? weekOf(week) : null;

  return (
    <div className="flex h-full flex-col bg-[#f4f4f9]">
      <header className="page-header px-3 py-2.5 sm:px-6">
        <div className="text-[12px] font-medium text-[#4c526c]">Farms</div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className="text-[18px] font-semibold text-[#212529]">Weekly House Report</h1>
          {house && span && (
            <>
              <span className="hidden text-gray-300 sm:inline">•</span>
              <span className="text-[13px] text-gray-600">
                {house.name || house.code} · {dmy(span.from)} to {dmy(span.to)}
              </span>
            </>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-t bg-white px-3 py-2.5 sm:px-6">
        <span className="mr-1 text-[13px] text-gray-500">Filters :</span>
        {/* A div, not a label: a label would forward clicks inside the open
            list back to the picker's button and snap it shut again. */}
        <div className="flex h-8 items-center gap-2 rounded-md border px-3 text-[13px]">
          <span className="text-gray-500">House :</span>
          <SearchSelect
            value={houseId || null}
            onChange={(id) => id && go(id, week)}
            options={houses.map((h) => ({ id: h.id, label: h.name || h.code }))}
            allowClear={false}
            keepOrder
            className="w-32"
            buttonClassName="bg-transparent py-0 outline-none"
          />
        </div>

        <label className="flex h-8 items-center gap-2 rounded-md border px-3 text-[13px]">
          <span className="text-gray-500">Week of :</span>
          {/* Any day picks its week; the report always runs Monday to Sunday. */}
          <input
            type="date"
            value={week}
            onChange={(e) => e.target.value && houseId && go(houseId, weekOf(e.target.value).from)}
            className="bg-transparent outline-none"
          />
        </label>

        {pdf && (
          <a href={pdf.url} download={pdf.name} className="btn-secondary">
            Download PDF
          </a>
        )}
        <Link href="/reports" className="ml-auto text-[13px] text-[#e06d05] hover:underline">
          All reports
        </Link>
      </div>

      <div className="min-h-0 flex-1 p-2 sm:p-4">
        {error ? (
          <div className="bg-white px-6 py-10 text-center text-[13px] text-gray-600">{error}</div>
        ) : !houses.length && picker ? (
          <div className="bg-white px-6 py-10 text-center text-[13px] text-gray-600">There is no layer house to report on.</div>
        ) : pdf ? (
          <iframe title="Weekly House Report" src={pdf.url} className={`h-full w-full border-0 bg-white ${loading ? "opacity-50" : ""}`} />
        ) : (
          <div className="bg-white px-6 py-10 text-center text-[13px] text-gray-500">Making the report…</div>
        )}
      </div>
    </div>
  );
}
