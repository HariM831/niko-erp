/**
 * Stations 2 to 5 — the middle of the flow.
 *
 * One queue component serves all four, because the shape of the work is the
 * same everywhere: a list of trucks waiting on you, pick one, make the single
 * decision this station owns. Only the panel on the right changes.
 *
 * The four live on ONE page as tabs rather than four sidebar entries. A truck
 * walks Weigh In → QC → Unloading → Weigh Out in a single visit, so the person
 * following it was navigating away and back four times to watch one vehicle
 * move. The tabs carry a live count each, which is the thing a yard actually
 * wants on screen: where the trucks are piling up, without clicking to find
 * out.
 *
 * Each screen is single-column and stacks on a phone. They are used one-handed
 * in a weighbridge cabin and at an NIR bench, but they are the same components
 * as the rest of EGGSY — no second design system.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { StatusBadge } from "../components/status-badge";

export type Station = "weighbridge" | "qc" | "unloading" | "weigh-out";

/** Tab order is the order a truck meets them. */
export const STATION_ORDER: Station[] = ["weighbridge", "qc", "unloading", "weigh-out"];

export const isStation = (v: string): v is Station =>
  (STATION_ORDER as string[]).includes(v);

export const stationPath = (s: Station) => `/procurement/unloading/${s}`;

const QUEUE_OF: Record<Station, string> = {
  weighbridge: "gross",
  qc: "qc",
  unloading: "unloading",
  "weigh-out": "tare",
};

const TITLE: Record<Station, { title: string; sub: string; empty: string }> = {
  weighbridge: {
    title: "Weigh In",
    sub: "Waiting to be weighed in",
    empty: "No trucks waiting at the platform.",
  },
  qc: { title: "Quality Control", sub: "Weighed, awaiting NIR", empty: "Nothing to sample." },
  unloading: { title: "Unloading", sub: "Cleared by QC", empty: "Nothing cleared for unloading." },
  "weigh-out": {
    title: "Weigh Out",
    sub: "Unloaded, awaiting weigh-out",
    empty: "No trucks waiting to weigh out.",
  },
};

interface QueueRow {
  id: string;
  number: string;
  status: string;
  vehicleNumber: string;
  vendorName: string | null;
  ageMinutes: number;
  lineCount: number;
  lineSummary: string | null;
  linesRejected: number;
  billQuantityKg: string;
  grossWeightKg: string | null;
  vendorSlipGrossKg: string | null;
}

interface ReceiptLine {
  id: string;
  lineNo: number;
  itemName: string | null;
  status: string;
  billQuantityKg: string;
  billBagCount: number | null;
  bagCountActual: number | null;
  allocatedNetKg: string | null;
  qcRejectionReason: string | null;
}

interface Receipt extends QueueRow {
  tareWeightKg: string | null;
  netWeightKg: string | null;
  lines: ReceiptLine[];
}

const kg = (v: string | number | null | undefined) =>
  v == null ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

/** Station 2. Records a fact; judges nothing. */
function GrossPanel({ receipt, done }: { receipt: Receipt; done: () => void }) {
  const [weight, setWeight] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const slip = Number(receipt.vendorSlipGrossKg ?? 0);
  const gross = Number(weight);
  const variance = slip > 0 && gross > 0 ? ((gross - slip) / slip) * 100 : null;
  const needsReason = variance != null && Math.abs(variance) > 0.5;

  const save = useMutation({
    mutationFn: () =>
      api(`/api/procurement/receipts/${receipt.id}/gross-weight`, {
        method: "PATCH",
        body: { grossWeightKg: weight, varianceReason: reason || undefined },
      }),
    onSuccess: done,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not record the weight"),
  });

  return (
    <>
      {error && <Err msg={error} />}
      <Field label="Gross weight from our platform (kg)">
        <input
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          inputMode="decimal"
          className="input text-right text-[18px]"
          autoFocus
        />
      </Field>

      {slip > 0 && (
        <div className="mt-3 rounded-lg bg-gray-50 p-3 text-[12px]">
          <div className="flex justify-between text-gray-600">
            <span>Their slip</span>
            <span className="tabular-nums">{kg(slip)}</span>
          </div>
          {variance != null && (
            <div
              className={`mt-1 flex justify-between font-medium ${needsReason ? "text-amber-600" : "text-green-600"}`}
            >
              <span>Variance</span>
              <span className="tabular-nums">
                {gross - slip > 0 ? "+" : ""}
                {(gross - slip).toFixed(0)} kg · {variance.toFixed(3)}%
              </span>
            </div>
          )}
        </div>
      )}

      {needsReason && (
        <div className="mt-3">
          <Field label="Why is it this far off their slip?">
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="input" />
          </Field>
        </div>
      )}

      <button
        className="btn-primary mt-4 w-full"
        disabled={!(gross > 0) || (needsReason && !reason.trim()) || save.isPending}
        onClick={() => {
          setError(null);
          save.mutate();
        }}
      >
        Record gross → send to QC
      </button>
      <p className="mt-2 text-[12px] text-gray-400">
        Weighing is entry only. No truck or line is refused here.
      </p>
    </>
  );
}

