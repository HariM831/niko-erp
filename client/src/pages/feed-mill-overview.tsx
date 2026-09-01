/**
 * The feed mill at a glance — the launch page for everyone who works in it.
 *
 * A weighbridge operator and a mill manager share no single permission, so the
 * page is reachable by anyone who does one of the mill's jobs and each tile is
 * shown only to whoever could open the page it links to. A count of trucks
 * waiting to be settled is itself information; the server withholds the number
 * rather than sending it for the screen to hide.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api } from "../api";
import { useAuth } from "../auth";

interface Overview {
  day: string;
  atGate?: number;
  awaitingQc?: number;
  awaitingWeighment?: number;
  awaitingSettlement?: number;
  receiptsToday?: number;
  productionToday?: { runs: number; batches: number };
  feedSentTodayKg?: number;
}

/** A number worth acting on, and where to go and act on it. */
function Tile({
  label,
  value,
  sub,
  href,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href: string;
  tone?: "waiting" | "quiet";
}) {
  return (
    <Link href={href}>
      <div className="cursor-pointer rounded-xl bg-white px-4 py-3 shadow-sm transition hover:shadow-md">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
        <div
          className={`text-[22px] font-semibold tabular-nums ${
            tone === "waiting" && Number(value) > 0 ? "text-yolk-600" : "text-soil-900"
          }`}
        >
          {value}
        </div>
        {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
      </div>
    </Link>
  );
}

export function FeedMillOverviewPage() {
  const { can } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["feed-mill", "overview"],
    queryFn: () => api<Overview>("/api/office/overview"),
    refetchInterval: 60_000,
  });

  const kg = (v: number) =>
    v >= 1000 ? `${(v / 1000).toFixed(1)} t` : `${Math.round(v)} kg`;

  return (
    <div className="p-4 md:p-6">
      <div className="page-header -mx-4 mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:-mx-6 md:px-6">
        <h1 className="text-xl font-semibold sm:text-2xl">Feed Mill</h1>
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {data?.atGate != null && (
              <Tile label="At the gate" value={data.atGate} sub="waiting to come in" href="/office/gate" tone="waiting" />
            )}
            {data?.awaitingQc != null && (
              <Tile label="Awaiting QC" value={data.awaitingQc} sub="weighed, not sampled" href="/office/unloading/qc" tone="waiting" />
            )}
            {data?.awaitingWeighment != null && (
              <Tile label="On the platform" value={data.awaitingWeighment} sub="unloading or weighing out" href="/office/unloading" tone="waiting" />
            )}
            {data?.awaitingSettlement != null && (
              <Tile label="To settle" value={data.awaitingSettlement} sub="gate out, not billed" href="/office/settlement" tone="waiting" />
            )}
            {data?.receiptsToday != null && (
              <Tile label="Receipts today" value={data.receiptsToday} href="/office/receipts" />
            )}
            {data?.productionToday && (
              <Tile
                label="Made today"
                value={data.productionToday.batches}
                sub={`${data.productionToday.runs} run${data.productionToday.runs === 1 ? "" : "s"}`}
                href="/feed-mill/production"
              />
            )}
            {data?.feedSentTodayKg != null && (
              <Tile label="Sent to sheds" value={kg(data.feedSentTodayKg)} sub="today" href="/feed-mill/production" />
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
