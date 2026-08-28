/**
 * Batches — every cohort on the farm, and the only place one is created.
 *
 * A batch is not the shed's. It arrives over several hatches, moves to the
 * layer house over several lorries and is culled out over several days, keeping
 * ONE record throughout; the shed is only where it was standing on a given day.
 * So batches are made and listed here, and a house page reports what it happens
 * to be holding.
 *
 * Creating one asks for the hatches rather than a single date, because that is
 * what actually arrives — and the flock's age counts from their bird-weighted
 * average, which is the age most of its birds really are.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Layers, Plus, X } from "lucide-react";
import { ApiError, api } from "../api";
import { FLOCK_STATUS_LABELS, hatchProfile, type FlockStatus } from "@shared/schema/flocks";
import { HOUSE_PURPOSE_LABELS, type HousePurpose } from "@shared/schema/farms";

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
  birds: number;
  houseCodes: string;
  breedName: string;
  locationName: string;
  layStartDate: string | null;
  depletedOn: string | null;
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

export function FarmsBatchesPage() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<"all" | FlockStatus>("all");

  const { data: flocks, isLoading } = useQuery<Flock[]>({
    queryKey: ["farm-batches", status],
    queryFn: () => api(`/api/farms/flocks?status=${status}`),
  });

  return (
    <div className="min-h-full bg-soil-50 p-4 md:p-6">
      <div className="page-header -mx-4 mb-5 flex flex-wrap items-end justify-between gap-3 px-4 py-3 md:-mx-6 md:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-yolk-400 to-yolk-600 text-white shadow-sm">
            <Layers className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-soil-900">Batches</h1>
            </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-40">
            <label className="label">Showing</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="input"
            >
              <option value="all">All</option>
              <option value="rearing">Rearing</option>
              <option value="laying">Laying</option>
              <option value="depleted">Depleted</option>
            </select>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="btn-yolk flex min-h-[44px] items-center gap-1 whitespace-nowrap"
          >
            <Plus size={14} /> New batch
          </button>
        </div>
      </div>

      {isLoading && <p className="text-[13px] text-gray-500">Loading…</p>}

      {flocks && !flocks.length && (
        <div className="rounded-2xl bg-white p-6 text-center shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
          <p className="text-[14px] font-medium text-soil-900">No batches yet.</p>
          <p className="mt-1 text-[13px] text-soil-400">
            A batch is created here, then placed in a house. Houses report what they are holding.
          </p>
        </div>
      )}

      {!!flocks?.length && (
        <div className="overflow-x-auto rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
          <table className="w-full text-[13px]">
            <thead className="bg-soil-50 text-left text-[11px] font-semibold uppercase text-soil-400">
              <tr className="border-b border-soil-100">
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2">Breed</th>
                <th className="px-3 py-2">Site</th>
                <th className="px-3 py-2">In</th>
                <th className="px-3 py-2">Hatched</th>
                <th className="px-3 py-2 text-right">Placed</th>
                <th className="px-3 py-2 text-right">Birds</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {flocks.map((f) => (
                <tr key={f.id} className="border-b border-soil-100/70 last:border-0 transition-colors hover:bg-yolk-50/70">
                  <td className="px-3 py-2">
                    {/* wouter's Link IS the anchor — wrapping one inside it
                        nests <a> in <a>, which React refuses to render. */}
                    <Link href={`/farms/flocks/${f.id}`} className="s-link">
                      {f.code}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{f.breedName}</td>
                  <td className="px-3 py-2 text-gray-600">{f.locationName}</td>
                  <td className="px-3 py-2 text-gray-600">{f.houseCodes}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{day(f.hatchDate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                    {n(f.placedCount)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-900">
                    {n(f.birds)}
                  </td>
                  <td className="px-3 py-2">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <NewBatchDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ["farm-batches"] });
          }}
        />
      )}
    </div>
  );
}

/**
 * New batch.
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
function NewBatchDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
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

  // Shown, not typed. The server generates it again on save from the same rule,
  // so a stale preview cannot become the actual code.
  const { data: nextCode } = useQuery<{ code: string }>({
    queryKey: ["next-flock-code", f.locationId, hatches[0]?.hatchDate?.slice(0, 4)],
    queryFn: () =>
      api(
        `/api/farms/next-flock-code?locationId=${f.locationId}&year=${hatches[0]?.hatchDate?.slice(0, 4) ?? new Date().getFullYear()}`,
      ),
    enabled: !!f.locationId,
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
          locationId: f.locationId,
          houseId: f.houseId,
          breedId: f.breedId,
          hatches: filled,
          note: f.note.trim() || null,
        },
      }),
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not place that batch"),
  });

  const ready = f.locationId && f.houseId && f.breedId && !!profile && !clash;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-6">
      <div className="card w-full max-w-2xl p-5">
        <h2 className="text-[15px] font-semibold text-gray-900">New batch</h2>
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
            <label className="label">Code</label>
            {/* Generated from site and year — "the second Nalbari batch of 2026"
                is what people say, so it is what the code says. */}
            <div className="input flex items-center bg-soil-50 font-medium text-gray-700">
              {f.locationId ? (nextCode?.code ?? "…") : "Pick a site"}
            </div>
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
            className="mt-2 text-[12px] text-yolk-600 hover:underline"
          >
            + Add hatch
          </button>

          {clash && (
            <p className="mt-2 text-[12px] text-red-600">
              The same hatch date appears twice — combine those into one line.
            </p>
          )}
          {profile && !clash && (
            <div className="mt-2 rounded-lg border border-soil-200 bg-soil-50 px-3 py-2 text-[12px] text-gray-600">
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
            className="btn-yolk"
          >
            {save.isPending ? "Placing…" : "Place batch"}
          </button>
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <span className="text-[11px] text-gray-500">
            Writes the batch, its placement and its opening movement together.
          </span>
        </div>
      </div>
    </div>
  );
}
