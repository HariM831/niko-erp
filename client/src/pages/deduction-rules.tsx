/**
 * Deduction Rules — what a reading costs a vendor.
 *
 * A Settings section rather than a screen of its own: this is policy that is
 * written once and read by every truck, not work anybody does during a shift.
 * It stacks — table above, editor below — because Settings already spends a
 * rail on its own navigation and a second one leaves nothing to edit in.
 *
 * The worked example is the point of this screen. "1% of line value per point
 * over 14" is a sentence anyone can nod at and nobody can check; "on 24,290 kg
 * at ₹23.10 a reading of 15.1 takes off ₹6,172.09" is a number you can argue
 * with. It comes from the server running the real `computeDeductions`, not from
 * arithmetic repeated here, so the preview cannot drift from what settlement
 * will actually charge.
 *
 * Saving supersedes rather than edits, as a spec does. Past credit notes are
 * unaffected either way — each carries its own arithmetic in writing — but the
 * sequence of versions is the record of when policy changed.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { ApiError, api, formatDate } from "../api";
import { Banner, EmptyRow, SettingsHeader, SettingsTable } from "../components/settings-ui";

type Basis = "pct_of_value" | "per_point_per_kg" | "shortfall_value" | "flat";

interface Rule {
  id: string;
  name: string;
  parameter: string;
  direction: "max" | "min";
  scope: "line" | "vehicle";
  basis: Basis;
  itemId: string | null;
  vendorId: string | null;
  threshold: string | null;
  ratePerPoint: string | null;
  flatAmount: string | null;
  minAmount: string | null;
  version: number;
  effectiveFrom: string;
  isActive: boolean;
  itemName: string | null;
  vendorName: string | null;
  createdByName: string | null;
  describes: string;
  specificity: number;
  /** What this version has taken off vendors, now that credit lines record it. */
  charged: { lines: number; total: string };
}

interface ParamOption {
  parameter: string;
  label: string;
  source: string;
}
interface Targets {
  materials: Array<{ id: string; name: string }>;
  vendors: Array<{ id: string; name: string }>;
}

interface Draft {
  id: string | null;
  name: string;
  parameter: string;
  direction: "max" | "min";
  scope: "line" | "vehicle";
  basis: Basis;
  itemId: string;
  vendorId: string;
  threshold: string;
  ratePerPoint: string;
  flatAmount: string;
  minAmount: string;
  effectiveFrom: string;
}

const BASES: Array<{ key: Basis; label: string; needs: keyof Draft | null }> = [
  { key: "pct_of_value", label: "1% of line value per point", needs: null },
  { key: "per_point_per_kg", label: "₹ per kg, per point", needs: "ratePerPoint" },
  { key: "shortfall_value", label: "the shortfall × the line rate", needs: null },
  { key: "flat", label: "a flat amount", needs: "flatAmount" },
];

const today = () => new Date().toISOString().slice(0, 10);

const blank = (): Draft => ({
  id: null,
  name: "",
  parameter: "",
  direction: "max",
  scope: "line",
  basis: "pct_of_value",
  itemId: "",
  vendorId: "",
  threshold: "",
  ratePerPoint: "",
  flatAmount: "",
  minAmount: "",
  effectiveFrom: today(),
});

const toDraft = (r: Rule): Draft => ({
  id: r.id,
  name: r.name,
  parameter: r.parameter,
  direction: r.direction,
  scope: r.scope,
  basis: r.basis,
  itemId: r.itemId ?? "",
  vendorId: r.vendorId ?? "",
  threshold: r.threshold == null ? "" : String(Number(r.threshold)),
  ratePerPoint: r.ratePerPoint == null ? "" : String(Number(r.ratePerPoint)),
  flatAmount: r.flatAmount == null ? "" : String(Number(r.flatAmount)),
  minAmount: r.minAmount == null ? "" : String(Number(r.minAmount)),
  effectiveFrom: today(),
});

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Numbers travel as strings, and an empty box means "not set", not zero. */
const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

