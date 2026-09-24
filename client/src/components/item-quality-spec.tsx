/**
 * The quality spec for one material, on that material's own page.
 *
 * It used to be a screen of its own with a list of every material down the
 * side — a second place to find an item, and one that answered "which material
 * am I looking at" differently from the item page. A spec is a fact ABOUT a
 * material, like its unit or its purchase account, so it belongs where the
 * other facts are.
 *
 * The band bar is the point of this screen. Three numbers in three boxes tell
 * you nothing about whether your limits are sane; a bar showing pass, warning
 * and reject as widths tells you instantly, and makes `direction` obvious —
 * moisture fails to the right, protein fails to the left, and the picture flips.
 *
 * Saving supersedes rather than edits. There is no confirm dialog for that; the
 * button says which version it is about to create, which is the honest way to
 * say it.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import { SearchSelect } from "./search-select";
import { QC_PARAMETERS, qcParameterDef } from "@shared/feed";
import { localYmd } from "../lib/utils";
import { DateInput } from "./date-input";
import { BandStrip } from "./ui/band-strip";
import { specAxis, specBands, specTicks } from "../lib/spec-bands";

interface SpecParam {
  parameter: string;
  label: string | null;
  unit: string | null;
  direction: "max" | "min";
  target: string | null;
  warnAt: string | null;
  rejectAt: string | null;
}

interface Rule {
  id: string;
  name: string;
  parameter: string;
  scope: "line" | "vehicle";
  threshold: string | null;
  itemId: string | null;
  vendorName: string | null;
  describes: string;
}

interface SpecPayload {
  item: { id: string; name: string; unit: string };
  spec: {
    id: string;
    version: number;
    sampleCount: number;
    effectiveFrom: string;
    notes: string | null;
    createdByName: string | null;
  } | null;
  params: SpecParam[];
  history: Array<{
    id: string;
    version: number;
    effectiveFrom: string;
    isActive: boolean;
    createdByName: string | null;
    linesJudged: number;
    summary: string;
  }>;
  rules: Rule[];
}

interface Draft {
  key: string;
  label: string;
  unit: string;
  direction: "max" | "min";
  target: string;
  warnAt: string;
  rejectAt: string;
  /** A parameter that has never been saved may still be renamed. */
  isNew: boolean;
}

const num = (v: string | null | undefined) => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** These four have their own columns on a receipt line; the rest go to JSON. */
const FIRST_CLASS = new Set(["moisture", "protein", "fiber", "fat"]);

const toDraft = (p: SpecParam): Draft => ({
  key: p.parameter,
  label: p.label || p.parameter,
  unit: p.unit ?? "",
  direction: p.direction,
  target: p.target == null ? "" : String(Number(p.target)),
  warnAt: p.warnAt == null ? "" : String(Number(p.warnAt)),
  rejectAt: p.rejectAt == null ? "" : String(Number(p.rejectAt)),
  isNew: false,
});

/** The same ordering the server refuses to save, checked as you type. */
function bandProblem(d: Draft): string | null {
  const seq = [num(d.target), num(d.warnAt), num(d.rejectAt)].filter((v): v is number => v != null);
  if (num(d.warnAt) == null && num(d.rejectAt) == null) return "Needs a warning or a reject limit";
  for (let i = 1; i < seq.length; i++) {
    const ok = d.direction === "max" ? seq[i]! >= seq[i - 1]! : seq[i]! <= seq[i - 1]!;
    if (!ok) {
      return d.direction === "max" ? "Target ≤ warn ≤ reject" : "Target ≥ warn ≥ reject";
    }
  }
  return null;
}

/** The spec's limits as bands and ticks, drawn by the shared BandStrip. */
function BandBar({ d }: { d: Draft }) {
  const ax = specAxis(d);
  if (!ax) {
    return <div className="my-2 h-2.5 rounded bg-gray-100" />;
  }
  return <BandStrip className="mb-2 mt-1" lo={ax.lo} hi={ax.hi} bands={specBands(d, ax)} ticks={specTicks(d)} unit={d.unit} />;
}

