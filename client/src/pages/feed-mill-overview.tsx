/**
 * The feed mill at a glance — the launch page for everyone who works in it.
 *
 * A board of the yard rather than a row of counters: four spots a truck can be
 * standing at, each naming the vehicles standing there. "3 at the gate" tells
 * the yard nothing it cannot see out of the window; AS01AB1234 is what someone
 * walks out and deals with.
 *
 * A weighbridge operator and a mill manager share no single permission, so the
 * page is reachable by anyone who does one of the mill's jobs and each spot is
 * shown only to whoever could open the page it links to. The list of trucks
 * awaiting settlement is itself information, so the server withholds it rather
 * than sending it for the screen to hide.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api } from "../api";
import { useAuth } from "../auth";

interface Truck {
  id: string;
  number: string;
  vehicleNumber: string;
  vendorName: string | null;
  items: string | null;
  ageMinutes: number;
}
interface Overview {
  day: string;
  atGate?: Truck[];
  awaitingQc?: Truck[];
  onPlatform?: Truck[];
  toSettle?: Truck[];
  receiptsToday?: number;
  productionToday?: { runs: number; batches: number };
  feedSentTodayKg?: number;
}

/** Hours once minutes stop being readable. */
const waited = (m: number) => (m < 90 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`);

/**
 * One spot in the yard and the trucks standing at it.
 *
 * Empty is a real answer and gets said plainly — a blank column reads as
 * "not loaded yet", which is the one thing it must not.
 */
function Spot({
  label,
  hint,
  href,
  trucks,
}: {
  label: string;
  hint: string;
  href: string;
  trucks: Truck[];
}) {
  return (
    <div className="rounded-xl bg-white shadow-sm">
      <Link href={href}>
        <div className="cursor-pointer border-b border-yolk-200/60 bg-gradient-to-r from-yolk-100 via-yolk-50 to-transparent px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] font-semibold uppercase tracking-wide text-soil-700">{label}</span>
            <span className="text-[13px] font-semibold tabular-nums text-soil-800">{trucks.length}</span>
          </div>
          <div className="text-[11px] text-gray-500">{hint}</div>
        </div>
      </Link>
      {trucks.length === 0 ? (
        <div className="px-3 py-4 text-center text-[12px] text-gray-400">Nothing here</div>
      ) : (
        <div className="space-y-2 p-2">
          {trucks.map((t) => (
            <div
              key={t.id}
              className="rounded-lg border border-soil-100 bg-soil-50/60 px-2.5 py-2"
              data-testid="truck-box"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold tabular-nums text-soil-900">
                  {t.vehicleNumber || "no number"}
                </span>
                <span
                  className={`shrink-0 text-[11px] tabular-nums ${
                    t.ageMinutes >= 180 ? "font-semibold text-red-600" : "text-gray-400"
                  }`}
                  title="Waiting since arrival"
                >
                  {waited(t.ageMinutes)}
                </span>
              </div>
              {/* What is on it. Blank until the gate has entered the lines. */}
              <div className="truncate text-[12px] text-soil-700" title={t.items ?? ""}>
                {t.items || <span className="text-gray-400">no lines yet</span>}
              </div>
              <div className="truncate text-[11px] text-gray-500" title={t.vendorName ?? ""}>
                {t.vendorName ?? t.number}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FeedMillOverviewPage() {
  const { can } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["feed-mill", "overview"],
    queryFn: () => api<Overview>("/api/office/overview"),
    refetchInterval: 60_000,
  });

  const kg = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} t` : `${Math.round(v)} kg`);

  const spots = [
    { key: "atGate", label: "At the gate", hint: "waiting to come in", href: "/office/gate" },
    { key: "awaitingQc", label: "Awaiting QC", hint: "weighed, not sampled", href: "/office/unloading/qc" },
    { key: "onPlatform", label: "On the platform", hint: "unloading or weighing out", href: "/office/unloading" },
    { key: "toSettle", label: "To settle", hint: "gate out, not billed", href: "/office/settlement" },
  ] as const;

  const shown = spots.filter((s) => data?.[s.key] != null);

  return (
    <div className="p-4 md:p-6">
      <div className="page-header -mx-4 mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:-mx-6 md:px-6">
        <h1 className="text-xl font-semibold sm:text-2xl">Feed Mill</h1>
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          {shown.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {shown.map((s) => (
                <Spot key={s.key} label={s.label} hint={s.hint} href={s.href} trucks={data![s.key] ?? []} />
              ))}
            </div>
          )}

          {/* The day's totals, which are counts because nobody acts on them. */}
          <div className="mt-4 flex flex-wrap gap-2">
            {data?.receiptsToday != null && (
              <div className="rounded-lg bg-white px-4 py-2 shadow-sm">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Receipts today</div>
                <div className="text-[15px] font-semibold tabular-nums">{data.receiptsToday}</div>
              </div>
            )}
            {data?.productionToday && (
              <div className="rounded-lg bg-white px-4 py-2 shadow-sm">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Made today</div>
                <div className="text-[15px] font-semibold tabular-nums">
                  {data.productionToday.batches}
                  <span className="ml-1 text-[11px] font-normal text-gray-500">
                    in {data.productionToday.runs} run{data.productionToday.runs === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            )}
            {data?.feedSentTodayKg != null && (
              <div className="rounded-lg bg-white px-4 py-2 shadow-sm">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Sent to sheds</div>
                <div className="text-[15px] font-semibold tabular-nums">{kg(data.feedSentTodayKg)}</div>
              </div>
            )}
          </div>

          {/* The jobs themselves, for whoever holds them. */}
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: "Gate In", href: "/office/gate", show: can("office", "gate_in") },
              { label: "Weighment", href: "/office/unloading", show: can("office", "weighbridge") },
              { label: "Settlement", href: "/office/settlement", show: can("office", "settle") },
              { label: "Goods Receipts", href: "/office/receipts", show: can("office", "view") },
              { label: "Formulas", href: "/feed-mill/formulas", show: can("feed_mill", "view") },
              { label: "Production", href: "/feed-mill/production", show: can("feed_mill", "produce") },
            ]
              .filter((j) => j.show)
              .map((j) => (
                <Link key={j.href} href={j.href}>
                  <div className="cursor-pointer rounded-lg border border-yolk-200/70 bg-white px-3 py-2 text-center text-[13px] font-medium text-soil-800 transition hover:bg-yolk-50">
                    {j.label}
                  </div>
                </Link>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