interface QcParam {
  parameter: string;
  label: string;
  direction: "max" | "min";
  target: string | null;
  warnAt: string | null;
  rejectAt: string | null;
}

interface QcJudged {
  verdict: "pass" | "warning" | "rejected" | "no_spec";
  params: Array<{ parameter: string; label: string; verdict: string; detail: string }>;
  missing: string[];
}

interface QcLine {
  id: string;
  lineNo: number;
  itemName: string | null;
  status: string;
  billQuantityKg: string;
  sampleCount: number | null;
  params: QcParam[];
  judged: QcJudged;
}

const VERDICT_STYLE: Record<string, string> = {
  pass: "text-green-600",
  warning: "text-amber-600",
  rejected: "text-red-600",
  no_spec: "text-gray-400",
};

const VERDICT_WORD: Record<string, string> = {
  pass: "within spec",
  warning: "warning",
  rejected: "outside spec",
  no_spec: "no spec",
};

/** The band a technician is aiming at, written the way they would say it. */
function bandOf(p: QcParam): string {
  const parts: string[] = [];
  if (p.target != null) parts.push(`target ${Number(p.target)}`);
  if (p.warnAt != null) parts.push(`flag ${p.direction === "max" ? ">" : "<"} ${Number(p.warnAt)}`);
  if (p.rejectAt != null) parts.push(`reject ${p.direction === "max" ? ">" : "<"} ${Number(p.rejectAt)}`);
  return parts.join(" · ");
}

/**
 * Station 3. Readings in, verdict out.
 *
 * The technician never picks pass or reject — they enter what the instrument
 * said and the spec decides. That keeps a reading and a verdict from ever
 * disagreeing on the same record, which matters because the verdict is what
 * everyone downstream believes.
 *
 * Disagreeing with the spec is still allowed, but it is an override: a reason,
 * the `override` permission, and recorded as an override rather than a pass.
 */
