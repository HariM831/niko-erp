/**
 * Daily records — every house, one day, one screen.
 *
 * This is the capture screen: somebody stands in the yard each morning and
 * enters eleven houses. It is deliberately separate from Flock detail, which is
 * where a batch is set up and handed over a handful of times in its life.
 * Putting a once-a-lifetime field beside a once-a-day one invites both to be
 * got wrong.
 *
 * Houses already entered collapse to a summary line; unentered ones stay open,
 * and the footer says how many are left — because the useful question at 9am is
 * not "what did I record" but "what have I not".
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import { ApiError, api } from "../api";
import { HOUSE_PURPOSE_LABELS, type HousePurpose } from "@shared/schema/farms";

const today = () => new Date().toISOString().slice(0, 10);
const n = (v: number) => v.toLocaleString("en-IN");

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
  entered: boolean;
  expectEggs: boolean;
  feedHint: string | null;
  day: {
    feedConsumedKg: string | null;
    feedClosingKg: string | null;
    waterL: string | null;
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
  const { data: causes } = useQuery<Array<{ code: string; label: string }>>({
    queryKey: ["mortality-causes"],
    queryFn: () => api("/api/farms/mortality-causes"),
  });

  const total = board?.rows.length ?? 0;
  const done = board?.entered ?? 0;

  return (
    <div className="p-6 pb-24">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Daily records</h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            Feed, water, eggs and losses — one row per house, for one day.
          </p>
        </div>
        <div>
          <label className="label">Day</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || today())}
            className="input"
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
          <HouseDay key={r.placementId} row={r} day={date} causes={causes ?? []} />
        ))}
      </div>

      {!!total && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-gray-200 bg-white/95 px-6 py-3 backdrop-blur md:left-[180px]">
          <div className="flex items-center justify-between text-[13px]">
            <span className={done === total ? "text-green-700" : "text-gray-700"}>
              <span className="font-semibold">
                {done} of {total}
              </span>{" "}
              houses entered
            </span>
            {done < total && (
              <span className="text-[12px] text-amber-700">
                {total - done} still to record
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HouseDay({
  row,
  day,
  causes,
}: {
  row: Row;
  day: string;
  causes: Array<{ code: string; label: string }>;
}) {
  const qc = useQueryClient();
  // Entered houses start collapsed — the ones that still need attention are the
  // ones that should be taking up the screen.
  const [open, setOpen] = useState(!row.entered);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    feedConsumedKg: "",
    feedClosingKg: "",
    waterL: "",
    eggsTotal: "",
    eggsCracked: "",
    eggsDirty: "",
    note: "",
  });
  const [losses, setLosses] = useState<Array<{ kind: Loss["kind"]; qty: string; causeCode: string; note: string }>>([]);

  useEffect(() => {
    setF({
      feedConsumedKg: row.day?.feedConsumedKg ?? "",
      feedClosingKg: row.day?.feedClosingKg ?? "",
      waterL: row.day?.waterL ?? "",
      eggsTotal: row.day?.eggsTotal == null ? "" : String(row.day.eggsTotal),
      eggsCracked: row.day?.eggsCracked == null ? "" : String(row.day.eggsCracked),
      eggsDirty: row.day?.eggsDirty == null ? "" : String(row.day.eggsDirty),
      note: row.day?.note ?? "",
    });
    setLosses(
      row.losses.map((l) => ({
        kind: l.kind,
        qty: String(l.qty),
        causeCode: l.causeCode ?? "",
        note: l.note ?? "",
      })),
    );
    setOpen(!row.entered);
  }, [row]);

  const lossRows = losses
    .filter((l) => Number(l.qty) > 0)
    .map((l) => ({
      kind: l.kind,
      qty: Number(l.qty),
      causeCode: l.kind === "male_removal" ? null : l.causeCode || null,
      note: l.note.trim() || null,
    }));
  const lost = lossRows.reduce((n2, l) => n2 + l.qty, 0);
  const missingCause = lossRows.some((l) => l.kind !== "male_removal" && !l.causeCode);
  const tooMany = lost > row.birds;

  const save = useMutation({
    mutationFn: () =>
      api("/api/farms/daily", {
        method: "POST",
        body: {
          placementId: row.placementId,
          day,
          feedConsumedKg: f.feedConsumedKg || null,
          feedClosingKg: f.feedClosingKg || null,
          waterL: f.waterL || null,
          eggsTotal: f.eggsTotal === "" ? null : Number(f.eggsTotal),
          eggsCracked: f.eggsCracked === "" ? null : Number(f.eggsCracked),
          eggsDirty: f.eggsDirty === "" ? null : Number(f.eggsDirty),
          note: f.note.trim() || null,
          losses: lossRows,
        },
      }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["farms-daily"] });
      void qc.invalidateQueries({ queryKey: ["farms-board"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save that day"),
  });

  // A lay percentage over 100 is arithmetically possible and always wrong — but
  // it is a warning, not a block, because the number that produced it is real
  // and refusing to record it just moves the error somewhere unrecorded.
  const layPct = row.birds && Number(f.eggsTotal) ? (Number(f.eggsTotal) / row.birds) * 100 : null;

  return (
    <div className={`card ${row.entered && !open ? "bg-green-50/40" : ""}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-baseline gap-2">
          {row.entered && <Check size={14} className="text-green-600" />}
          <span className="text-[14px] font-semibold text-gray-900">{row.houseCode}</span>
          <span className="text-[12px] text-gray-500">
            {row.flockCode} · {n(row.birds)} birds · {row.age.label}
          </span>
        </div>
        <span className="text-[12px] text-gray-500">
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

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field
              label="Feed consumed"
              unit="kg"
              value={f.feedConsumedKg}
              onChange={(v) => setF((c) => ({ ...c, feedConsumedKg: v }))}
              hint={row.feedHint ? `yesterday ${Number(row.feedHint).toLocaleString("en-IN")}` : undefined}
            />
            <Field
              label="Feed left in silo"
              unit="kg"
              value={f.feedClosingKg}
              onChange={(v) => setF((c) => ({ ...c, feedClosingKg: v }))}
            />
            <Field
              label="Water"
              unit="L"
              value={f.waterL}
              onChange={(v) => setF((c) => ({ ...c, waterL: v }))}
            />
            {row.expectEggs && (
              <Field
                label="Eggs"
                value={f.eggsTotal}
                onChange={(v) => setF((c) => ({ ...c, eggsTotal: v }))}
                hint={layPct ? `${layPct.toFixed(1)}% lay` : undefined}
                warn={layPct != null && layPct > 100 ? "over 100% lay" : undefined}
              />
            )}
          </div>

          {row.expectEggs && (
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field
                label="Cracked"
                value={f.eggsCracked}
                onChange={(v) => setF((c) => ({ ...c, eggsCracked: v }))}
              />
              <Field
                label="Dirty"
                value={f.eggsDirty}
                onChange={(v) => setF((c) => ({ ...c, eggsDirty: v }))}
              />
            </div>
          )}

          {/* Losses. A cause is required, because "3 dead" tells you nothing
              and "3 prolapse" tells you the lighting programme is wrong. */}
          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between">
              <label className="label">Birds lost</label>
              {!!lost && (
                <span className={`text-[12px] ${tooMany ? "text-red-600" : "text-gray-500"}`}>
                  {n(lost)} of {n(row.birds)}
                  {tooMany && " — more than the house holds"}
                </span>
              )}
            </div>
            <div className="space-y-2">
              {losses.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <div className="w-32">
                    <select
                      value={l.kind}
                      onChange={(e) =>
                        setLosses((cur) =>
                          cur.map((x, j) =>
                            j === i ? { ...x, kind: e.target.value as Loss["kind"] } : x,
                          ),
                        )
                      }
                      className="input"
                    >
                      <option value="mortality">Mortality</option>
                      <option value="cull">Cull</option>
                      <option value="male_removal">Male removal</option>
                    </select>
                  </div>
                  <div className="w-24">
                    <input
                      value={l.qty}
                      onChange={(e) =>
                        setLosses((cur) =>
                          cur.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                        )
                      }
                      inputMode="numeric"
                      placeholder="Birds"
                      className="input text-right"
                    />
                  </div>
                  {l.kind !== "male_removal" && (
                    <div className="w-48">
                      <select
                        value={l.causeCode}
                        onChange={(e) =>
                          setLosses((cur) =>
                            cur.map((x, j) => (j === i ? { ...x, causeCode: e.target.value } : x)),
                          )
                        }
                        className="input"
                      >
                        <option value="">Cause…</option>
                        {causes.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="min-w-[120px] flex-1">
                    <input
                      value={l.note}
                      onChange={(e) =>
                        setLosses((cur) =>
                          cur.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)),
                        )
                      }
                      placeholder="Note"
                      className="input"
                    />
                  </div>
                  <button
                    onClick={() => setLosses((cur) => cur.filter((_, j) => j !== i))}
                    className="text-[12px] text-gray-400 hover:text-red-600"
                    title="Remove"
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() =>
                setLosses((cur) => [...cur, { kind: "mortality", qty: "", causeCode: "", note: "" }])
              }
              className="mt-2 flex items-center gap-1 text-[12px] text-blue-600 hover:underline"
            >
              <Plus size={12} /> {losses.length ? "Another line" : "Record a loss"}
            </button>
          </div>

          <div className="mt-3">
            <label className="label">Note</label>
            <input
              value={f.note}
              onChange={(e) => setF((c) => ({ ...c, note: e.target.value }))}
              className="input"
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending || missingCause || tooMany}
              className="btn-primary whitespace-nowrap"
            >
              {save.isPending ? "Saving…" : row.entered ? "Update day" : "Save day"}
            </button>
            {missingCause && (
              <span className="text-[12px] text-red-600">Every loss needs a cause</span>
            )}
            {save.isSuccess && !save.isPending && (
              <span className="text-[12px] text-green-700">Saved</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  unit,
  value,
  onChange,
  hint,
  warn,
}: {
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  warn?: string;
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
        className="input text-right"
      />
      {warn ? (
        <p className="mt-0.5 text-[11px] text-amber-700">{warn}</p>
      ) : hint ? (
        <p className="mt-0.5 text-[11px] text-gray-400">{hint}</p>
      ) : null}
    </div>
  );
}
