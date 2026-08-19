/**
 * Houses board — the Farms landing page.
 *
 * Answers one question: what is standing in each house today. One card per
 * PLACEMENT, not per house, so a flock split across two sheds shows twice and a
 * shed holding two flocks shows two cards — both ordinary, and neither was
 * expressible before placements existed.
 *
 * Empty houses are listed too. A board that only shows occupancy quietly hides
 * the shed nobody has placed into, which is the most expensive thing on a farm.
 *
 * One request feeds the whole page. The dashboard this replaces made roughly 28.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, X } from "lucide-react";
import { ApiError, api } from "../api";
import { hatchProfile } from "@shared/schema/flocks";
import { HOUSE_PURPOSE_LABELS, type HousePurpose } from "@shared/schema/farms";

const today = () => new Date().toISOString().slice(0, 10);
const n = (v: number) => v.toLocaleString("en-IN");

interface Board {
  date: string;
  placements: Array<{
    placementId: string;
    houseId: string;
    houseCode: string;
    housePurpose: HousePurpose;
    locationName: string;
    flockId: string;
    flockCode: string;
    flockStatus: string;
    breedName: string;
    birds: number;
    age: { label: string; days: number };
  }>;
  emptyHouses: Array<{
    id: string;
    code: string;
    purpose: HousePurpose;
    locationName: string;
    ownerName: string | null;
  }>;
  totals: { birds: number; houses: number; occupied: number };
}

interface Context {
  sites: Array<{ id: string; name: string }>;
  houses: Array<{ id: string; code: string; purpose: HousePurpose; locationId: string }>;
  breeds: Array<{ id: string; name: string }>;
  standardSets: Array<{
    id: string;
    breedId: string;
    name: string;
    version: number;
    isDefault: boolean;
  }>;
}

export function FarmsBoardPage() {
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const [adding, setAdding] = useState(false);

  const { data: board, isLoading } = useQuery<Board>({
    queryKey: ["farms-board", date],
    queryFn: () => api(`/api/farms/board?date=${date}`),
  });

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Farms</h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            What is standing in each house, and what is standing empty.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="label">As at</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value || today())}
              className="input"
            />
          </div>
          <button onClick={() => setAdding(true)} className="btn-primary flex items-center gap-1">
            <Plus size={14} /> New flock
          </button>
        </div>
      </div>

      {board && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Birds" value={n(board.totals.birds)} />
          <Tile label="Flocks placed" value={n(board.placements.length)} />
          <Tile
            label="Houses in use"
            value={`${board.totals.occupied} of ${board.totals.houses}`}
          />
          <Tile label="Standing empty" value={n(board.emptyHouses.length)} tone="warn" />
        </div>
      )}

      {isLoading && <p className="text-[13px] text-gray-500">Loading…</p>}

      {board && !board.placements.length && (
        <div className="card p-6 text-center">
          <p className="text-[14px] font-medium text-gray-900">No flock placed on this date.</p>
          <p className="mt-1 text-[13px] text-gray-500">
            A house holds birds once a flock is placed in it. Nothing is inferred from the shed.
          </p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {board?.placements.map((p) => (
          <Link key={p.placementId} href={`/farms/flocks/${p.flockId}`}>
            <a className="card block p-4 transition hover:border-gray-300 hover:shadow-sm">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[15px] font-semibold text-gray-900">{p.houseCode}</span>
                  <span className="text-gray-300">·</span>
                  <span className="text-[13px] font-medium text-gray-700">{p.flockCode}</span>
                </div>
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
                  {p.age.label}
                </span>
              </div>
              <div className="mt-0.5 text-[12px] text-gray-500">
                {p.breedName} · {p.locationName} · {HOUSE_PURPOSE_LABELS[p.housePurpose]}
              </div>
              <div className="mt-3 text-[22px] font-semibold tabular-nums text-gray-900">
                {n(p.birds)}
                <span className="ml-1 text-[12px] font-normal text-gray-500">birds</span>
              </div>
            </a>
          </Link>
        ))}
      </div>

      {!!board?.emptyHouses.length && (
        <div className="mt-6">
          <h2 className="mb-2 text-[13px] font-semibold text-gray-700">
            Empty on {board.date}
          </h2>
          <div className="flex flex-wrap gap-2">
            {board.emptyHouses.map((h) => (
              <span
                key={h.id}
                className="rounded border border-dashed border-gray-300 px-2.5 py-1 text-[12px] text-gray-500"
              >
                <span className="font-medium text-gray-700">{h.code}</span> ·{" "}
                {HOUSE_PURPOSE_LABELS[h.purpose]} · {h.locationName}
                {h.ownerName && <span className="text-gray-400"> · {h.ownerName}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {adding && (
        <NewFlockDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ["farms-board"] });
          }}
        />
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

/**
 * New flock.
 *
 * A batch arrives as several hatches across a week, so the hatches are the
 * input and the flock's age is their bird-weighted average — the age most of
 * its birds actually are, which is what the standard curve is keyed on.
 *
 * Not asked for, deliberately: the standard set (it is always the breed's, so
 * choosing it is a question with one answer), the placement date (the house
 * holds birds from the first hatch), and origin (a sentence, not two fields —
 * it goes in the note).
 */
function NewFlockDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    code: "",
    locationId: "",
    houseId: "",
    breedId: "",
    note: "",
  });
  const [hatches, setHatches] = useState([{ hatchDate: today(), qty: "" }]);

  const { data: ctx } = useQuery<Context>({
    queryKey: ["farm-flock-context"],
    queryFn: () => api("/api/farms/flock-context"),
  });

  const housesHere = ctx?.houses.filter((h) => h.locationId === f.locationId) ?? [];
  const filled = hatches
    .filter((h) => h.hatchDate && Number(h.qty) > 0)
    .map((h) => ({ hatchDate: h.hatchDate, qty: Number(h.qty) }));
  const profile = hatchProfile(filled);
  const clash = new Set(filled.map((h) => h.hatchDate)).size !== filled.length;

  const save = useMutation({
    mutationFn: () =>
      api("/api/farms/flocks", {
        method: "POST",
        body: {
          code: f.code.trim(),
          locationId: f.locationId,
          houseId: f.houseId,
          breedId: f.breedId,
          hatches: filled,
          note: f.note.trim() || null,
        },
      }),
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not place that flock"),
  });

  const ready = f.code.trim() && f.locationId && f.houseId && f.breedId && !!profile && !clash;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-6">
      <div className="card w-full max-w-2xl p-5">
        <h2 className="text-[15px] font-semibold text-gray-900">New flock</h2>
        <p className="mt-0.5 text-[12px] text-gray-500">
          A batch, made of the hatches it actually arrived in. Its age counts from their
          bird-weighted average, and it is measured against the breed's default curve.
        </p>
        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          <div>
            <label className="label-required">Code *</label>
            <input
              value={f.code}
              onChange={(e) => setF((v) => ({ ...v, code: e.target.value }))}
              placeholder="AMN-2026-03"
              className="input"
            />
          </div>
          <div>
            <label className="label-required">Site *</label>
            <select
              value={f.locationId}
              onChange={(e) =>
                setF((v) => ({ ...v, locationId: e.target.value, houseId: "" }))
              }
              className="input"
            >
              <option value="">Choose…</option>
              {ctx?.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-required">House *</label>
            <select
              value={f.houseId}
              onChange={(e) => setF((v) => ({ ...v, houseId: e.target.value }))}
              disabled={!f.locationId}
              className="input"
            >
              <option value="">{f.locationId ? "Choose…" : "Pick a site first"}</option>
              {housesHere.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.code} — {HOUSE_PURPOSE_LABELS[h.purpose]}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="label-required">Breed *</label>
            <select
              value={f.breedId}
              onChange={(e) => setF((v) => ({ ...v, breedId: e.target.value }))}
              className="input"
            >
              <option value="">Choose…</option>
              {ctx?.breeds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            {f.breedId && !ctx?.standardSets.some((s) => s.breedId === f.breedId && s.isDefault) && (
              <p className="mt-1 text-[11px] text-amber-700">
                That breed has no default standard set, so this flock will be placed without a
                benchmark. Add one under Settings → Farms → Breeds & Standards.
              </p>
            )}
          </div>
        </div>

        {/* Hatches. The batch is what arrived, not one date somebody rounded to. */}
        <div className="mt-4">
          <label className="label-required">Hatches *</label>
          <div className="space-y-2">
            {hatches.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="date"
                  value={h.hatchDate}
                  onChange={(e) =>
                    setHatches((cur) =>
                      cur.map((r, j) => (j === i ? { ...r, hatchDate: e.target.value } : r)),
                    )
                  }
                  className="input"
                />
                <input
                  value={h.qty}
                  onChange={(e) =>
                    setHatches((cur) =>
                      cur.map((r, j) => (j === i ? { ...r, qty: e.target.value } : r)),
                    )
                  }
                  inputMode="numeric"
                  placeholder="Birds"
                  className="input text-right"
                />
                <button
                  onClick={() => setHatches((cur) => cur.filter((_, j) => j !== i))}
                  disabled={hatches.length === 1}
                  className="text-[12px] text-gray-400 hover:text-red-600 disabled:opacity-30"
                  title="Remove this hatch"
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() => setHatches((cur) => [...cur, { hatchDate: today(), qty: "" }])}
            className="mt-2 text-[12px] text-blue-600 hover:underline"
          >
            + Add hatch
          </button>

          {clash && (
            <p className="mt-2 text-[12px] text-red-600">
              The same hatch date appears twice — combine those into one line.
            </p>
          )}
          {profile && !clash && (
            <div className="mt-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-600">
              <span className="font-medium text-gray-900">{n(profile.placedCount)} birds</span>
              {profile.spreadDays > 0 ? (
                <>
                  {" "}
                  over {hatches.filter((h) => Number(h.qty) > 0).length} hatches spanning{" "}
                  {profile.spreadDays + 1} days · age counts from the weighted average{" "}
                  <span className="font-medium text-gray-900">{profile.hatchDate}</span>
                </>
              ) : (
                <> hatched {profile.hatchDate}</>
              )}
            </div>
          )}
        </div>

        <div className="mt-3">
          <label className="label">Note</label>
          <input
            value={f.note}
            onChange={(e) => setF((v) => ({ ...v, note: e.target.value }))}
            placeholder="Purchased pullets, Suguna invoice 4471…"
            className="input"
          />
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => save.mutate()}
            disabled={!ready || save.isPending}
            className="btn-primary"
          >
            {save.isPending ? "Placing…" : "Place flock"}
          </button>
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <span className="text-[11px] text-gray-500">
            Writes the flock, its placement and its opening movement together.
          </span>
        </div>
      </div>
    </div>
  );
}
