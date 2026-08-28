/**
 * The nutrient analysis for one material, on that material's own page.
 *
 * It used to be a screen of its own with every ingredient listed down the
 * side. An analysis is a fact ABOUT a material — the same kind of thing as its
 * quality spec, which now sits on the next tab — so keeping it somewhere else
 * meant two places to look up one maize.
 *
 * A blank is not a zero, and the distinction is the point: blank means nobody
 * has measured it and the formulator will treat it as nothing while SAYING so;
 * zero is a claim that the material genuinely contains none.
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

interface ProfileRow {
  nutrient: string;
  value: string;
  source: NutrientSource;
  testedAt: string | null;
  notes: string | null;
  updatedAt: string;
}

interface Profile {
  item: {
    id: string;
    name: string;
    unit: string;
    costPrice: string | null;
    isFeedIngredient: boolean;
  };
  values: ProfileRow[];
}

interface Draft {
  value: string;
  source: NutrientSource;
  testedAt: string;
}

const numOrEmpty = (v: string | null | undefined) => (v == null ? "" : String(Number(v)));

export function ItemNutrientProfile({ itemId }: { itemId: string }) {
  const qc = useQueryClient();
  const selected = itemId;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const markIngredient = useMutation({
    mutationFn: (isFeedIngredient: boolean) =>
      api(`/api/feed/nutrients/${itemId}/mark`, { method: "POST", body: { isFeedIngredient } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["feed-nutrients"] });
      void qc.invalidateQueries({ queryKey: ["item", itemId] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not change that"),
  });

  const { data: profile } = useQuery<Profile>({
    queryKey: ["feed-nutrients", selected],
    queryFn: () => api(`/api/feed/nutrients/${selected}`),
    enabled: !!selected,
  });

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
    <>
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
                  <div className="flex items-center gap-3">
                    {/* What the analysis is FOR. An item the formulator may not
                        reach is one nobody will ever solve with, however
                        completely it is measured — so the switch sits with the
                        figures rather than three screens away. */}
                    <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-gray-600">
                      <input
                        type="checkbox"
                        checked={profile.item.isFeedIngredient ?? false}
                        onChange={(e) => markIngredient.mutate(e.target.checked)}
                        className="h-3.5 w-3.5 accent-brand-500"
                      />
                      Available to the formulator
                    </label>
                    <span className="text-[12px] text-gray-500">
                      {measuredCount} of {NUTRIENTS.length} nutrients on file
                    </span>
                  </div>
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

                <div className="mt-2 flex items-center justify-end border-t pt-3">
                  <div className="flex shrink-0 items-center gap-3">
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
                  Last change {formatDate(profile.values[0]!.updatedAt?.slice(0, 10))}.
                </p>
              )}
            </div>
          )}
    </>
  );
}