export function DeductionRulesSection() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The line the worked example is charged against — bill 518's real figures,
  // so the number on screen is one somebody has seen before.
  const [sample, setSample] = useState({ reading: "15.1", netKg: "24290", ratePerKg: "23.1" });

  const { data: rules } = useQuery<Rule[]>({
    queryKey: ["deduction-rules", showRetired],
    queryFn: () => api(`/api/deduction-rules?includeRetired=${showRetired}`),
  });
  const { data: params } = useQuery<ParamOption[]>({
    queryKey: ["deduction-rule-parameters"],
    queryFn: () => api("/api/deduction-rules/parameters"),
  });
  const { data: targets } = useQuery<Targets>({
    queryKey: ["deduction-rule-targets"],
    queryFn: () => api("/api/deduction-rules/targets"),
  });

  /**
   * A reading one point past where the rule starts biting.
   *
   * A fixed default would misrepresent half the rules: 15.1 is a fair moisture
   * figure and a catastrophic damage figure, and the example is only worth
   * anything if it shows a load somebody might actually see.
   */
  const sampleFor = (r: Rule) => {
    const t = r.threshold == null ? 0 : Number(r.threshold);
    const step = Math.max(1, Math.abs(t) * 0.1);
    return String(Number((r.direction === "max" ? t + step : t - step).toFixed(3)));
  };

  const pick = (r: Rule) => {
    setDraft(toDraft(r));
    setSample((s) => ({ ...s, reading: sampleFor(r) }));
    setError(null);
    setSaved(null);
  };

  useEffect(() => {
    if (!draft && rules?.length) pick(rules[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, draft]);

  const set = (next: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...next } : d));

  const body = draft && {
    name: draft.name,
    parameter: draft.parameter,
    direction: draft.direction,
    scope: draft.scope,
    basis: draft.basis,
    itemId: orNull(draft.itemId),
    vendorId: orNull(draft.vendorId),
    threshold: orNull(draft.threshold),
    ratePerPoint: orNull(draft.ratePerPoint),
    flatAmount: orNull(draft.flatAmount),
    minAmount: orNull(draft.minAmount),
    effectiveFrom: draft.effectiveFrom,
  };

  // Enough of a rule to be worth pricing. Without a parameter the preview has
  // nothing to read and the server would refuse it anyway.
  const previewable =
    !!draft &&
    /^[a-z][a-z0-9_]{0,29}$/.test(draft.parameter) &&
    Number.isFinite(Number(sample.netKg)) &&
    Number(sample.netKg) > 0 &&
    Number(sample.ratePerKg) > 0 &&
    Number.isFinite(Number(sample.reading));

  const previewKey = JSON.stringify([body, sample]);
  const { data: preview } = useQuery<{
    amount: number;
    basis: string | null;
    fired: boolean;
    describes: string;
  }>({
    queryKey: ["deduction-rule-preview", previewKey],
    queryFn: () =>
      api("/api/deduction-rules/preview", {
        method: "POST",
        body: {
          ...body,
          name: body!.name || "Draft",
          effectiveFrom: body!.effectiveFrom || today(),
          reading: Number(sample.reading),
          netKg: Number(sample.netKg),
          ratePerKg: Number(sample.ratePerKg),
        },
      }),
    enabled: previewable,
  });

  const save = useMutation({
    mutationFn: () =>
      api<Rule>(draft!.id ? `/api/deduction-rules/${draft!.id}` : "/api/deduction-rules", {
        method: "POST",
        body,
      }),
    onSuccess: (r) => {
      setSaved(r.version > 1 ? `${r.name} saved as version ${r.version}` : `${r.name} created`);
      setDraft(toDraft(r));
      void qc.invalidateQueries({ queryKey: ["deduction-rules"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  const retire = useMutation({
    mutationFn: () => api(`/api/deduction-rules/${draft!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setSaved("Rule retired — this reading no longer costs anything");
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ["deduction-rules"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not retire"),
  });

  const basisNeeds = BASES.find((b) => b.key === draft?.basis)?.needs ?? null;
  const blocked =
    !draft ||
    !draft.name.trim() ||
    !/^[a-z][a-z0-9_]{0,29}$/.test(draft.parameter) ||
    (basisNeeds != null && !String(draft[basisNeeds]).trim());

  /**
   * Rules that would compete with this one. Only one rule per parameter is ever
   * applied, so an overlap is not additive — the narrower rule silently wins,
   * and the wider one stops charging anything for that material.
   */
  const overlaps = useMemo(() => {
    if (!draft || !rules) return [];
    const myItem = orNull(draft.itemId);
    const myVendor = orNull(draft.vendorId);
    const mySpecificity = (myItem ? 2 : 0) + (myVendor ? 1 : 0);
    // Two rules overlap when some delivery would match both: on each dimension
    // either one casts no net, or they name the same thing.
    const shares = (a: string | null, b: string | null) => a == null || b == null || a === b;
    return rules.filter(
      (r) =>
        r.isActive &&
        r.id !== draft.id &&
        r.parameter === draft.parameter &&
        r.specificity !== mySpecificity &&
        shares(r.itemId, myItem) &&
        shares(r.vendorId, myVendor),
    );
  }, [draft, rules]);

  const live = rules?.filter((r) => r.isActive) ?? [];
  const retired = rules?.filter((r) => !r.isActive) ?? [];

  const Row = ({ r }: { r: Rule }) => (
    <tr
      onClick={() => pick(r)}
      className={`row-hover cursor-pointer border-b border-[#ebeaf2] ${
        draft?.id === r.id ? "bg-brand-50" : ""
      } ${r.isActive ? "" : "text-gray-400"}`}
    >
      <td className="px-3 py-2 text-[13px] font-medium">
        {r.name}
        {r.version > 1 && <span className="ml-1.5 text-[11px] text-gray-400">v{r.version}</span>}
        {!r.isActive && <span className="ml-1.5 text-[11px] text-gray-400">retired</span>}
      </td>
      <td className="px-3 py-2 text-[12px] text-gray-600">
        {r.parameter} {r.direction === "max" ? "over" : "under"}{" "}
        {r.threshold == null ? "—" : Number(r.threshold)}
      </td>
      <td className="px-3 py-2 text-[12px] text-gray-600">
        {r.itemName ?? "every material"}
        {r.vendorName ? ` · ${r.vendorName}` : ""}
        {r.scope === "vehicle" && (
          <span className="ml-1.5 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] text-brand-700">
            per truck
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-[12px] text-gray-600">{r.describes}</td>
    </tr>
  );

  return (
    <div>
      <SettingsHeader
        title="Deduction Rules"
        description="What a reading costs a vendor — separate from the quality spec, which only decides whether we take the load."
        actions={
          <button
            onClick={() => {
              setDraft(blank());
              setError(null);
              setSaved(null);
            }}
            className="btn-secondary flex items-center gap-1"
          >
            <Plus size={14} /> New rule
          </button>
        }
      />

      {saved && <Banner tone="success">{saved}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      {/* Four columns need about 620px. Below that they scroll rather than
          crush — a rule whose charge is cut off is worse than one you scroll to. */}
      <div className="overflow-x-auto">
        <div className="min-w-[620px]">
          <SettingsTable
            columns={[
              { label: "Rule", width: "w-[22%]" },
              { label: "Reads", width: "w-[18%]" },
              { label: "Applies to", width: "w-[26%]" },
              { label: "Charges" },
            ]}
          >
            {!live.length && <EmptyRow colSpan={4}>No deduction rules yet.</EmptyRow>}
            {live.map((r) => (
              <Row key={r.id} r={r} />
            ))}
            {showRetired && retired.map((r) => <Row key={r.id} r={r} />)}
          </SettingsTable>
        </div>
      </div>

      <button
        onClick={() => setShowRetired((s) => !s)}
        className="mt-2 text-[11px] text-gray-400 hover:text-gray-700"
      >
        {showRetired ? "Hide" : "Show"} retired versions
      </button>

      {draft && (
        <div className="mt-6 max-w-2xl">
              <div className="card p-5">
                <div className="mb-3">
                  <div className="label">Rule name</div>
                  <input
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                    placeholder="Moisture over 14%"
                    className="input h-9 text-[14px] font-medium"
                  />
                </div>

                <div className="label">Reads</div>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="w-44">
                    <select
                      value={draft.parameter}
                      onChange={(e) => set({ parameter: e.target.value })}
                      className="input h-8 text-[13px]"
                    >
                      <option value="">Choose a reading…</option>
                      {params?.map((p) => (
                        <option key={p.parameter} value={p.parameter}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-28">
                    <select
                      value={draft.direction}
                      onChange={(e) => set({ direction: e.target.value as "max" | "min" })}
                      className="input h-8 px-1 text-[12px]"
                    >
                      <option value="max">over</option>
                      <option value="min">under</option>
                    </select>
                  </div>
                  <div className="w-24">
                    <input
                      value={draft.threshold}
                      onChange={(e) => set({ threshold: e.target.value })}
                      inputMode="decimal"
                      placeholder="14"
                      className="input h-8 text-[13px]"
                    />
                  </div>
                  {draft.parameter && (
                    <span className="text-[11px] text-gray-400">
                      from {params?.find((p) => p.parameter === draft.parameter)?.source ?? "—"}
                    </span>
                  )}
                </div>

                <div className="label">Charges</div>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="w-56">
                    <select
                      value={draft.basis}
                      onChange={(e) => set({ basis: e.target.value as Basis })}
                      className="input h-8 text-[13px]"
                    >
                      {BASES.map((b) => (
                        <option key={b.key} value={b.key}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {basisNeeds === "ratePerPoint" && (
                    <div className="w-28">
                      <input
                        value={draft.ratePerPoint}
                        onChange={(e) => set({ ratePerPoint: e.target.value })}
                        inputMode="decimal"
                        placeholder="₹ / point / kg"
                        className="input h-8 text-[13px]"
                      />
                    </div>
                  )}
                  {basisNeeds === "flatAmount" && (
                    <div className="w-28">
                      <input
                        value={draft.flatAmount}
                        onChange={(e) => set({ flatAmount: e.target.value })}
                        inputMode="decimal"
                        placeholder="₹ amount"
                        className="input h-8 text-[13px]"
                      />
                    </div>
                  )}
                  <div className="w-32">
                    <input
                      value={draft.minAmount}
                      onChange={(e) => set({ minAmount: e.target.value })}
                      inputMode="decimal"
                      placeholder="min ₹ (optional)"
                      className="input h-8 text-[12px]"
                    />
                  </div>
                </div>

                <div className="label">Applies to</div>
                <div className="mb-1 flex flex-wrap gap-2">
                  <div className="w-52">
                    <select
                      value={draft.itemId}
                      onChange={(e) => set({ itemId: e.target.value })}
                      className="input h-8 text-[13px]"
                    >
                      <option value="">Every material</option>
                      {targets?.materials.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-52">
                    <select
                      value={draft.vendorId}
                      onChange={(e) => set({ vendorId: e.target.value })}
                      className="input h-8 text-[13px]"
                    >
                      <option value="">Every vendor</option>
                      {targets?.vendors.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-36">
                    <select
                      value={draft.scope}
                      onChange={(e) => set({ scope: e.target.value as "line" | "vehicle" })}
                      className="input h-8 text-[12px]"
                    >
                      <option value="line">once per material</option>
                      <option value="vehicle">once per truck</option>
                    </select>
                  </div>
                </div>
                <p className="mb-3 text-[11px] text-gray-400">
                  Per truck means one allowance for the whole trip, however many materials are aboard —
                  which is what a weight shortage is. Everything measured in a lab is per material.
                </p>

                {overlaps.length > 0 && (
                  <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                    Only one rule per reading is ever applied, and the narrower one wins. This overlaps{" "}
                    {overlaps.map((o) => `“${o.name}”`).join(", ")} — where both could apply, only one
                    will charge.
                  </div>
                )}

                {/* The whole argument for this screen. */}
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    On a load like this
                  </div>
                  <div className="mb-2 flex flex-wrap items-end gap-2">
                    {(
                      [
                        ["reading", draft.parameter || "reading", "w-24"],
                        ["netKg", "net kg", "w-28"],
                        ["ratePerKg", "₹ / kg", "w-24"],
                      ] as const
                    ).map(([field, label, w]) => (
                      <div key={field} className={w}>
                        <div className="text-[10px] text-gray-400">{label}</div>
                        <input
                          value={sample[field]}
                          onChange={(e) => setSample((s) => ({ ...s, [field]: e.target.value }))}
                          inputMode="decimal"
                          className="input h-7 bg-white text-[12px]"
                        />
                      </div>
                    ))}
                  </div>
                  {!previewable ? (
                    <p className="text-[12px] text-gray-400">
                      Choose a reading to see what this would charge.
                    </p>
                  ) : preview?.fired ? (
                    <>
                      <div className="text-[18px] font-semibold text-amber-700">
                        −{inr(preview.amount)}
                      </div>
                      <div className="text-[11px] text-gray-500">{preview.basis}</div>
                    </>
                  ) : (
                    <div className="text-[13px] text-gray-500">
                      Nothing deducted — this reading is inside the threshold.
                    </div>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="w-44">
                    <div className="label">
                      {draft.id ? "New version effective from" : "Effective from"}
                    </div>
                    <input
                      type="date"
                      value={draft.effectiveFrom}
                      onChange={(e) => set({ effectiveFrom: e.target.value })}
                      className="input h-8 text-[13px]"
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {draft.id && (
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
                    <button
                      onClick={() => {
                        setError(null);
                        setSaved(null);
                        save.mutate();
                      }}
                      disabled={blocked || save.isPending}
                      className="btn-primary whitespace-nowrap"
                    >
                      {draft.id
                        ? `Save as version ${(rules?.find((r) => r.id === draft.id)?.version ?? 1) + 1}`
                        : "Create rule"}
                    </button>
                  </div>
                </div>
              </div>

              {draft.id && (
                <p className="mt-3 px-1 text-[11px] text-gray-400">
                  Saving retires this version and raises the next. Credit notes already issued are
                  untouched — each one carries its own arithmetic in writing, so a past deduction stays
                  explicable whatever happens to the rule that made it.
                </p>
              )}

              {rules && draft.parameter && (
                <div className="card mt-4 p-5">
                  <div className="label mb-2">Every rule that reads {draft.parameter}</div>
                  {rules
                    .filter((r) => r.parameter === draft.parameter)
                    .map((r) => (
                      <div
                        key={r.id}
                        className="border-b border-gray-100 py-1.5 text-[12px] last:border-0"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className={r.isActive ? "text-gray-900" : "text-gray-400 line-through"}>
                            {r.name} <span className="text-gray-400">v{r.version}</span>
                          </span>
                          <span className="shrink-0 text-[11px] text-gray-400">
                            {formatDate(r.effectiveFrom)} · {r.createdByName ?? "—"}
                          </span>
                        </div>
                        <div className="truncate text-gray-500">
                          {r.itemName ?? "every material"} · {r.vendorName ?? "every vendor"} ·{" "}
                          {r.describes}
                        </div>
                        <div className="text-[11px] text-gray-400">
                          {r.charged.lines === 0
                            ? "has charged nothing"
                            : `charged ${inr(Number(r.charged.total))} across ${r.charged.lines} deduction${
                                r.charged.lines === 1 ? "" : "s"
                              }`}
                        </div>
                      </div>
                    ))}
                </div>
              )}
        </div>
      )}
    </div>
  );
}
