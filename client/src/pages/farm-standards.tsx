/**
 * Breeds & Standards — the curves a flock is measured against.
 *
 * Sets are VERSIONED and a flock pins the version it was placed under, so a set
 * that any flock uses is never edited in place: the screen offers "Save as v2"
 * instead. Without that, revising a breeder guide in 2027 silently restates
 * what a 2026 flock was measured against, and every "vs standard" number in its
 * history quietly changes meaning.
 *
 * The grid is the whole curve at once. It replaces per-row editing because a
 * curve is one object — a half-applied import that leaves weeks 40–90 from the
 * previous upload is worse than one that failed outright.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { ApiError, api } from "../api";
import { STANDARD_METRICS, STANDARD_SOURCES } from "@shared/schema/breeds";
import {
  Banner,
  EmptyRow,
  SettingsHeader,
  SettingsTable,
} from "../components/settings-ui";

interface Breed {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  setCount: number;
  defaultSetId: string | null;
}

interface StandardSet {
  id: string;
  breedId: string;
  breedName: string;
  name: string;
  source: string | null;
  version: number;
  isDefault: boolean;
  pointCount: number;
  /** How many flocks are pinned to it. Above zero, editing versions instead. */
  flockCount: number;
}

type Point = Record<string, string | number | null> & { ageWeek: number };

export function FarmStandardsSection() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [openSet, setOpenSet] = useState<string | null>(null);
  const [addingBreed, setAddingBreed] = useState(false);
  const [addingSet, setAddingSet] = useState<string | null>(null);

  const { data: breeds } = useQuery<Breed[]>({
    queryKey: ["farm-breeds"],
    queryFn: () => api("/api/farms/breeds"),
  });
  const { data: sets } = useQuery<StandardSet[]>({
    queryKey: ["farm-standard-sets"],
    queryFn: () => api("/api/farms/standard-sets"),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["farm-breeds"] });
    void qc.invalidateQueries({ queryKey: ["farm-standard-sets"] });
    void qc.invalidateQueries({ queryKey: ["farm-flock-context"] });
  };

  return (
    <div>
      <SettingsHeader
        title="Breeds & Standards"
        description="The performance curve a flock is compared against. Sets are versioned and pinned at placement, so revising a guide never restates a flock that was already measured against the old one."
      />
      {error && <Banner tone="error">{error}</Banner>}

      <div className="mb-3 flex gap-2">
        <button
          onClick={() => setAddingBreed((v) => !v)}
          className="btn-secondary flex items-center gap-1"
        >
          <Plus size={14} /> New breed
        </button>
      </div>

      {addingBreed && (
        <NewBreed
          onDone={() => {
            setAddingBreed(false);
            refresh();
          }}
          onError={setError}
        />
      )}

      <SettingsTable
        columns={[
          { label: "Standard set" },
          { label: "Source" },
          { label: "Weeks", align: "right" },
          { label: "Flocks", align: "right" },
          { label: "", width: "110px" },
        ]}
      >
        {!breeds?.length && <EmptyRow colSpan={5}>No breeds yet.</EmptyRow>}
        {breeds?.map((b) => {
          const mine = sets?.filter((s) => s.breedId === b.id) ?? [];
          return (
            <BreedGroup
              key={b.id}
              breed={b}
              sets={mine}
              openSet={openSet}
              onToggleSet={(id) =>
                setOpenSet((cur) => (cur === id ? null : id))
              }
              adding={addingSet === b.id}
              onAdd={() => setAddingSet((cur) => (cur === b.id ? null : b.id))}
              onDone={() => {
                setAddingSet(null);
                refresh();
              }}
              onError={setError}
            />
          );
        })}
      </SettingsTable>

      {/* Outside the table on purpose. A grid eight columns wide inside a <td>
          stretches the cell, which stretches the table, which makes the whole
          settings pane scroll sideways — the one thing a page body must never
          do. An overlay also gives the curve the room it actually needs. */}
      {openSet && sets?.some((s) => s.id === openSet) && (
        <CurveDialog
          set={sets.find((s) => s.id === openSet)!}
          onClose={() => setOpenSet(null)}
          onError={setError}
        />
      )}
    </div>
  );
}

