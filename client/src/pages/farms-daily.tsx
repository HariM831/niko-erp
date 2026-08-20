/**
 * Daily records — every house, one day, one screen.
 *
 * The form inside each house is ported field-for-field from the farm's own app:
 * the same four groups (Birds, Water, Feed, Eggs), the same inputs, and the same
 * figures computed underneath each group — opening and closing birds, total
 * water and water per bird, feed per bird, egg percent. The people filling this
 * in every morning already know that form, and the data migrating across was
 * recorded through it.
 *
 * Two deliberate departures, both decided by the farm:
 *  - **Transferred in / out are not here.** Moving birds between houses is a set
 *    of dated lines on the flock page, so it has one home rather than two.
 *  - **Feed delivered is not typed.** It is the mill's transfer into this house,
 *    which already exists as a stock movement with a cost on it. Shown, not
 *    entered — a second hand-keyed number would be a second answer.
 *
 * Sized for a phone in a shed: 44px touch targets, one column on small screens,
 * and houses already entered collapse so the ones still needing attention are
 * what fills the screen.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import { ApiError, api } from "../api";
import { HOUSE_PURPOSE_LABELS, type HousePurpose } from "@shared/schema/farms";

const today = () => new Date().toISOString().slice(0, 10);
const n = (v: number) => v.toLocaleString("en-IN");
const num = (v: string) => (v.trim() === "" ? 0 : Number(v) || 0);

interface Loss {
  kind: "mortality" | "cull" | "male_removal";
  qty: number;
  causeCode?: string | null;
  note?: string | null;
}

interface Row {
  placementId: string;
  houseCode: string;
  housePurpose: HousePurpose;
  locationName: string;
  flockId: string;
  flockCode: string;
  age: { label: string; weeks: number };
  birds: number;
  openingBirds: number;
  feedDeliveredKg: string | null;
  entered: boolean;
  expectEggs: boolean;
  feedHint: string | null;
  day: {
    feedConsumedKg: string | null;
    feedClosingKg: string | null;
    waterUpperKl: string | null;
    waterLowerKl: string | null;
    eggsTotal: number | null;
    eggsCracked: number | null;
    eggsDirty: number | null;
    note: string | null;
  } | null;
  losses: Loss[];
}

interface Board {
  day: string;
  rows: Row[];
  entered: number;
}

export function FarmsDailyPage() {
  const [date, setDate] = useState(today());
  const { data: board, isLoading } = useQuery<Board>({
    queryKey: ["farms-daily", date],
    queryFn: () => api(`/api/farms/daily?date=${date}`),
  });

  const total = board?.rows.length ?? 0;
  const done = board?.entered ?? 0;

  return (
    <div className="p-4 pb-24 md:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Daily records</h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            Birds, water, feed and eggs — one card per house, for one day.
          </p>
        </div>
        <div className="w-full md:w-auto">
          <label className="label">Day</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || today())}
            className="input min-h-[44px]"
          />
        </div>
      </div>

      {isLoading && <p className="text-[13px] text-gray-500">Loading…</p>}

      {board && !board.rows.length && (
        <div className="card p-6 text-center">
          <p className="text-[14px] font-medium text-gray-900">No house held birds on this day.</p>
          <p className="mt-1 text-[13px] text-gray-500">
            Place a flock from the Farms board and it will appear here.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {board?.rows.map((r) => (
          <HouseDay key={r.placementId} row={r} day={date} />
        ))}
      </div>

      {!!total && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur md:left-[180px] md:px-6">
          <div className="flex items-center justify-between text-[13px]">
            <span className={done === total ? "text-green-700" : "text-gray-700"}>
              <span className="font-semibold">
                {done} of {total}
              </span>{" "}
              houses entered
            </span>
            {done < total && (
              <span className="text-[12px] text-amber-700">{total - done} still to record</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HouseDay({ row, day }: { row: Row; day: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(!row.entered);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    mortality: "",
    culled: "",
    maleBirds: "",
    waterUpperKl: "",
    waterLowerKl: "",
    feedConsumedKg: "",
    feedClosingKg: "",
    eggsTotal: "",
    eggsCracked: "",
    eggsDirty: "",
    note: "",
  });

  useEffect(() => {
    const of = (k: Loss["kind"]) =>
      String(row.losses.filter((l) => l.kind === k).reduce((a, l) => a + l.qty, 0) || "");
    setF({
      mortality: of("mortality"),
      culled: of("cull"),
      maleBirds: of("male_removal"),
      waterUpperKl: row.day?.waterUpperKl ?? "",
      waterLowerKl: row.day?.waterLowerKl ?? "",
      feedConsumedKg: row.day?.feedConsumedKg ?? "",
      feedClosingKg: row.day?.feedClosingKg ?? "",
      eggsTotal: row.day?.eggsTotal == null ? "" : String(row.day.eggsTotal),
      eggsCracked: row.day?.eggsCracked == null ? "" : String(row.day.eggsCracked),
      eggsDirty: row.day?.eggsDirty == null ? "" : String(row.day.eggsDirty),
      note: row.day?.note ?? "",
    });
    setOpen(!row.entered);
  }, [row]);

  // ── The figures the farm's form shows under each group ──
  const lost = num(f.mortality) + num(f.culled) + num(f.maleBirds);
  const closingBirds = row.openingBirds - lost;
  const totalWaterKl = num(f.waterUpperKl) + num(f.waterLowerKl);
  // kL → mL is ×1,000,000. Per bird, against the closing count.
  const waterPerBird = closingBirds > 0 ? (totalWaterKl * 1_000_000) / closingBirds : 0;
  const feedPerBird = closingBirds > 0 ? (num(f.feedConsumedKg) * 1000) / closingBirds : 0;
  const eggPercent = closingBirds > 0 ? (num(f.eggsTotal) / closingBirds) * 100 : 0;

  const losses: Loss[] = [
    { kind: "mortality" as const, qty: num(f.mortality) },
    { kind: "cull" as const, qty: num(f.culled) },
    { kind: "male_removal" as const, qty: num(f.maleBirds) },
  ].filter((l) => l.qty > 0);

  const save = useMutation({
    mutationFn: () =>
      api("/api/farms/daily", {
        method: "POST",
        body: {
          placementId: row.placementId,
          day,
          feedConsumedKg: f.feedConsumedKg || null,
          feedClosingKg: f.feedClosingKg || null,
          waterUpperKl: f.waterUpperKl || null,
          waterLowerKl: f.waterLowerKl || null,
          eggsTotal: f.eggsTotal === "" ? null : Number(f.eggsTotal),
          eggsCracked: f.eggsCracked === "" ? null : Number(f.eggsCracked),
          eggsDirty: f.eggsDirty === "" ? null : Number(f.eggsDirty),
          note: f.note.trim() || null,
          losses,
        },
      }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["farms-daily"] });
      void qc.invalidateQueries({ queryKey: ["farms-board"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save that day"),
  });

  const set = (k: keyof typeof f) => (v: string) => setF((c) => ({ ...c, [k]: v }));

  return (
    <div className={`card ${row.entered && !open ? "bg-green-50/40" : ""}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex flex-wrap items-baseline gap-x-2">
          {row.entered && <Check size={14} className="text-green-600" />}
          <span className="text-[15px] font-semibold text-gray-900">{row.houseCode}</span>
          <span className="text-[12px] text-gray-500">
            {row.flockCode} · {n(row.birds)} birds · {row.age.label}
          </span>
        </div>
        <span className="whitespace-nowrap text-[12px] text-gray-500">
          {row.entered ? (
            <>
              {row.day?.feedConsumedKg && <>{Number(row.day.feedConsumedKg).toLocaleString("en-IN")} kg</>}
              {row.day?.eggsTotal != null && <> · {n(row.day.eggsTotal)} eggs</>}
              {!!row.losses.length && (
                <span className="text-red-600">
                  {" "}
                  · {n(row.losses.reduce((a, l) => a + l.qty, 0))} lost
                </span>
              )}
            </>
          ) : (
            <span className="text-amber-700">Not entered</span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 py-3">
          {error && (
            <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              {error}
            </div>
          )}

          {/* ── Birds ── */}
          <Group title="Birds">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="Mortality" value={f.mortality} onChange={set("mortality")} />
              <Field label="Culled" value={f.culled} onChange={set("culled")} />
              {row.housePurpose !== "layer" && (
                <Field label="Male birds" value={f.maleBirds} onChange={set("maleBirds")} />
              )}
            </div>
            <Readout>
              <span>
                Opening: <strong className="tabular-nums">{n(row.openingBirds)}</strong>
              </span>
              <span>
                Closing:{" "}
                <strong
                  className={`tabular-nums ${closingBirds < 0 ? "text-red-600" : "text-green-700"}`}
                >
                  {n(closingBirds)}
                </strong>
              </span>
            </Readout>
          </Group>

          {/* ── Water ── */}
          <Group title="Water">
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Upper level"
                unit="kL"
                value={f.waterUpperKl}
                onChange={set("waterUpperKl")}
              />
              <Field
                label="Lower level"
                unit="kL"
                value={f.waterLowerKl}
                onChange={set("waterLowerKl")}
              />
            </div>
            <Readout>
              <span>
                Total: <strong className="tabular-nums">{totalWaterKl.toFixed(2)} kL</strong>
              </span>
              <span>
                Per bird: <strong className="tabular-nums">{waterPerBird.toFixed(1)} mL</strong>
              </span>
            </Readout>
          </Group>

          {/* ── Feed ── */}
          <Group title="Feed">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <div>
                <label className="label">
                  Delivered <span className="font-normal text-gray-400">kg</span>
                </label>
                <div className="input flex min-h-[44px] items-center justify-end bg-gray-50 tabular-nums text-gray-700">
                  {row.feedDeliveredKg
                    ? Number(row.feedDeliveredKg).toLocaleString("en-IN")
                    : "0"}
                </div>
                <p className="mt-0.5 text-[11px] text-gray-400">from the mill</p>
              </div>
              <Field
                label="Consumed"
                unit="kg"
                value={f.feedConsumedKg}
                onChange={set("feedConsumedKg")}
                hint={
                  row.feedHint
                    ? `yesterday ${Number(row.feedHint).toLocaleString("en-IN")}`
                    : undefined
                }
              />
              <Field
                label="Stock"
                unit="kg"
                value={f.feedClosingKg}
                onChange={set("feedClosingKg")}
              />
            </div>
            <Readout>
              <span>
                Per bird: <strong className="tabular-nums">{feedPerBird.toFixed(1)} g</strong>
              </span>
            </Readout>
          </Group>

          {/* ── Eggs ── */}
          {row.expectEggs && (
            <Group title="Eggs">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <Field label="Eggs produced" value={f.eggsTotal} onChange={set("eggsTotal")} />
                <Field label="Cracked" value={f.eggsCracked} onChange={set("eggsCracked")} />
                <Field label="Dirty" value={f.eggsDirty} onChange={set("eggsDirty")} />
              </div>
              <Readout>
                <span>
                  Egg %:{" "}
                  <strong className={`tabular-nums ${eggPercent > 100 ? "text-amber-700" : ""}`}>
                    {eggPercent.toFixed(1)}%
                  </strong>{" "}
                  <span className="text-gray-500">(per 100 birds)</span>
                </span>
              </Readout>
            </Group>
          )}

          <div className="mt-3">
            <label className="label">Note</label>
            <input
              value={f.note}
              onChange={(e) => set("note")(e.target.value)}
              className="input min-h-[44px]"
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending || closingBirds < 0}
              className="btn-primary min-h-[44px] whitespace-nowrap"
            >
              {save.isPending
                ? "Saving…"
                : closingBirds < 0
                  ? "Closing birds cannot be negative"
                  : row.entered
                    ? "Update record"
                    : "Save record"}
            </button>
            {save.isSuccess && !save.isPending && (
              <span className="text-[12px] text-green-700">Saved</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-lg border border-gray-200 p-3">
      <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-600">
        {title}
      </h4>
      {children}
    </div>
  );
}

/** The grey strip of derived figures the farm's form puts under each group. */
function Readout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 rounded bg-gray-100 px-2.5 py-1.5 text-[12px] text-gray-700">
      {children}
    </div>
  );
}

function Field({
  label,
  unit,
  value,
  onChange,
  hint,
}: {
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="label">
        {label}
        {unit && <span className="ml-1 font-normal text-gray-400">{unit}</span>}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        placeholder="0"
        className="input min-h-[44px] text-right"
      />
      {hint && <p className="mt-0.5 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}
