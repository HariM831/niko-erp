/**
 * Flock detail — one cohort, and the three things that happen to it.
 *
 * This is the setup page, not the daily one. What lives here happens a handful
 * of times in a batch's life: it arrives, it moves to the layer house, it is
 * culled out. Feed, water, eggs and mortality are entered every morning on
 * Daily Records instead — putting a once-a-lifetime field beside a once-a-day
 * one invites both to be got wrong.
 *
 * All three tabs are the SAME shape, because all three are the same thing: a
 * set of dated lines that nobody can complete on the first morning. Chicks
 * arrive over a week; the move to the layer house takes a week of lorries; the
 * cull-out takes several days. Each is edited by adding a line as the next
 * lorry turns up and saving the whole set back.
 *
 * Every number on the page is derived from the movement ledger at the bottom,
 * so nothing here can disagree with it.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { ApiError, api } from "../api";
import {
  FLOCK_STATUS_LABELS,
  MOVEMENT_KIND_LABELS,
  hatchProfile,
  type FlockStatus,
  type MovementKind,
} from "@shared/schema/flocks";
import { LineSet, type Column } from "../components/line-set";

const today = () => new Date().toISOString().slice(0, 10);
const n = (v: number) => v.toLocaleString("en-IN");
const day = (d: string | null) =>
  d
    ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

interface Flock {
  id: string;
  code: string;
  status: FlockStatus;
  hatchDate: string;
  placedCount: number;
  hatches: Array<{ id: string; hatchDate: string; qty: number }>;
  hatchSpread: { spreadDays: number; firstHatch: string; lastHatch: string } | null;
  housedOn: string | null;
  layStartDate: string | null;
  depletedOn: string | null;
  note: string | null;
  breedName: string;
  locationName: string;
  standardSetName: string | null;
  standardSetVersion: number | null;
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
    counterpartPlacementId: string | null;
  }>;
}

type Tab = "hatches" | "transfers" | "culling" | "movements";

export function FlockDetailPage() {
  const [, params] = useRoute("/farms/flocks/:id");
  const id = params?.id;
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("hatches");
  const [error, setError] = useState<string | null>(null);

  const { data: f, isLoading } = useQuery<Flock>({
    queryKey: ["flock", id],
    queryFn: () => api(`/api/farms/flocks/${id}`),
    enabled: !!id,
  });
  const { data: ctx } = useQuery<{
    houses: Array<{ id: string; code: string; purpose: string; locationId: string }>;
  }>({
    queryKey: ["farm-flock-context"],
    queryFn: () => api("/api/farms/flock-context"),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["flock", id] });
    void qc.invalidateQueries({ queryKey: ["farms-board"] });
    void qc.invalidateQueries({ queryKey: ["farms-daily"] });
    setError(null);
  };

  if (isLoading) return <p className="p-6 text-[13px] text-gray-500">Loading…</p>;
  if (!f) return <p className="p-6 text-[13px] text-gray-500">Flock not found.</p>;

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: "hatches", label: "Batches", count: f.hatches.length },
    {
      key: "transfers",
      label: "Transfer",
      count: f.movements.filter((m) => m.kind === "transfer_out").length,
    },
    {
      key: "culling",
      label: "Culling",
      count: f.movements.filter((m) => m.kind === "depletion").length,
    },
    { key: "movements", label: "Movements", count: f.movements.length },
  ];

  return (
    <div className="p-6">
      {/* wouter's Link IS the anchor — an <a> inside it nests <a> in <a>. */}
      <Link
        href="/farms"
        className="mb-3 inline-flex items-center gap-1 text-[12px] text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft size={13} /> Farms
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
            {f.breedName} · {f.age.label} · hatched {day(f.hatchDate)}
            {!!f.hatchSpread?.spreadDays && (
              <span className="text-gray-400">
                {" "}
                (weighted average of {f.hatches.length} hatches)
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {f.locationName} ·{" "}
            {f.standardSetName ? (
              <>
                measured against {f.standardSetName} v{f.standardSetVersion}
              </>
            ) : (
              <span className="text-amber-700">no standard set pinned</span>
            )}
            {f.housedOn && <> · housed {day(f.housedOn)}</>}
            {f.layStartDate && <> · in lay from {day(f.layStartDate)}</>}
            {f.depletedOn && <> · depleted {day(f.depletedOn)}</>}
          </p>
          {f.note && <p className="mt-0.5 text-[12px] text-gray-500">{f.note}</p>}
        </div>
        {f.status !== "depleted" && f.status === "rearing" && (
          <StartLay flock={f} onSaved={refresh} onError={setError} />
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

      <h2 className="mt-6 mb-2 text-[13px] font-semibold text-gray-700">Where it is</h2>
      <div className="card divide-y divide-gray-100">
        {f.placements.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5"
          >
            <div>
              <span className="text-[14px] font-medium text-gray-900">{p.houseCode}</span>
              <span className="ml-2 text-[12px] text-gray-500">
                {day(p.fromDate)} → {p.toDate ? day(p.toDate) : "now"}
              </span>
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

      <div className="mt-6 border-b border-gray-200">
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key);
                setError(null);
              }}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
                tab === t.key
                  ? "border-brand-600 font-medium text-brand-700"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {t.label}
              {!!t.count && <span className="ml-1.5 text-[11px] text-gray-400">{t.count}</span>}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4">
        {tab === "hatches" && <HatchTab flock={f} onSaved={refresh} onError={setError} />}
        {tab === "transfers" && (
          <TransferTab
            flock={f}
            houses={ctx?.houses ?? []}
            onSaved={refresh}
            onError={setError}
          />
        )}
        {tab === "culling" && <CullTab flock={f} onSaved={refresh} onError={setError} />}
        {tab === "movements" && <MovementTab flock={f} />}
      </div>
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

function StartLay({
  flock,
  onSaved,
  onError,
}: {
  flock: Flock;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [on, setOn] = useState(today());
  const save = useMutation({
    mutationFn: () =>
      api(`/api/farms/flocks/${flock.id}/start-lay`, { method: "POST", body: { on } }),
    onSuccess: onSaved,
    onError: (e) => onError(e instanceof ApiError ? e.message : "Could not record that"),
  });
  return (
    <div className="flex items-end gap-2">
      <div className="w-40">
        <label className="label">First eggs</label>
        <input type="date" value={on} onChange={(e) => setOn(e.target.value)} className="input" />
      </div>
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="btn-secondary whitespace-nowrap"
      >
        Start lay
      </button>
    </div>
  );
}

/* ── Hatches ─────────────────────────────────────────────────────────────── */

const HATCH_COLUMNS: Column[] = [
  { key: "hatchDate", label: "Hatched", kind: "date", width: "11rem" },
  { key: "qty", label: "Birds", kind: "number", width: "8rem" },
];

function HatchTab({
  flock,
  onSaved,
  onError,
}: {
  flock: Flock;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  useEffect(() => {
    setRows(flock.hatches.map((h) => ({ hatchDate: h.hatchDate, qty: String(h.qty) })));
  }, [flock.hatches]);

  const filled = rows
    .filter((r) => r.hatchDate && Number(r.qty) > 0)
    .map((r) => ({ hatchDate: r.hatchDate!, qty: Number(r.qty) }));
  const profile = hatchProfile(filled);
  const clash = new Set(filled.map((h) => h.hatchDate)).size !== filled.length;

  const save = useMutation({
    mutationFn: () =>
      api(`/api/farms/flocks/${flock.id}/hatches`, { method: "PUT", body: { hatches: filled } }),
    onSuccess: onSaved,
    onError: (e) => onError(e instanceof ApiError ? e.message : "Could not save those hatches"),
  });

  return (
    <Panel
      title="Batches"
      blurb="Chicks arrive over a week, not on one day. The flock's age counts from the bird-weighted average of these lines — the age most of its birds actually are."
      onSave={() => save.mutate()}
      saving={save.isPending}
      canSave={!!profile && !clash}
      disabled={flock.status === "depleted"}
    >
      <LineSet
        columns={HATCH_COLUMNS}
        rows={rows}
        blank={{ hatchDate: today(), qty: "" }}
        onChange={setRows}
        addLabel="Add hatch"
        disabled={flock.status === "depleted"}
        summary={
          clash ? (
            <span className="text-red-600">
              The same hatch date appears twice — combine those into one line.
            </span>
          ) : profile ? (
            <>
              <span className="font-medium text-gray-900">{n(profile.placedCount)} birds</span>
              {profile.spreadDays > 0 ? (
                <>
                  {" "}
                  over {filled.length} hatches spanning {profile.spreadDays + 1} days · age counts
                  from <span className="font-medium text-gray-900">{day(profile.hatchDate)}</span>
                  {profile.hatchDate !== flock.hatchDate && (
                    <span className="text-amber-700"> (was {day(flock.hatchDate)})</span>
                  )}
                </>
              ) : (
                <> hatched {day(profile.hatchDate)}</>
              )}
            </>
          ) : (
            <span className="text-amber-700">A flock needs at least one hatch.</span>
          )
        }
      />
    </Panel>
  );
}

/* ── Transfer ────────────────────────────────────────────────────────────── */

function TransferTab({
  flock,
  houses,
  onSaved,
  onError,
}: {
  flock: Flock;
  houses: Array<{ id: string; code: string; purpose: string; locationId: string }>;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const here = houses.filter((h) => h.locationId !== undefined);
  const options = here.map((h) => ({
    value: h.id,
    label: `${h.code}${h.purpose === "layer" ? " (layer)" : " (pullet)"}`,
  }));
  const columns: Column[] = [
    { key: "eventDate", label: "Date", kind: "date", width: "11rem" },
    { key: "fromHouseId", label: "From", kind: "select", options, width: "10rem" },
    { key: "toHouseId", label: "To", kind: "select", options, width: "10rem" },
    { key: "qty", label: "Birds", kind: "number", width: "8rem" },
  ];

  // Rebuilt from the ledger: each transfer_out is one line, paired with the
  // transfer_in that carries the destination.
  const existing = flock.movements
    .filter((m) => m.kind === "transfer_out")
    .map((m) => {
      const into = flock.movements.find(
        (x) =>
          x.kind === "transfer_in" && x.eventDate === m.eventDate && x.qty === m.qty,
      );
      const fromHouse = houses.find((h) => h.code === m.houseCode);
      const toHouse = houses.find((h) => h.code === into?.houseCode);
      return {
        eventDate: m.eventDate,
        fromHouseId: fromHouse?.id ?? "",
        toHouseId: toHouse?.id ?? "",
        qty: String(m.qty),
      };
    })
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  useEffect(() => setRows(existing), [flock.movements.length, houses.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const filled = rows
    .filter((r) => r.eventDate && r.fromHouseId && r.toHouseId && Number(r.qty) > 0)
    .map((r) => ({
      eventDate: r.eventDate!,
      fromHouseId: r.fromHouseId!,
      toHouseId: r.toHouseId!,
      qty: Number(r.qty),
    }));
  const moved = filled.reduce((a, l) => a + l.qty, 0);
  const sameHouse = filled.some((l) => l.fromHouseId === l.toHouseId);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/farms/flocks/${flock.id}/transfers`, { method: "PUT", body: { lines: filled } }),
    onSuccess: onSaved,
    onError: (e) => onError(e instanceof ApiError ? e.message : "Could not save those transfers"),
  });

  const open = flock.placements.filter((p) => !p.toDate);
  const defaultFrom = open[0]?.houseId ?? "";

  return (
    <Panel
      title="Transfer"
      blurb="Moving a batch out of rearing takes a week of lorries, so it is a set of dated lines rather than one act. When the last bird leaves for a layer house the flock counts as housed — nothing else moves with them, because feed, weighings and health records belong to the flock, not the shed."
      onSave={() => save.mutate()}
      saving={save.isPending}
      canSave={!sameHouse}
      disabled={flock.status === "depleted"}
    >
      <LineSet
        columns={columns}
        rows={rows}
        blank={{ eventDate: today(), fromHouseId: defaultFrom, toHouseId: "", qty: "" }}
        onChange={setRows}
        addLabel="Add a lorry"
        disabled={flock.status === "depleted"}
        summary={
          sameHouse ? (
            <span className="text-red-600">A line moves birds to the house they are already in.</span>
          ) : moved ? (
            <>
              <span className="font-medium text-gray-900">{n(moved)} birds</span> moved over{" "}
              {filled.length} {filled.length === 1 ? "trip" : "trips"}
              {flock.housedOn && <> · housed {day(flock.housedOn)}</>}
            </>
          ) : (
            <span className="text-gray-500">Nothing moved yet.</span>
          )
        }
      />
    </Panel>
  );
}

/* ── Culling ─────────────────────────────────────────────────────────────── */

function CullTab({
  flock,
  onSaved,
  onError,
}: {
  flock: Flock;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const options = flock.placements.map((p) => ({ value: p.houseId, label: p.houseCode }));
  const columns: Column[] = [
    { key: "eventDate", label: "Date", kind: "date", width: "11rem" },
    { key: "houseId", label: "House", kind: "select", options, width: "10rem" },
    { key: "qty", label: "Birds", kind: "number", width: "8rem" },
  ];

  const existing = flock.movements
    .filter((m) => m.kind === "depletion")
    .map((m) => ({
      eventDate: m.eventDate,
      houseId: flock.placements.find((p) => p.houseCode === m.houseCode)?.houseId ?? "",
      qty: String(m.qty),
    }))
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  useEffect(() => setRows(existing), [flock.movements.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const filled = rows
    .filter((r) => r.eventDate && r.houseId && Number(r.qty) > 0)
    .map((r) => ({ eventDate: r.eventDate!, houseId: r.houseId!, qty: Number(r.qty) }));
  const culled = filled.reduce((a, l) => a + l.qty, 0);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/farms/flocks/${flock.id}/culls`, { method: "PUT", body: { lines: filled } }),
    onSuccess: onSaved,
    onError: (e) => onError(e instanceof ApiError ? e.message : "Could not save that culling"),
  });

  const openBirds = flock.placements.filter((p) => !p.toDate).reduce((a, p) => a + p.birds, 0);

  return (
    <Panel
      title="Culling"
      blurb="A house is emptied over several days as the lorries come, so this is a set of dated lines too. The flock is marked depleted when the last bird goes — remove a line and it is live again, which is what correcting a mistyped lorry actually means."
      onSave={() => save.mutate()}
      saving={save.isPending}
      canSave
      disabled={false}
    >
      <LineSet
        columns={columns}
        rows={rows}
        blank={{ eventDate: today(), houseId: options[0]?.value ?? "", qty: "" }}
        onChange={setRows}
        addLabel="Add a lorry"
        summary={
          culled ? (
            <>
              <span className="font-medium text-gray-900">{n(culled)} birds</span> culled over{" "}
              {filled.length} {filled.length === 1 ? "day" : "days"} ·{" "}
              {openBirds > 0 ? (
                <span className="text-amber-700">{n(openBirds)} still in the houses</span>
              ) : (
                <span className="text-gray-600">the flock is empty</span>
              )}
            </>
          ) : (
            <span className="text-gray-500">
              Nothing culled yet — {n(openBirds)} birds standing.
            </span>
          )
        }
      />
    </Panel>
  );
}

/* ── Movements ───────────────────────────────────────────────────────────── */

function MovementTab({ flock }: { flock: Flock }) {
  return (
    <div className="table-surface overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead className="table-head">
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
          {!flock.movements.length && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                No movements yet.
              </td>
            </tr>
          )}
          {flock.movements.map((m) => {
            const inward = m.kind === "place" || m.kind === "transfer_in";
            const signed =
              m.kind === "adjustment"
                ? m.qty * (m.adjustmentSign ?? 1)
                : inward
                  ? m.qty
                  : -m.qty;
            return (
              <tr key={m.id} className="border-b border-gray-100">
                <td className="whitespace-nowrap px-3 py-2 text-gray-600">{day(m.eventDate)}</td>
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
  );
}

/* ── Shared shell ────────────────────────────────────────────────────────── */

function Panel({
  title,
  blurb,
  children,
  onSave,
  saving,
  canSave,
  disabled,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
  disabled: boolean;
}) {
  return (
    <div className="card p-4">
      <h3 className="text-[14px] font-semibold text-gray-900">{title}</h3>
      <p className="mb-3 mt-0.5 max-w-3xl text-[12px] text-gray-500">{blurb}</p>
      {children}
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={saving || !canSave || disabled}
          className="btn-primary whitespace-nowrap"
        >
          {saving ? "Saving…" : `Save ${title.toLowerCase()}`}
        </button>
        <span className="text-[11px] text-gray-500">
          Saves the whole set — pressing it twice leaves one set, not two.
        </span>
      </div>
    </div>
  );
}