export function ItemQualitySpec({ itemId }: { itemId: string }) {
  const qc = useQueryClient();
  const selected = itemId;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sampleCount, setSampleCount] = useState("3");
  const [effectiveFrom, setEffectiveFrom] = useState(() => localYmd());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const { data: detail } = useQuery<SpecPayload>({
    queryKey: ["quality-spec", selected],
    queryFn: () => api(`/api/quality-specs/${selected}`),
    enabled: !!selected,
  });

  // The list arrives specced-first, so the head of it is the material somebody
  // Load the live spec into the draft whenever a different material is picked.
  useEffect(() => {
    if (!detail) return;
    setDrafts(detail.params.map(toDraft));
    setSampleCount(String(detail.spec?.sampleCount ?? 3));
    // Today, not the live spec's date: this field says when the version about
    // to be saved takes effect. Carrying the old date forward would date every
    // successor to whenever its ancestor started, which is never what is meant.
    setEffectiveFrom(localYmd());
    setNotes(detail.spec?.notes ?? "");
    setError(null);
  }, [detail]);

  const save = useMutation({
    mutationFn: () =>
      api<SpecPayload & { savedVersion: number }>(`/api/quality-specs/${selected}`, {
        method: "POST",
        body: {
          sampleCount: Number(sampleCount),
          effectiveFrom,
          notes: notes.trim() || null,
          params: drafts.map((d) => ({
            parameter: d.key,
            label: d.label.trim() || null,
            unit: d.unit.trim() || null,
            direction: d.direction,
            target: d.target.trim() || null,
            warnAt: d.warnAt.trim() || null,
            rejectAt: d.rejectAt.trim() || null,
          })),
        },
      }),
    onSuccess: (r) => {
      setSaved(`Saved as version ${r.savedVersion}`);
      void qc.invalidateQueries({ queryKey: ["quality-spec", selected] });
      void qc.invalidateQueries({ queryKey: ["quality-specs"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  const retire = useMutation({
    mutationFn: () => api(`/api/quality-specs/${selected}`, { method: "DELETE" }),
    onSuccess: () => {
      setSaved("Spec retired — this material is no longer judged");
      void qc.invalidateQueries({ queryKey: ["quality-spec", selected] });
      void qc.invalidateQueries({ queryKey: ["quality-specs"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not retire"),
  });

  const nextVersion = (detail?.spec?.version ?? 0) + 1;
  const rulesFor = (key: string) => detail?.rules.filter((r) => r.parameter === key) ?? [];

  const dirty = useMemo(() => {
    if (!detail) return false;
    // The effective date is not part of this: it defaults to today, so counting
    // it would leave the form permanently dirty and offer to save a version
    // identical to the one already live.
    const current = JSON.stringify(detail.params.map(toDraft));
    return (
      current !== JSON.stringify(drafts) ||
      String(detail.spec?.sampleCount ?? 3) !== sampleCount ||
      (detail.spec?.notes ?? "") !== notes
    );
  }, [detail, drafts, sampleCount, notes]);

  const problems = drafts.map(bandProblem);
  const blocked =
    !drafts.length ||
    problems.some(Boolean) ||
    drafts.some((d) => !d.key) ||
    new Set(drafts.map((d) => d.key)).size !== drafts.length;

  const patch = (i: number, next: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...next } : d)));

  return (
    <>
          {!detail ? (
            <p className="text-[13px] text-gray-400">Pick a material.</p>
          ) : (
            <div className="mx-auto max-w-2xl">
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
                <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b pb-3">
                  <div className="min-w-0">
                    <span className="text-[15px] font-semibold text-gray-900">{detail.item.name}</span>
                    {detail.spec && (
                      <span className="ml-2 text-[13px] text-gray-500">v{detail.spec.version}</span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {detail.spec ? (
                      <span className="whitespace-nowrap rounded bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-800">
                        Active · {formatDate(detail.spec.effectiveFrom)}
                      </span>
                    ) : (
                      <span className="whitespace-nowrap rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                        No spec — QC reports no_spec
                      </span>
                    )}
                    {/* Rare and deliberate, so it sits away from the save button. */}
                    {detail.spec && (
                      <button
                        onClick={() => {
                          setError(null);
                          retire.mutate();
                        }}
                        disabled={retire.isPending}
                        className="text-[11px] text-gray-400 hover:text-red-600"
                      >
                        Retire
                      </button>
                    )}
                  </div>
                </div>

                <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2">
                  {/* `.input` carries w-full and outranks a width utility on the
                      control itself, so widths are set on a wrapper instead. */}
                  <div className="w-20">
                    <div className="label">Samples</div>
                    <input
                      value={sampleCount}
                      onChange={(e) => setSampleCount(e.target.value)}
                      inputMode="numeric"
                      className="input h-8 text-[13px]"
                    />
                  </div>
                  <div className="w-44">
                    <div className="label">
                      {detail.spec ? "New version effective from" : "Effective from"}
                    </div>
                    <DateInput
                      value={effectiveFrom}
                      onChange={(e) => setEffectiveFrom(e.target.value)}
                      className="input h-8 text-[13px]"
                    />
                  </div>
                </div>

                {drafts.map((d, i) => {
                  const problem = problems[i];
                  const rules = rulesFor(d.key);
                  return (
                    <div key={i} className="mb-2 rounded-lg border border-gray-200 p-3">
                      {/* Wraps rather than crushes: four controls need ~350px,
                          and below that the name takes its own line instead of
                          shrinking to a letter and a half. */}
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        {d.isNew ? (
                          <div className="min-w-[140px] flex-1">
                            <SearchSelect
                              value={d.key || null}
                              onChange={(id) => {
                                const key = id ?? "";
                                if (key === d.key) return;
                                const def = qcParameterDef(key);
                                patch(i, {
                                  key,
                                  label: def?.label ?? "",
                                  // The unit and the sensible sense of the test
                                  // come with the parameter; both stay editable.
                                  unit: def?.unit ?? d.unit,
                                  direction: def?.direction ?? d.direction,
                                });
                              }}
                              options={QC_PARAMETERS.filter(
                                (o) => o.key === d.key || !drafts.some((x) => x.key === o.key),
                              ).map((o) => ({ id: o.key, label: o.label }))}
                              placeholder="Choose a parameter…"
                              keepOrder
                              className="w-full"
                              buttonClassName="input h-8 py-0 text-[13px] font-medium"
                            />
                          </div>
                        ) : (
                          /* Frozen once saved: the key is what a lab reading and
                             a deduction rule are matched on. */
                          <div
                            className="min-w-[140px] flex-1 text-[13px] font-medium text-gray-900"
                            title={qcParameterDef(d.key)?.hint}
                          >
                            {d.label || d.key}
                          </div>
                        )}
                        {/* Printed on the purchase order beside the limit, so a
                            vendor reads "Max 14%" and not a bare 14. */}
                        <div className="w-14 shrink-0">
                          <input
                            value={d.unit}
                            placeholder="%"
                            title="Unit — %, ppb, mg/kg"
                            onChange={(e) => patch(i, { unit: e.target.value })}
                            className="input h-8 px-1 text-center text-[12px]"
                          />
                        </div>
                        <SearchSelect
                          value={d.direction}
                          onChange={(id) => {
                            if (id && id !== d.direction) patch(i, { direction: id as "max" | "min" });
                          }}
                          options={[
                            { id: "max", label: "fails above" },
                            { id: "min", label: "fails below" },
                          ]}
                          allowClear={false}
                          keepOrder
                          className="w-28 shrink-0"
                          buttonClassName="input h-8 px-1 py-0 text-[12px]"
                        />
                        <button
                          onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}
                          title="Remove parameter"
                          className="text-gray-300 hover:text-red-600"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>

                      <BandBar d={d} />

                      <div className="grid grid-cols-3 gap-2">
                        {(
                          [
                            ["target", "Target", "text-gray-400", "border-gray-300"],
                            ["warnAt", "Warn", "text-amber-700", "border-amber-300"],
                            ["rejectAt", "Reject", "text-red-700", "border-red-300"],
                          ] as const
                        ).map(([field, label, tone, edge]) => (
                          <div key={field}>
                            <div className={`text-[10px] font-semibold uppercase tracking-wide ${tone}`}>
                              {label}
                            </div>
                            <input
                              value={d[field]}
                              onChange={(e) => patch(i, { [field]: e.target.value } as Partial<Draft>)}
                              inputMode="decimal"
                              className={`input h-8 w-full text-[13px] ${edge}`}
                            />
                          </div>
                        ))}
                      </div>

                      <div className="mt-2 border-t border-gray-100 pt-1.5 text-[11px]">
                        {problem ? (
                          <span className="text-red-600">{problem}</span>
                        ) : rules.length ? (
                          rules.map((r) => (
                            <div key={r.id} className="text-gray-500">
                              ↳ {r.describes}
                              {r.itemId == null && (
                                <span className="ml-1 text-gray-400">· applies to every material</span>
                              )}
                            </div>
                          ))
                        ) : (
                          <span className="text-gray-400">
                            ↳ No deduction rule — a fail rejects the line, it does not reduce the price
                          </span>
                        )}
                        <div className="mt-0.5 font-mono text-[10px] text-gray-300">
                          {d.key || "—"}
                          {!FIRST_CLASS.has(d.key) && d.key ? " · stored as an extra reading" : ""}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="mt-3 flex items-center justify-between">
                  <button
                    onClick={() =>
                      setDrafts((ds) => {
                        // Open on the next parameter nobody has used, so the
                        // common path is add-and-type-numbers rather than
                        // add-then-pick-then-type.
                        const next = QC_PARAMETERS.find((o) => !ds.some((x) => x.key === o.key));
                        return [
                          ...ds,
                          {
                            key: next?.key ?? "",
                            label: next?.label ?? "",
                            unit: next?.unit ?? "%",
                            direction: next?.direction ?? "max",
                            target: "",
                            warnAt: "",
                            rejectAt: "",
                            isNew: true,
                          },
                        ];
                      })
                    }
                    disabled={drafts.length >= QC_PARAMETERS.length}
                    className="flex shrink-0 items-center gap-1 text-[13px] text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-gray-300 disabled:no-underline"
                    title={
                      drafts.length >= QC_PARAMETERS.length
                        ? "Every quality parameter is already on this spec"
                        : undefined
                    }
                  >
                    <Plus size={14} /> Add parameter
                  </button>
                  <button
                    onClick={() => {
                      setError(null);
                      setSaved(null);
                      save.mutate();
                    }}
                    disabled={blocked || !dirty || save.isPending}
                    className="btn-primary shrink-0 whitespace-nowrap"
                  >
                    Save as version {nextVersion}
                  </button>
                </div>
              </div>

              {detail.history.length > 0 && (
                <div className="card mt-4 p-5">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="label">Version history</span>
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">warn / reject</span>
                  </div>
                  {detail.history.map((h) => (
                    <div
                      key={h.id}
                      className="border-b border-gray-100 py-1.5 text-[12px] last:border-0"
                    >
                      {/* Two lines rather than one squeezed row: the bands are the
                          interesting part and must not be clipped by the metadata. */}
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="shrink-0 font-medium text-gray-900">
                          v{h.version}
                          {h.isActive && <span className="ml-1.5 text-[11px] text-green-700">active</span>}
                        </span>
                        <span className="truncate text-right text-[11px] text-gray-400">
                          {formatDate(h.effectiveFrom)} · {h.createdByName ?? "—"} · {h.linesJudged}{" "}
                          line{h.linesJudged === 1 ? "" : "s"} judged
                        </span>
                      </div>
                      <div className="truncate text-gray-500">{h.summary}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
    </>
  );
}