function BreedGroup({
  breed,
  sets,
  openSet,
  onToggleSet,
  adding,
  onAdd,
  onDone,
  onError,
}: {
  breed: Breed;
  sets: StandardSet[];
  openSet: string | null;
  onToggleSet: (id: string) => void;
  adding: boolean;
  onAdd: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={5} className="bg-gray-50 px-3 py-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-gray-700">
              {breed.name}{" "}
              <span className="font-normal text-gray-400">{breed.code}</span>
            </span>
            <button
              onClick={onAdd}
              className="text-[11px] text-blue-600 hover:underline"
            >
              {adding ? "Cancel" : "+ Standard set"}
            </button>
          </div>
        </td>
      </tr>
      {adding && (
        <tr>
          <td colSpan={5} className="px-3 py-3">
            <NewSet breedId={breed.id} onDone={onDone} onError={onError} />
          </td>
        </tr>
      )}
      {!sets.length && !adding && (
        <tr>
          <td colSpan={5} className="px-3 py-3 text-[12px] text-gray-500">
            No standard set — a flock of this breed cannot be placed until it
            has one.
          </td>
        </tr>
      )}
      {sets.map((s) => (
        <Fragment key={s.id}>
          <tr className="border-b border-gray-100">
            <td className="px-3 py-2">
              <span className="font-medium text-gray-900">{s.name}</span>
              <span className="ml-2 text-[11px] text-gray-500">
                v{s.version}
              </span>
              {s.isDefault && (
                <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
                  default
                </span>
              )}
            </td>
            <td className="px-3 py-2 text-gray-600">{s.source ?? "—"}</td>
            <td className="px-3 py-2 text-right tabular-nums text-gray-600">
              {s.pointCount}
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-gray-600">
              {s.flockCount}
            </td>
            <td className="px-3 py-2 text-right">
              <button
                onClick={() => onToggleSet(s.id)}
                className="text-[12px] text-blue-600 hover:underline"
              >
                {openSet === s.id ? "Close" : "Edit curve"}
              </button>
            </td>
          </tr>
        </Fragment>
      ))}
    </>
  );
}

