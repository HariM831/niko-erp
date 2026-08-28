/**
 * Office — the six stations a truck passes through.
 *
 * Stations 1–5 are used one-handed at a boom barrier and in a weighbridge
 * cabin, so they stay single-column and stack on a phone. They use the same
 * tokens and components as the rest of niko: no second design system.
 *
 * P0 ships the shells. The receipt record, the queues and settlement land in
 * P2 onwards — see docs/office-plan.md.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { effectiveActions, isAdminMap } from "@shared/permissions";

export interface StationDef {
  key: string;
  title: string;
  /** What the operator is looking at when they open this. */
  subtitle: string;
  /** The office action a role needs to work here. */
  action: string;
  /** The one decision made here, or none. */
  decision: string;
}

export const STATIONS: StationDef[] = [
  {
    key: "gate",
    title: "Gate In",
    subtitle: "Scan the vendor's bill and decide whether the truck comes in",
    action: "gate_in",
    decision: "Allow in, or turn away",
  },
  {
    key: "weighbridge",
    title: "Weigh In",
    subtitle: "Waiting to be weighed in",
    action: "weighbridge",
    decision: "None — weighing records a fact, it does not judge quality",
  },
  {
    key: "qc",
    title: "Quality Control",
    subtitle: "Weighed, awaiting NIR",
    action: "quality_control",
    decision: "Accept or reject, per material",
  },
  {
    key: "unloading",
    title: "Unloading",
    subtitle: "Cleared by QC",
    action: "unloading",
    decision: "Bay, bags and damage, per material",
  },
  {
    key: "weigh-out",
    title: "Weigh Out",
    subtitle: "Unloaded, awaiting weigh-out",
    action: "weighbridge",
    decision: "None — net weight is gross minus tare",
  },
  {
    key: "settlement",
    title: "Settlement",
    subtitle: "Gated out, unpaid",
    action: "settle",
    decision: "What the vendor is paid",
  },
];

interface SeriesPreview {
  entity: string;
  prefix: string;
  nextNumber: number;
  padding: number;
  seriesName: string;
}

function NumberingCard() {
  const { data } = useQuery<SeriesPreview[]>({
    queryKey: ["office", "numbering"],
    queryFn: () => api("/api/office/numbering"),
  });
  if (!data?.length) return null;
  return (
    <div className="card p-4">
      <div className="label">Next receipt number</div>
      <div className="mt-1 flex flex-wrap gap-x-6 gap-y-2">
        {data.map((s) => (
          <div key={s.seriesName}>
            <div className="font-mono text-[15px] text-gray-900">
              {s.prefix}
              {String(s.nextNumber).padStart(s.padding, "0")}
            </div>
            <div className="text-[11px] text-gray-400">{s.seriesName}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OfficeStationPage({ stationKey }: { stationKey: string }) {
  const { user } = useAuth();
  const station = STATIONS.find((s) => s.key === stationKey);
  const permissions = (user?.permissions ?? {}) as Record<string, string[]>;
  const held = effectiveActions(permissions, "office");
  const admin = isAdminMap(permissions);
  const allowed = admin || (station ? held.includes(station.action) : false);

  if (!station) return <div className="p-8 text-sm text-gray-500">Unknown station.</div>;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <div className="page-header -mx-4 mb-4 flex items-baseline justify-between gap-4 px-4 py-3 sm:-mx-6 sm:px-6">
        <h1 className="text-[19px] font-semibold text-gray-900">{station.title}</h1>
        <span
          className={`text-[11px] font-semibold uppercase tracking-wide ${
            allowed ? "text-green-600" : "text-red-600"
          }`}
        >
          {allowed ? "permitted" : "no access"}
        </span>
      </div>
      <p className="mb-5 text-[13px] text-gray-500">{station.subtitle}</p>

      <div className="card mb-4 p-4">
        <div className="label">Decision made here</div>
        <div className="text-[13px] text-gray-900">{station.decision}</div>
        <div className="label mt-3">Permission</div>
        <code className="text-[12px] text-gray-600">office.{station.action}</code>
      </div>

      {station.key === "gate" && <NumberingCard />}

      <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-white/60 p-4">
        <p className="text-[13px] text-gray-600">
          Station shell. The queue and the capture form land with the receipt record.
        </p>
      </div>
    </div>
  );
}
