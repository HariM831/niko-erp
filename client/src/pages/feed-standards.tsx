/**
 * Feed Standards — the window a mix has to land in, stage by stage.
 *
 * A Settings section: standards are policy the formulator reads, not work
 * anybody does during a shift. One grid per stage — a row per nutrient, min and
 * max — and saving supersedes, because a formula solved last March has to stay
 * readable against March's standard.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, formatDate } from "../api";
import { Banner, SettingsHeader } from "../components/settings-ui";
import { LIFE_STAGES, LIFE_STAGE_LABELS, NUTRIENTS, nutrientLabel, type LifeStage } from "@shared/feed";

interface StageRow {
  stage: LifeStage;
  active: {
    version: number;
    effectiveFrom: string;
    params: Array<{ nutrient: string; minValue: string | null; maxValue: string | null }>;
  } | null;
  history: Array<{
    version: number;
    effectiveFrom: string;
    isActive: boolean;
    createdByName: string | null;
    paramCount: number;
  }>;
}

interface Draft {
  min: string;
  max: string;
}

const numOrEmpty = (v: string | null | undefined) => (v == null ? "" : String(Number(v)));

export function FeedStandardsSection() {
  const qc = useQueryClient();
  const [stage, setStage] = useState<LifeStage>("layer_1");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const { data } = useQuery<StageRow[]>({
    queryKey: ["feed-standards"],
    queryFn: () => api("/api/feed/standards"),
  });
  const current = data?.find((s) => s.stage === stage);

  useEffect(() => {
    const next: Record<string, Draft> = {};
    for (const p of current?.active?.params ?? []) {
      next[p.nutrient] = { min: numOrEmpty(p.minValue), max: numOrEmpty(p.maxValue) };
    }
    setDrafts(next);
    setError(null);
  }, [current]);

  const set = (key: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [key]: { min: "", max: "", ...d[key], ...patch } }));

  const save = useMutation({
    mutationFn: () => {
      const params = NUTRIENTS.flatMap((n) => {
        const d = drafts[n.key];
        const min = d?.min.trim() ?? "";
        const max = d?.max.trim() ?? "";
        if (!min && !max) return [];
        return [{ nutrient: n.key, minValue: min || null, maxValue: max || null }];
      });
      return api<{ savedVersion: number }>(`/api/feed/standards/${stage}`, {
        method: "POST",
        body: { effectiveFrom: new Date().toISOString().slice(0, 10), params },
      });
    },
    onSuccess: (r) => {
      setSaved(`${LIFE_STAGE_LABELS[stage]} saved as version ${r.savedVersion}`);
      void qc.invalidateQueries({ queryKey: ["feed-standards"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  // The same refusals the server makes, said before the round trip.
  const problems = NUTRIENTS.flatMap((n) => {
    const d = drafts[n.key];
    if (!d) return [];
    const min = d.min.trim() === "" ? null : Number(d.min);
    const max = d.max.trim() === "" ? null : Number(d.max);
    if (min != null && max != null && min > max) {
      return [`${n.label}: min ${min} is above max ${max}`];
    }
    return [];
  });
  const anySet = Object.values(drafts).some((d) => d.min.trim() !== "" || d.max.trim() !== "");

  return (
    <div>
      <SettingsHeader
        title="Feed Standards"
        description="The nutrient window each life stage's feed has to land in. The formulator solves inside these bounds."
      />
      {saved && <Banner tone="success">{saved}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      <div className="mb-4 flex flex-wrap gap-1">
        {LIFE_STAGES.map((s) => {
          const row = data?.find((x) => x.stage === s);
          return (
            <button
              key={s}
              onClick={() => {
                setStage(s);
                setSaved(null);
              }}
              className={`rounded-md px-2.5 py-1 text-[12px] ${
                stage === s
                  ? "bg-brand-500 font-medium text-white"
                  : row?.active
                    ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    : "bg-gray-50 text-gray-400 hover:bg-gray-100"
              }`}
            >
              {LIFE_STAGE_LABELS[s]}
              {row?.active ? ` · v${row.active.version}` : ""}
            </button>
          );
        })}
      </div>

      <div className="max-w-xl">
        <table className="w-full">
          <thead>
            <tr>
              <th className="s-th">Nutrient</th>
              <th className="s-th w-28 text-right">Min</th>
              <th className="s-th w-28 text-right">Max</th>
            </tr>
          </thead>
          <tbody>
            {NUTRIENTS.map((n) => {
              const d = drafts[n.key];
              return (
                <tr key={n.key} className="border-b border-[#ebeaf2]">
                  <td className="px-3 py-1.5 text-[13px]">{nutrientLabel(n.key)}</td>
                  <td className="px-3 py-1">
                    <input
                      value={d?.min ?? ""}
                      onChange={(e) => set(n.key, { min: e.target.value })}
                      inputMode="decimal"
                      placeholder="—"
                      className="input h-7 text-right text-[12px]"
                    />
                  </td>
                  <td className="px-3 py-1">
                    <input
                      value={d?.max ?? ""}
                      onChange={(e) => set(n.key, { max: e.target.value })}
                      inputMode="decimal"
                      placeholder="—"
                      className="input h-7 text-right text-[12px]"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {problems.length > 0 && (
          <p className="mt-2 text-[12px] text-red-600">{problems.join(" · ")}</p>
        )}

        <div className="mt-3 flex items-center justify-between">
          <p className="max-w-sm text-[11px] text-gray-400">
            Blank rows are left out of the standard. Saving supersedes — a formula solved against an
            older version stays readable under it.
          </p>
          <button
            onClick={() => {
              setSaved(null);
              setError(null);
              save.mutate();
            }}
            disabled={!anySet || problems.length > 0 || save.isPending}
            className="btn-primary shrink-0"
          >
            Save as version {(current?.history[0]?.version ?? 0) + 1}
          </button>
        </div>

        {current && current.history.length > 0 && (
          <div className="mt-5 border-t pt-3">
            <div className="label mb-1">Version history</div>
            {current.history.map((h) => (
              <div key={h.version} className="flex justify-between border-b border-gray-100 py-1 text-[12px] last:border-0">
                <span>
                  v{h.version}
                  {h.isActive && <span className="ml-1.5 text-[11px] text-green-700">active</span>}
                  <span className="ml-2 text-gray-500">{h.paramCount} nutrient{h.paramCount === 1 ? "" : "s"}</span>
                </span>
                <span className="text-[11px] text-gray-400">
                  {formatDate(h.effectiveFrom)} · {h.createdByName ?? "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