function NewBreed({
  onDone,
  onError,
}: {
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [f, setF] = useState({ code: "", name: "" });
  const save = useMutation({
    mutationFn: () =>
      api("/api/farms/breeds", {
        method: "POST",
        body: { code: f.code.trim(), name: f.name.trim() },
      }),
    onSuccess: onDone,
    onError: (e) =>
      onError(e instanceof ApiError ? e.message : "Could not add that breed"),
  });
  return (
    <div className="card mb-4 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div>
          <label className="label-required">Code *</label>
          <input
            value={f.code}
            onChange={(e) => setF((v) => ({ ...v, code: e.target.value }))}
            placeholder="LSL"
            className="input"
          />
        </div>
        <div className="md:col-span-2">
          <label className="label-required">Name *</label>
          <input
            value={f.name}
            onChange={(e) => setF((v) => ({ ...v, name: e.target.value }))}
            placeholder="Lohmann LSL-Lite"
            className="input"
          />
        </div>
      </div>
      <button
        onClick={() => save.mutate()}
        disabled={!f.code.trim() || !f.name.trim() || save.isPending}
        className="btn-primary mt-3"
      >
        {save.isPending ? "Adding…" : "Add breed"}
      </button>
    </div>
  );
}

function NewSet({
  breedId,
  onDone,
  onError,
}: {
  breedId: string;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [f, setF] = useState({ name: "", source: "breeder", isDefault: true });
  const save = useMutation({
    mutationFn: () =>
      api("/api/farms/standard-sets", {
        method: "POST",
        body: {
          breedId,
          name: f.name.trim(),
          source: f.source || null,
          isDefault: f.isDefault,
        },
      }),
    onSuccess: onDone,
    onError: (e) =>
      onError(e instanceof ApiError ? e.message : "Could not add that set"),
  });
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[220px] flex-1">
        <label className="label-required">Name *</label>
        <input
          value={f.name}
          onChange={(e) => setF((v) => ({ ...v, name: e.target.value }))}
          placeholder="Lohmann LSL-Lite 2023 guide"
          className="input"
        />
      </div>
      <div className="w-40">
        <label className="label">Source</label>
        <select
          value={f.source}
          onChange={(e) => setF((v) => ({ ...v, source: e.target.value }))}
          className="input"
        >
          {STANDARD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-1.5 pb-2 text-[12px] text-gray-600">
        <input
          type="checkbox"
          checked={f.isDefault}
          onChange={(e) => setF((v) => ({ ...v, isDefault: e.target.checked }))}
        />
        Default for this breed
      </label>
      <button
        onClick={() => save.mutate()}
        disabled={!f.name.trim() || save.isPending}
        className="btn-primary"
      >
        {save.isPending ? "Adding…" : "Add set"}
      </button>
    </div>
  );
}

/**
 * The curve. Weeks down, metrics across — the shape a breeder guide is printed
 * in, so it can be typed or pasted straight across.
 */
function CurveDialog({
  set,
  onClose,
  onError,
}: {
  set: StandardSet;
  onClose: () => void;
  onError: (m: string) => void;
}) {
  const qc = useQueryClient();
  const [weeks, setWeeks] = useState(20);
  const [rows, setRows] = useState<Record<number, Record<string, string>>>({});
  const [saved, setSaved] = useState<string | null>(null);

  const { data: points } = useQuery<Point[]>({
    queryKey: ["standard-points", set.id],
    queryFn: () => api(`/api/farms/standard-sets/${set.id}/points`),
  });

  useEffect(() => {
    if (!points) return;
    const next: Record<number, Record<string, string>> = {};
    for (const p of points) {
      next[p.ageWeek] = Object.fromEntries(
        STANDARD_METRICS.map((m) => [
          m.key,
          p[m.key] == null ? "" : String(p[m.key]),
        ]),
      );
    }
    setRows(next);
    if (points.length) setWeeks(Math.max(20, ...points.map((p) => p.ageWeek)));
  }, [points]);

  const weekList = useMemo(
    () => Array.from({ length: weeks }, (_, i) => i + 1),
    [weeks],
  );

  const save = useMutation({
    mutationFn: () => {
      // Only weeks with at least one number. An empty row is a week nobody has
      // filled in, not a week of zeroes.
      const payload = weekList
        .map((w) => {
          const r = rows[w] ?? {};
          const vals = Object.fromEntries(
            STANDARD_METRICS.map((m) => [
              m.key,
              r[m.key]?.trim() ? r[m.key] : null,
            ]),
          );
          return Object.values(vals).some((v) => v !== null)
            ? { ageWeek: w, ...vals }
            : null;
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);
      return api<{ points: number }>(
        `/api/farms/standard-sets/${set.id}/points`,
        {
          method: "PUT",
          body: { points: payload },
        },
      );
    },
    onSuccess: (r: { points: number }) => {
      setSaved(`${r.points} week(s) saved`);
      void qc.invalidateQueries({ queryKey: ["standard-points", set.id] });
      void qc.invalidateQueries({ queryKey: ["farm-standard-sets"] });
    },
    onError: (e) =>
      onError(e instanceof ApiError ? e.message : "Could not save the curve"),
  });

  const pinned = set.flockCount > 0;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-6">
      <div className="card w-full max-w-4xl p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-gray-900">
              {set.breedName} — {set.name}{" "}
              <span className="font-normal text-gray-400">v{set.version}</span>
            </h2>
            <p className="mt-0.5 text-[12px] text-gray-500">
              The breeder's curve, week by week. Blank means not published, not
              zero.
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost">
            Close
          </button>
        </div>
        {pinned && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            {set.flockCount} flock(s) are pinned to this set. Editing it here
            changes what they are measured against — add a new version instead
            if their history should stay as recorded.
          </div>
        )}

        <div className="mb-2 flex items-center gap-3">
          <label className="text-[12px] text-gray-600">Weeks shown</label>
          {/* The width goes on the wrapper: `.input` carries `@apply w-full`,
              which outranks a `w-20` sitting beside it in the class list. */}
          <div className="w-20">
            <input
              value={weeks}
              onChange={(e) =>
                setWeeks(Math.min(120, Math.max(1, Number(e.target.value) || 1)))
              }
              inputMode="numeric"
              className="input text-right"
            />
          </div>
          {saved && <span className="text-[12px] text-green-700">{saved}</span>}
        </div>

        <div className="max-h-[420px] overflow-auto rounded border border-gray-200 bg-white">
          <table className="text-[12px]">
            <thead className="sticky top-0 bg-gray-50">
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500">
                <th className="sticky left-0 bg-gray-50 px-2 py-1.5">Wk</th>
                {STANDARD_METRICS.map((m) => (
                  <th
                    key={m.key}
                    className="px-2 py-1.5 text-right whitespace-nowrap"
                  >
                    {m.label}
                    <span className="ml-1 font-normal normal-case text-gray-400">
                      {m.unit}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weekList.map((w) => (
                <tr key={w} className="border-b border-gray-100">
                  <td className="sticky left-0 bg-white px-2 py-1 font-medium tabular-nums text-gray-700">
                    {w}
                  </td>
                  {STANDARD_METRICS.map((m) => (
                    <td key={m.key} className="px-1 py-0.5">
                      <input
                        value={rows[w]?.[m.key] ?? ""}
                        onChange={(e) =>
                          setRows((cur) => ({
                            ...cur,
                            [w]: { ...(cur[w] ?? {}), [m.key]: e.target.value },
                          }))
                        }
                        inputMode="decimal"
                        className="w-20 rounded border border-transparent px-1.5 py-1 text-right tabular-nums hover:border-gray-200 focus:border-blue-400 focus:outline-none"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="btn-primary mt-3"
        >
          {save.isPending ? "Saving…" : "Save curve"}
        </button>
        <span className="ml-2 text-[11px] text-gray-500">
          Saves the whole curve at once — a half-applied curve is worse than
          none.
        </span>
      </div>
    </div>
  );
}
