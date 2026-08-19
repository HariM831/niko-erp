/**
 * Flock detail — the record of one cohort, across every house it has lived in.
 *
 * This is the screen the rebuild exists for. The old model gave the bird count
 * to the shed, so a flock that moved from a pullet house to a layer house
 * became two unrelated records and its lifetime figures restarted at the move.
 * Here the placement timeline spans the whole life and the movement ledger
 * carries across it, so cumulative mortality is continuous through a transfer.
 *
 * Every number on this page is derived from the movement ledger below it.
 * Nothing is a stored total, so nothing can disagree with the ledger.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { ApiError, api } from "../api";
import {
  FLOCK_ORIGIN_LABELS,
  FLOCK_STATUS_LABELS,
  MOVEMENT_KIND_LABELS,
  type FlockOrigin,
  type FlockStatus,
  type MovementKind,
} from "@shared/schema/flocks";

const today = () => new Date().toISOString().slice(0, 10);
const n = (v: number) => v.toLocaleString("en-IN");
const day = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

interface Flock {
  id: string;
  code: string;
  status: FlockStatus;
  hatchDate: string;
  origin: FlockOrigin;
  originRef: string | null;
  placedCount: number;
  layStartDate: string | null;
  depletedOn: string | null;
  note: string | null;
  breedName: string;
  locationName: string;
  standardSetName: string;
  standardSetVersion: number;
  birds: number;
  cumMortalityPct: number;
  age: { label: string; days: number };
  placements: Array<{
    id: string;
    houseId: string;
    houseCode: string;
    fromDate: string;
    toDate: string | null;
    birds: number;
    note: string | null;
  }>;
  movements: Array<{
    id: string;
    houseCode: string;
    eventDate: string;
    kind: MovementKind;
    qty: number;
    adjustmentSign: number | null;
    causeLabel: string | null;
    note: string | null;
  }>;
}

type Dialog = "transfer" | "record" | "lay" | "deplete" | null;

export function FlockDetailPage() {
  const [, params] = useRoute("/farms/flocks/:id");
  const id = params?.id;
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);

  const { data: f, isLoading } = useQuery<Flock>({
    queryKey: ["flock", id],
    queryFn: () => api(`/api/farms/flocks/${id}`),
    enabled: !!id,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["flock", id] });
    void qc.invalidateQueries({ queryKey: ["farms-board"] });
    setDialog(null);
  };

  if (isLoading) return <p className="p-6 text-[13px] text-gray-500">Loading…</p>;
  if (!f) return <p className="p-6 text-[13px] text-gray-500">Flock not found.</p>;

  const open = f.placements.filter((p) => !p.toDate);
  const live = f.status !== "depleted";

  return (
    <div className="p-6">
      <Link href="/farms">
        <a className="mb-3 inline-flex items-center gap-1 text-[12px] text-gray-500 hover:text-gray-800">
          <ArrowLeft size={13} /> Farms
        </a>
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-gray-900">{f.code}</h1>
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                f.status === "laying"
                  ? "bg-green-100 text-green-800"
                  : f.status === "rearing"
                    ? "bg-blue-100 text-blue-800"
                    : "bg-gray-100 text-gray-600"
              }`}
            >
              {FLOCK_STATUS_LABELS[f.status]}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-gray-600">
            {f.breedName} · hatched {day(f.hatchDate)} · {f.age.label} ·{" "}
            {FLOCK_ORIGIN_LABELS[f.origin]}
            {f.originRef && <span className="text-gray-400"> ({f.originRef})</span>}
          </p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {f.locationName} · measured against {f.standardSetName} v{f.standardSetVersion}
          </p>
        </div>
        {live && (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setDialog("record")} className="btn-secondary">
              Record mortality
            </button>
            <button
              onClick={() => setDialog("transfer")}
              disabled={!open.length}
              className="btn-secondary"
            >
              Transfer
            </button>
            {f.status === "rearing" && (
              <button onClick={() => setDialog("lay")} className="btn-secondary">
                Start lay
              </button>
            )}
            <button onClick={() => setDialog("deplete")} className="btn-ghost text-red-600">
              Deplete
            </button>
          </div>
        )}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Birds now" value={n(f.birds)} />
        <Tile label="Placed" value={n(f.placedCount)} />
        <Tile
          label="Cumulative mortality"
          value={`${f.cumMortalityPct.toFixed(2)}%`}
          tone={f.cumMortalityPct > 5 ? "warn" : undefined}
        />
        <Tile
          label="Liveability"
          value={`${f.placedCount ? ((f.birds / f.placedCount) * 100).toFixed(1) : "0.0"}%`}
        />
      </div>

      {/* The timeline. Every house this cohort has stood in, in order — the
          view that has never existed, and the reason placements are a table. */}
      <h2 className="mt-6 mb-2 text-[13px] font-semibold text-gray-700">Where it has lived</h2>
      <div className="card divide-y divide-gray-100">
        {f.placements.map((p) => (
          <div key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5">
            <div>
              <span className="text-[14px] font-medium text-gray-900">{p.houseCode}</span>
              <span className="ml-2 text-[12px] text-gray-500">
                {day(p.fromDate)} → {p.toDate ? day(p.toDate) : "now"}
              </span>
              {p.note && <span className="ml-2 text-[12px] text-gray-400">{p.note}</span>}
            </div>
            <div className="text-[13px] tabular-nums text-gray-700">
              {p.toDate ? (
                <span className="text-gray-400">closed</span>
              ) : (
                <>
                  {n(p.birds)} <span className="text-[11px] text-gray-500">birds</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <h2 className="mt-6 mb-2 text-[13px] font-semibold text-gray-700">
        Movements
        <span className="ml-2 font-normal text-gray-400">
          every bird in or out — the count above is summed from this
        </span>
      </h2>
      <div className="card overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">House</th>
              <th className="px-3 py-2">Event</th>
              <th className="px-3 py-2 text-right">Birds</th>
              <th className="px-3 py-2">Cause</th>
              <th className="px-3 py-2">Note</th>
            </tr>
          </thead>
          <tbody>
            {!f.movements.length && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                  No movements yet.
                </td>
              </tr>
            )}
            {f.movements.map((m) => {
              const inward = m.kind === "place" || m.kind === "transfer_in";
              const signed =
                m.kind === "adjustment" ? m.qty * (m.adjustmentSign ?? 1) : inward ? m.qty : -m.qty;
              return (
                <tr key={m.id} className="border-b border-gray-100">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{day(m.eventDate)}</td>
                  <td className="px-3 py-2 font-medium text-gray-900">{m.houseCode}</td>
                  <td className="px-3 py-2 text-gray-700">{MOVEMENT_KIND_LABELS[m.kind]}</td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      signed >= 0 ? "text-green-700" : "text-red-700"
                    }`}
                  >
                    {signed > 0 ? "+" : ""}
                    {n(signed)}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{m.causeLabel ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-500">{m.note ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialog && (
        <FlockDialog kind={dialog} flock={f} onClose={() => setDialog(null)} onSaved={refresh} />
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div
        className={`mt-1 text-[20px] font-semibold tabular-nums ${
          tone === "warn" ? "text-amber-700" : "text-gray-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function FlockDialog({
  kind,
  flock,
  onClose,
  onSaved,
}: {
  kind: Exclude<Dialog, null>;
  flock: Flock;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const open = flock.placements.filter((p) => !p.toDate);
  const [f, setF] = useState({
    placementId: open[0]?.id ?? "",
    toHouseId: "",
    qty: "",
    on: today(),
    movementKind: "mortality" as "mortality" | "cull" | "male_removal" | "adjustment",
    causeCode: "",
    adjustmentSign: -1 as 1 | -1,
    note: "",
  });

  const { data: ctx } = useQuery<{
    houses: Array<{ id: string; code: string; purpose: string; locationId: string }>;
    causes: Array<{ code: string; label: string }>;
  }>({
    queryKey: ["farm-flock-context"],
    queryFn: () => api("/api/farms/flock-context"),
  });

  const needsCause = kind === "record" && (f.movementKind === "mortality" || f.movementKind === "cull");
  const occupied = new Set(open.map((p) => p.houseId));

  const save = useMutation({
    mutationFn: () => {
      if (kind === "transfer") {
        return api(`/api/farms/flocks/${flock.id}/transfer`, {
          method: "POST",
          body: {
            placementId: f.placementId,
            toHouseId: f.toHouseId,
            qty: Number(f.qty),
            eventDate: f.on,
            note: f.note.trim() || null,
          },
        });
      }
      if (kind === "record") {
        return api(`/api/farms/flocks/${flock.id}/movements`, {
          method: "POST",
          body: {
            placementId: f.placementId,
            kind: f.movementKind,
            qty: Number(f.qty),
            eventDate: f.on,
            causeCode: needsCause ? f.causeCode : null,
            adjustmentSign: f.movementKind === "adjustment" ? f.adjustmentSign : null,
            note: f.note.trim() || null,
          },
        });
      }
      const path = kind === "lay" ? "start-lay" : "deplete";
      return api(`/api/farms/flocks/${flock.id}/${path}`, {
        method: "POST",
        body: { on: f.on },
      });
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save that"),
  });

  const title = {
    transfer: "Transfer birds",
    record: "Record mortality, cull or adjustment",
    lay: "Start lay",
    deplete: "Deplete flock",
  }[kind];

  const ready =
    kind === "lay" || kind === "deplete"
      ? !!f.on
      : !!f.placementId &&
        Number(f.qty) > 0 &&
        (kind !== "transfer" || !!f.toHouseId) &&
        (!needsCause || !!f.causeCode);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-6">
      <div className="card w-full max-w-lg p-5">
        <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-3">
          {(kind === "transfer" || kind === "record") && (
            <div>
              <label className="label-required">From house *</label>
              <select
                value={f.placementId}
                onChange={(e) => setF((v) => ({ ...v, placementId: e.target.value }))}
                className="input"
              >
                {open.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.houseCode} — {n(p.birds)} birds
                  </option>
                ))}
              </select>
            </div>
          )}

          {kind === "transfer" && (
            <div>
              <label className="label-required">To house *</label>
              <select
                value={f.toHouseId}
                onChange={(e) => setF((v) => ({ ...v, toHouseId: e.target.value }))}
                className="input"
              >
                <option value="">Choose…</option>
                {ctx?.houses
                  .filter((h) => !occupied.has(h.id))
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.code}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {kind === "record" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label-required">Event *</label>
                <select
                  value={f.movementKind}
                  onChange={(e) =>
                    setF((v) => ({ ...v, movementKind: e.target.value as typeof v.movementKind }))
                  }
                  className="input"
                >
                  <option value="mortality">Mortality</option>
                  <option value="cull">Cull</option>
                  <option value="male_removal">Male removal</option>
                  <option value="adjustment">Adjustment</option>
                </select>
              </div>
              {needsCause ? (
                <div>
                  <label className="label-required">Cause *</label>
                  <select
                    value={f.causeCode}
                    onChange={(e) => setF((v) => ({ ...v, causeCode: e.target.value }))}
                    className="input"
                  >
                    <option value="">Choose…</option>
                    {ctx?.causes.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : f.movementKind === "adjustment" ? (
                <div>
                  <label className="label-required">Direction *</label>
                  <select
                    value={String(f.adjustmentSign)}
                    onChange={(e) =>
                      setF((v) => ({ ...v, adjustmentSign: Number(e.target.value) as 1 | -1 }))
                    }
                    className="input"
                  >
                    <option value="-1">Remove birds</option>
                    <option value="1">Add birds</option>
                  </select>
                </div>
              ) : (
                <div />
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {kind !== "lay" && kind !== "deplete" && (
              <div>
                <label className="label-required">Birds *</label>
                <input
                  value={f.qty}
                  onChange={(e) => setF((v) => ({ ...v, qty: e.target.value }))}
                  inputMode="numeric"
                  className="input text-right"
                />
              </div>
            )}
            <div>
              <label className="label-required">Date *</label>
              <input
                type="date"
                value={f.on}
                onChange={(e) => setF((v) => ({ ...v, on: e.target.value }))}
                className="input"
              />
            </div>
          </div>

          {kind !== "lay" && (
            <div>
              <label className="label">Note</label>
              <input
                value={f.note}
                onChange={(e) => setF((v) => ({ ...v, note: e.target.value }))}
                className="input"
              />
            </div>
          )}

          {kind === "deplete" && (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              Every open house is emptied by an explicit depletion movement and then closed, so the
              count reaches zero through the ledger. {n(flock.birds)} bird(s) will be depleted.
            </p>
          )}
          {kind === "lay" && (
            <p className="text-[12px] text-gray-500">
              Recorded on the flock, not inferred from the house it sits in — a flock housed into a
              layer shed at 16 weeks is not laying the day it arrives.
            </p>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => save.mutate()}
            disabled={!ready || save.isPending}
            className={kind === "deplete" ? "btn-primary bg-red-600 hover:bg-red-700" : "btn-primary"}
          >
            {save.isPending ? "Saving…" : title}
          </button>
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
