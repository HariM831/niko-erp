/**
 * Nutrient profiles — the analysis behind every least-cost mix.
 *
 * The list earns its keep by the "measured" column: a material with nothing on
 * file cannot enter a formulation, and this is where that is visible. The editor
 * groups the long tail of amino acids away from the four figures everybody
 * actually types.
 *
 * A blank means NOT MEASURED, and clearing a box deletes the reading. Zero is a
 * different statement — it tells the solver the material contains none of the
 * nutrient, and the solver will believe it.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import {
  NUTRIENTS,
  NUTRIENT_GROUPS,
  NUTRIENT_SOURCE_LABELS,
  type NutrientSource,
} from "@shared/feed";

interface IndexRow {
  id: string;
  name: string;
  unit: string;
  costPrice: string | null;
  measured: number;
  me: string | null;
  cp: string | null;
}

interface ProfileRow {
  nutrient: string;
  value: string;
  source: NutrientSource;
  testedAt: string | null;
  notes: string | null;
  updatedAt: string;
}

interface Profile {
  item: { id: string; name: string; unit: string; costPrice: string | null };
  values: ProfileRow[];
}

interface Draft {
  value: string;
  source: NutrientSource;
  testedAt: string;
}

const numOrEmpty = (v: string | null | undefined) => (v == null ? "" : String(Number(v)));

export function FeedNutrientsPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [picking, setPicking] = useState(false);
  const { data: index } = useQuery<IndexRow[]>({
    queryKey: ["feed-nutrients"],
    queryFn: () => api("/api/feed/nutrients"),
  });
  const { data: candidates } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["feed-nutrient-candidates"],
    queryFn: () => api("/api/feed/nutrients/candidates"),
    enabled: picking,
  });
  const mark = useMutation({
    mutationFn: (v: { id: string; isFeedIngredient: boolean }) =>
      api(`/api/feed/nutrients/${v.id}/mark`, { method: "POST", body: { isFeedIngredient: v.isFeedIngredient } }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["feed-nutrients"] });
      void qc.invalidateQueries({ queryKey: ["feed-nutrient-candidates"] });
      if (v.isFeedIngredient) setSelected(v.id);
      setPicking(false);
    },
  });
  const { data: profile } = useQuery<Profile>({
    queryKey: ["feed-nutrients", selected],
    queryFn: () => api(`/api/feed/nutrients/${selected}`),
    enabled: !!selected,
  });

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (index ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [index, search]);

  useEffect(() => {
    if (!selected && index?.length) setSelected(index[0]!.id);
  }, [index, selected]);

  useEffect(() => {
    if (!profile) return;
    const next: Record<string, Draft> = {};
    for (const v of profile.values) {
      next[v.nutrient] = {
        value: numOrEmpty(v.value),
        source: v.source,
        testedAt: v.testedAt ?? "",
      };
    }
    setDrafts(next);
    setError(null);
  }, [profile]);

  const set = (key: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({
      ...d,
      [key]: { value: "", source: "book", testedAt: "", ...d[key], ...patch },
    }));

  const save = useMutation({
    mutationFn: () => {
      // Everything touched: a cleared box travels as null and deletes the row.
      const before = new Map(profile?.values.map((v) => [v.nutrient, v]) ?? []);
      type Out = { nutrient: string; value: string | null; source?: NutrientSource; testedAt?: string | null };
      const values = NUTRIENTS.flatMap((n): Out[] => {
        const d = drafts[n.key];
        const had = before.has(n.key);
        const has = d != null && d.value.trim() !== "";
        if (!had && !has) return [];
        if (!has) return [{ nutrient: n.key, value: null }];
        return [
          {
            nutrient: n.key,
            value: d!.value.trim(),
            source: d!.source,
            testedAt: d!.testedAt || null,
          },
        ];
      });
      if (!values.length) return Promise.resolve(profile);
      return api<Profile>(`/api/feed/nutrients/${selected}`, { method: "PUT", body: { values } });
    },
    onSuccess: () => {
      setSaved("Profile saved");
      void qc.invalidateQueries({ queryKey: ["feed-nutrients"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  const measuredCount = Object.values(drafts).filter((d) => d.value.trim() !== "").length;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Nutrient Profiles</h1>
        <p className="text-[13px] text-gray-500">
          What each material is made of. A material with nothing on file cannot enter a formulation
        </p>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-44 shrink-0 flex-col border-r bg-white lg:w-64">
          <div className="space-y-1.5 border-b p-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a material"
              className="input h-8 w-full text-[13px]"
            />
            <button
              onClick={() => setPicking((p) => !p)}
              className="w-full rounded-md border border-dashed border-gray-300 px-2 py-1 text-[12px] text-gray-500 hover:border-brand-400 hover:text-brand-600"
            >
              {picking ? "Cancel" : "+ Mark an item as a feed ingredient"}
            </button>
            {picking && (
              <select
                autoFocus
                defaultValue=""
                onChange={(e) => e.target.value && mark.mutate({ id: e.target.value, isFeedIngredient: true })}
                className="input h-8 w-full text-[12px]"
              >
                <option value="" disabled>
                  Pick from the item master…
                </option>
                {candidates?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setSelected(r.id);
                  setSaved(null);
                  setError(null);
                }}
                className={`block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 ${
                  selected === r.id ? "bg-brand-50" : ""
                }`}
              >
                <div className="truncate text-[13px] font-medium text-gray-900">{r.name}</div>
                <div className="text-[11px] text-gray-400">
                  {r.measured === 0 ? (
                    "No analysis"
                  ) : (
                    <>
                      {r.measured} nutrient{r.measured === 1 ? "" : "s"}
                      {r.cp != null && ` · CP ${Number(r.cp)}%`}
                      {r.me != null && ` · ${Number(r.me)} kcal`}
                    </>
                  )}
                </div>
              </button>
            ))}
            {index && !shown.length && (
              <p className="p-4 text-[13px] text-gray-400">
                {search
                  ? `Nothing matches “${search}”.`
                  : "No feed ingredients yet — mark the materials the mill mixes."}
              </p>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-surface p-3 lg:p-6">
          {!profile ? (
            <p className="text-[13px] text-gray-400">Pick a material.</p>
          ) : (
            <div className="mx-auto max-w-3xl">
              {saved && (
                <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-800">
                  {saved}
                </div>
              )}
              {error && (
                <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                  {error}
                </div>
              )}

              <div className="card p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                  <div className="flex items-center gap-2">
                    <FlaskConical size={16} className="text-brand-500" />
                    <span className="text-[15px] font-semibold text-gray-900">{profile.item.name}</span>
                  </div>
                  <span className="text-[12px] text-gray-500">
                    {measuredCount} of {NUTRIENTS.length} nutrients on file
                  </span>
                </div>

                {NUTRIENT_GROUPS.map(({ group, label }) => (
                  <div key={group} className="mb-4">
                    <div className="label mb-2">{label}</div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
                      {NUTRIENTS.filter((n) => n.group === group).map((n) => {
                        const d = drafts[n.key];
                        return (
                          <div key={n.key}>
                            <div className="mb-0.5 flex items-baseline justify-between">
                              <label className="text-[11px] font-medium text-gray-600">{n.label}</label>
                              <span className="text-[10px] text-gray-400">{n.unit}</span>
                            </div>
                            <input
                              value={d?.value ?? ""}
                              onChange={(e) => set(n.key, { value: e.target.value })}
                              inputMode="decimal"
                              placeholder="—"
                              className="input h-8 text-right text-[13px]"
                            />
                            {d?.value.trim() ? (
                              <select
                                value={d.source}
                                onChange={(e) => set(n.key, { source: e.target.value as NutrientSource })}
                                className="mt-0.5 w-full border-0 bg-transparent p-0 text-[10px] text-gray-400"
                              >
                                {Object.entries(NUTRIENT_SOURCE_LABELS).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div className="mt-0.5 text-[10px] text-gray-300">not measured</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <div className="mt-2 flex items-center justify-between border-t pt-3">
                  <p className="max-w-md text-[11px] text-gray-400">
                    A blank means not measured — clearing a box deletes the reading. Zero is a
                    different claim: it tells the formulator this material contains none of it.
                  </p>
                  <div className="flex shrink-0 items-center gap-3">
                    <button
                      onClick={() => {
                        setSelected(null);
                        mark.mutate({ id: profile.item.id, isFeedIngredient: false });
                      }}
                      className="text-[11px] text-gray-400 hover:text-red-600"
                      title="Take it off the feed list; the analysis is kept"
                    >
                      Not a feed ingredient
                    </button>
                    <button
                      onClick={() => {
                        setSaved(null);
                        setError(null);
                        save.mutate();
                      }}
                      disabled={save.isPending}
                      className="btn-primary"
                    >
                      Save profile
                    </button>
                  </div>
                </div>
              </div>

              {profile.values.length > 0 && (
                <p className="mt-3 px-1 text-[11px] text-gray-400">
                  Last change {formatDate(profile.values[0]!.updatedAt?.slice(0, 10))}. Figures feed
                  the formulator directly — a book value standing in for a lab result is worth
                  knowing about before money moves on its word.
                </p>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