function QcPanel({ receipt, done }: { receipt: Receipt; done: () => void }) {
  const { can } = useAuth();
  const mayOverride = can("procurement", "override");
  const [readings, setReadings] = useState<Record<string, Record<string, string>>>({});
  const [overrides, setOverrides] = useState<Record<string, { verdict: "accept" | "reject"; reason: string }>>({});
  const [manual, setManual] = useState<Record<string, "accept" | "reject">>({});
  const [error, setError] = useState<string | null>(null);

  const { data: ctx } = useQuery<{ lines: QcLine[] }>({
    queryKey: ["procurement", "qc-context", receipt.id],
    queryFn: () => api(`/api/procurement/receipts/${receipt.id}/qc-context`),
  });

  const set = (lineId: string, param: string, value: string) =>
    setReadings((r) => ({ ...r, [lineId]: { ...r[lineId], [param]: value } }));

  const numbersFor = (lineId: string) => {
    const out: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(readings[lineId] ?? {})) out[k] = v === "" ? null : Number(v);
    return out;
  };

  /**
   * The same judgement the server will make, so the bench sees the verdict
   * while typing rather than after committing. The server remains the
   * authority — this only mirrors it.
   */
  const verdictFor = (l: QcLine): { verdict: string; detail: string } => {
    if (!l.params.length) return { verdict: "no_spec", detail: "No quality spec for this material" };
    const vals = numbersFor(l.id);
    const bad: string[] = [];
    let worst: "pass" | "warning" | "rejected" | "no_spec" = "pass";
    for (const p of l.params) {
      const v = vals[p.parameter];
      if (v == null || Number.isNaN(v)) {
        worst = "no_spec";
        bad.push(`${p.label} not measured`);
        continue;
      }
      const beyond = (limit: string | null) =>
        limit == null ? false : p.direction === "max" ? v > Number(limit) : v < Number(limit);
      if (beyond(p.rejectAt)) {
        worst = "rejected";
        bad.push(`${p.label} ${v} ${p.direction === "max" ? "over" : "under"} ${Number(p.rejectAt)}`);
      } else if (beyond(p.warnAt) && worst !== "rejected") {
        if (worst !== "no_spec") worst = "warning";
        bad.push(`${p.label} ${v} past ${Number(p.warnAt)}`);
      }
    }
    return { verdict: worst, detail: bad.join(" · ") || "All readings within spec" };
  };

  const lines = ctx?.lines ?? [];
  const ready = lines.every((l) => {
    const v = verdictFor(l).verdict;
    if (v === "no_spec") return !!manual[l.id] || !!overrides[l.id];
    return true;
  });
  const overridesValid = Object.values(overrides).every((o) => o.reason.trim().length >= 3);
  const acceptedCount = lines.filter((l) => {
    const o = overrides[l.id];
    if (o) return o.verdict === "accept";
    const v = verdictFor(l).verdict;
    if (v === "no_spec") return manual[l.id] === "accept";
    return v !== "rejected";
  }).length;

  const save = useMutation({
    mutationFn: () =>
      api(`/api/procurement/receipts/${receipt.id}/qc`, {
        method: "PATCH",
        body: {
          lines: lines.map((l) => ({
            lineId: l.id,
            readings: numbersFor(l.id),
            override: overrides[l.id],
            manualVerdict: manual[l.id],
            sampleCount: l.sampleCount ?? undefined,
          })),
        },
      }),
    onSuccess: done,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not commit QC"),
  });

  return (
    <>
      {error && <Err msg={error} />}
      <div className="space-y-3">
        {lines.map((l) => {
          const v = verdictFor(l);
          const o = overrides[l.id];
          const finalAccept = o
            ? o.verdict === "accept"
            : v.verdict === "no_spec"
              ? manual[l.id] === "accept"
              : v.verdict !== "rejected";
          return (
            <div key={l.id} className="rounded-lg border border-gray-200 p-3">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[13px] font-medium text-gray-900">{l.itemName}</span>
                <span
                  className={`text-[11px] font-semibold uppercase tracking-wide ${VERDICT_STYLE[v.verdict]}`}
                >
                  {VERDICT_WORD[v.verdict]}
                </span>
              </div>
              <div className="mb-2 text-[11px] text-gray-400">
                {kg(l.billQuantityKg)}
                {l.sampleCount ? ` · ${l.sampleCount} samples` : ""}
              </div>

              {l.params.length === 0 ? (
                <>
                  <p className="mb-2 text-[12px] text-gray-500">
                    No quality spec on file for this material — judge it by hand.
                  </p>
                  <div className="flex gap-2">
                    {(["accept", "reject"] as const).map((choice) => (
                      <button
                        key={choice}
                        onClick={() => setManual((m) => ({ ...m, [l.id]: choice }))}
                        className={`flex-1 rounded-md border px-2 py-1 text-[12px] capitalize ${
                          manual[l.id] === choice
                            ? choice === "accept"
                              ? "border-green-600 bg-green-50 text-green-700"
                              : "border-red-600 bg-red-50 text-red-700"
                            : "border-gray-200 text-gray-600"
                        }`}
                      >
                        {choice}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    {l.params.map((p) => (
                      <div key={p.parameter}>
                        <label className="label mb-0.5">{p.label}</label>
                        <input
                          value={readings[l.id]?.[p.parameter] ?? ""}
                          onChange={(e) => set(l.id, p.parameter, e.target.value)}
                          inputMode="decimal"
                          className="input text-right"
                        />
                        <div className="mt-0.5 text-[10px] leading-tight text-gray-400">{bandOf(p)}</div>
                      </div>
                    ))}
                  </div>
                  <p className={`text-[12px] ${VERDICT_STYLE[v.verdict]}`}>{v.detail}</p>
                </>
              )}

              {/* Disagreeing with the spec is possible, but never silent — and
                  only offered to someone who may actually do it. The server
                  refuses an override without the permission either way; showing
                  the checkbox to an operator who cannot use it just means the
                  refusal arrives after they have typed a reason. */}
              {v.verdict !== "no_spec" && mayOverride && (
                <div className="mt-2 border-t border-gray-100 pt-2">
                  <label className="flex items-center gap-2 text-[12px] text-gray-600">
                    <input
                      type="checkbox"
                      checked={!!o}
                      onChange={(e) =>
                        setOverrides((s) => {
                          const next = { ...s };
                          if (e.target.checked) {
                            next[l.id] = { verdict: v.verdict === "rejected" ? "accept" : "reject", reason: "" };
                          } else delete next[l.id];
                          return next;
                        })
                      }
                    />
                    {v.verdict === "rejected" ? "Take it anyway" : "Refuse it anyway"}
                  </label>
                  {o && (
                    <input
                      value={o.reason}
                      onChange={(e) =>
                        setOverrides((s) => ({ ...s, [l.id]: { ...s[l.id]!, reason: e.target.value } }))
                      }
                      placeholder="Why are you overriding the spec?"
                      className="input mt-1"
                    />
                  )}
                </div>
              )}

              <div className="mt-2 text-[11px] text-gray-400">
                Will be recorded as{" "}
                <span className={finalAccept ? "text-green-600" : "text-red-600"}>
                  {finalAccept ? "accepted" : "rejected"}
                </span>
                {o ? " by override" : ""}
              </div>
            </div>
          );
        })}
      </div>

      <button
        className="btn-primary mt-4 w-full"
        disabled={!lines.length || !ready || !overridesValid || save.isPending}
        onClick={() => {
          setError(null);
          save.mutate();
        }}
      >
        Confirm QC · {acceptedCount} of {lines.length} accepted
      </button>
      <p className="mt-2 text-[12px] text-gray-400">
        The verdict is computed from the readings, not chosen. Rejected material stays on the truck
        and its order quantity is consumed.
      </p>
    </>
  );
}


/** Station 4. Per line: where it went, how much came off, what was damaged. */
function UnloadingPanel({ receipt, done }: { receipt: Receipt; done: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [bags, setBags] = useState<Record<string, string>>({});
  const [damage, setDamage] = useState<Record<string, string>>({});

  const complete = useMutation({
    mutationFn: (lineId: string) =>
      api(`/api/procurement/receipts/${receipt.id}/lines/${lineId}/unloading`, {
        method: "PATCH",
        body: {
          bagCountActual: bags[lineId] ? Number(bags[lineId]) : undefined,
          damagePercent: damage[lineId] ? Number(damage[lineId]) : undefined,
          complete: true,
        },
      }),
    onSuccess: done,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  return (
    <>
      {error && <Err msg={error} />}
      <div className="space-y-3">
        {receipt.lines.map((l) => {
          const rejected = l.status === "qc_rejected";
          const off = l.status === "unloaded";
          return (
            <div
              key={l.id}
              className={`rounded-lg border p-3 ${rejected ? "border-gray-200 bg-gray-50 opacity-70" : "border-gray-200"}`}
            >
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[13px] font-medium text-gray-900">{l.itemName}</span>
                <StatusBadge status={l.status} />
              </div>
              {rejected ? (
                <p className="text-[12px] text-gray-500">
                  Rejected at QC — stays on the truck. Do not unload.
                </p>
              ) : off ? (
                <p className="text-[12px] text-green-700">
                  Unloaded · {l.bagCountActual ?? "—"} bags
                </p>
              ) : (
                <>
                  <div className="mb-2 flex gap-2">
                    <input
                      value={bags[l.id] ?? String(l.billBagCount ?? "")}
                      onChange={(e) => setBags((b) => ({ ...b, [l.id]: e.target.value }))}
                      placeholder="Bags"
                      inputMode="numeric"
                      className="input w-24 text-right"
                    />
                    <input
                      value={damage[l.id] ?? ""}
                      onChange={(e) => setDamage((d) => ({ ...d, [l.id]: e.target.value }))}
                      placeholder="Damage %"
                      inputMode="decimal"
                      className="input w-28 text-right"
                    />
                    <button
                      className="btn-primary flex-1"
                      disabled={complete.isPending}
                      onClick={() => {
                        setError(null);
                        complete.mutate(l.id);
                      }}
                    >
                      Complete line
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-400">
                    Bags are pre-filled from the bill. Correct it if the physical count differs —
                    the gap is recorded, the expected count is not overwritten.
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Station 5. Tare, then split the net across whatever came off. */
function TarePanel({ receipt, done }: { receipt: Receipt; done: () => void }) {
  const [tare, setTare] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const gross = Number(receipt.grossWeightKg ?? 0);
  const net = tare ? gross - Number(tare) : null;
  const unloaded = receipt.lines.filter((l) => l.status === "unloaded");
  const totalBilled = unloaded.reduce((s, l) => s + Number(l.billQuantityKg), 0);

  // Mirrors the server's pro-rata split so the operator sees the same numbers
  // before committing. The server remains the authority.
  const preview = unloaded.map((l) => ({
    ...l,
    share: net != null && totalBilled > 0 ? (net * Number(l.billQuantityKg)) / totalBilled : 0,
  }));
  const short = preview.some((p) => Number(p.billQuantityKg) - p.share > 100);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/procurement/receipts/${receipt.id}/tare-weight`, {
        method: "PATCH",
        body: { tareWeightKg: tare, allocationMethod: "pro_rata", shortageReason: reason || undefined },
      }),
    onSuccess: done,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not record the tare"),
  });

  return (
    <>
      {error && <Err msg={error} />}
      <Field label="Tare weight from our platform (kg)">
        <input
          value={tare}
          onChange={(e) => setTare(e.target.value)}
          inputMode="decimal"
          className="input text-right text-[18px]"
          autoFocus
        />
      </Field>

      <div className="mt-3 rounded-lg bg-gray-50 p-3 text-[12px]">
        <div className="flex justify-between text-gray-600">
          <span>Gross</span>
          <span className="tabular-nums">{kg(gross)}</span>
        </div>
        <div className="flex justify-between text-gray-600">
          <span>Tare</span>
          <span className="tabular-nums">{tare ? kg(tare) : "—"}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-gray-200 pt-1 font-semibold text-gray-900">
          <span>Net off the truck</span>
          <span className="tabular-nums">{net != null ? kg(net) : "—"}</span>
        </div>
      </div>

      {net != null && net > 0 && (
        <div className="mt-3 space-y-1">
          <div className="label">Allocated across lines · pro rata</div>
          {preview.map((p) => (
            <div key={p.id} className="flex justify-between text-[12px]">
              <span className="text-gray-700">{p.itemName}</span>
              <span className="tabular-nums text-gray-600">
                {kg(p.share)}
                <span className="ml-2 text-gray-400">
                  short {(Number(p.billQuantityKg) - p.share).toFixed(0)}
                </span>
              </span>
            </div>
          ))}
          {receipt.lines
            .filter((l) => l.status === "qc_rejected")
            .map((l) => (
              <div key={l.id} className="flex justify-between text-[12px] text-gray-400">
                <span>{l.itemName}</span>
                <span>Rejected — no share of net</span>
              </div>
            ))}
        </div>
      )}

      {short && (
        <div className="mt-3">
          <Field label="Why is the load short?">
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="input" />
          </Field>
        </div>
      )}

      <button
        className="btn-primary mt-4 w-full"
        disabled={!(net != null && net > 0) || save.isPending}
        onClick={() => {
          setError(null);
          save.mutate();
        }}
      >
        Record gate out
      </button>
    </>
  );
}

function Err({ msg }: { msg: string }) {
  return (
    <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
      {msg}
    </div>
  );
}

/** One station's queue. Called once per tab so every tab can show its count. */
function useQueue(station: Station) {
  return useQuery<QueueRow[]>({
    queryKey: ["procurement", "queue", station],
    queryFn: () => api(`/api/procurement/queue/${QUEUE_OF[station]}`),
    refetchInterval: 30_000,
  });
}

export function StationPage({ station }: { station: Station }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [selected, setSelected] = useState<string | null>(null);
  const meta = TITLE[station];

  // Every queue, every tab — the counts are the point of putting them together.
  const queues: Record<Station, ReturnType<typeof useQueue>> = {
    weighbridge: useQueue("weighbridge"),
    qc: useQueue("qc"),
    unloading: useQueue("unloading"),
    "weigh-out": useQueue("weigh-out"),
  };
  const { data: queue, isLoading } = queues[station];

  const { data: receipt } = useQuery<Receipt>({
    queryKey: ["procurement", "receipt", selected],
    queryFn: () => api(`/api/procurement/receipts/${selected}`),
    enabled: !!selected,
  });

  const done = () => {
    void qc.invalidateQueries({ queryKey: ["procurement"] });
    setSelected(null);
  };

  const go = (s: Station) => {
    // A truck picked at one station is not the truck waiting at the next.
    setSelected(null);
    navigate(stationPath(s));
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-[19px] font-semibold text-gray-900">Unloading</h1>
      <p className="mb-3 text-[13px] text-gray-500">
        Everything between the gate and settlement, in the order a truck meets it.
      </p>

      <div className="mb-4 flex gap-1 border-b border-gray-200" role="tablist">
        {STATION_ORDER.map((s) => {
          const count = queues[s].data?.length ?? 0;
          const active = s === station;
          return (
            <button
              key={s}
              role="tab"
              aria-selected={active}
              onClick={() => go(s)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors ${
                active
                  ? "border-brand-500 font-semibold text-brand-700"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {TITLE[s].title}
              {count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                    active ? "bg-brand-100 text-brand-700" : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-[13px] text-gray-500">{meta.sub}</p>
        <span className="text-[13px] text-gray-400">{queue?.length ?? 0} waiting</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card overflow-hidden">
          {isLoading && <div className="p-4 text-[13px] text-gray-400">Loading…</div>}
          {!isLoading && !queue?.length && (
            <div className="p-6 text-center text-[13px] text-gray-400">{meta.empty}</div>
          )}
          {queue?.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={`block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 ${
                selected === r.id ? "bg-brand-50" : ""
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] font-semibold text-gray-900">{r.vehicleNumber}</span>
                <span className="text-[11px] text-gray-400">{r.ageMinutes}m</span>
              </div>
              <div className="text-[12px] text-gray-500">
                {r.vendorName ?? "Vendor not identified"} · {r.lineCount} line
                {r.lineCount === 1 ? "" : "s"}
                {r.lineSummary ? ` · ${r.lineSummary}` : ""}
              </div>
              <div className="text-[11px] text-gray-400">
                Billed {kg(r.billQuantityKg)}
                {r.linesRejected > 0 && (
                  <span className="ml-2 text-red-600">{r.linesRejected} rejected</span>
                )}
              </div>
            </button>
          ))}
        </div>

        <div className="card p-4">
          {!receipt ? (
            <p className="text-[13px] text-gray-400">Pick a truck from the queue.</p>
          ) : (
            <>
              <div className="mb-3 flex items-baseline justify-between border-b border-gray-100 pb-2">
                <div>
                  <div className="text-[14px] font-semibold text-gray-900">
                    {receipt.vehicleNumber}
                  </div>
                  <div className="font-mono text-[11px] text-gray-400">{receipt.number}</div>
                </div>
                <StatusBadge status={receipt.status} />
              </div>
              {station === "weighbridge" && <GrossPanel receipt={receipt} done={done} />}
              {station === "qc" && <QcPanel receipt={receipt} done={done} />}
              {station === "unloading" && <UnloadingPanel receipt={receipt} done={done} />}
              {station === "weigh-out" && <TarePanel receipt={receipt} done={done} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
