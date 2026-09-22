/**
 * Egg stock — the day sheet, as the packing room fills it.
 *
 * The top half is what gets entered: graded boxes per shed per size. The
 * bottom half — opening, production, sales, closing per size — is derived
 * from the stock ledger and never keyed, so it cannot disagree with the bay.
 * A correction to a shed's row corrects its stock movement in place.
 */
import { useEffect, useRef, useState } from "react";
import { Camera, Egg, Loader2 } from "lucide-react";
import { api } from "../api";
import { asDataUrl, shrink } from "../lib/image";
import { EGG_SIZE_LABEL, EGG_SIZE_SHORT, VISIBLE_EGG_SIZES, type EggSize } from "@shared/egg-sizes";
import { localYmd } from "../lib/utils";
import { DateInput } from "../components/date-input";

/** The grades this screen shows — the shared list less the hidden ones. */
const SIZES = VISIBLE_EGG_SIZES;
type Size = EggSize;
const LABEL = EGG_SIZE_LABEL;
const SHORT = EGG_SIZE_SHORT;

/** What the photo reader sends back — suggestions and its own checks, nothing saved. */
interface SheetReading {
  dateRaw: string | null;
  date: string | null;
  rows: Array<{
    shed: string;
    houseId: string | null;
    boxes: Partial<Record<Size, number>>;
    unmapped: Record<string, number>;
  }>;
  totals: Partial<Record<Size, { sum: number; paper: number | null; ok: boolean }>>;
  stock: Partial<
    Record<Size, { opening: number | null; production: number | null; sales: number | null; closing: number | null }>
  > | null;
  unmappedColumns: Array<{ header: string; production: number; closing: number | null }>;
  unmatchedSheds: string[];
  warnings: string[];
}

type Draft = Record<string, Record<Size, string>>;

/** The draft with the photo's figures laid over it, and which cells they touched. */
function withReading(base: Draft, r: SheetReading): { draft: Draft; marks: Set<string> } {
  const draft: Draft = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { ...v }]));
  const marks = new Set<string>();
  for (const row of r.rows) {
    if (!row.houseId || !draft[row.houseId]) continue;
    for (const z of SIZES) {
      const n = row.boxes[z];
      if (n == null) continue;
      draft[row.houseId]![z] = n ? String(n) : "";
      marks.add(`${row.houseId}:${z}`);
    }
  }
  return { draft, marks };
}

interface Row {
  houseId: string;
  code: string;
  purpose: string;
  boxes: Record<Size, number>;
  entered: boolean;
  /** The shed's previous evening count, and when it was taken. */
  opening: Record<Size, number> | null;
  openingFrom: string | null;
  closing: Record<Size, number> | null;
  counted: boolean;
  /** opening + graded − counted: what left the shed. */
  lifted: Record<Size, number> | null;
}

interface Summary {
  opening: number;
  production: number;
  sales: number;
  other: number;
  closing: number;
}

interface Sheet {
  date: string;
  rows: Row[];
  summary: Record<Size, Summary>;
  countedTotal: Record<Size, number> | null;
  /** Counted minus the ledger's closing, per size. */
  variance: Record<Size, number> | null;
  bands: { smallMaxKg: string; mediumMaxKg: string; largeMaxKg: string };
  stockFrom: string;
}

const num = (n: number) => n.toLocaleString("en-IN");
const inputCls =
  "h-8 w-full rounded-md border border-border bg-background px-1.5 text-right text-sm tabular-nums";

export function EggGradingPage() {
  const today = localYmd();
  const [date, setDate] = useState(today);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [draft, setDraft] = useState<Record<string, Record<Size, string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [closingDraft, setClosingDraft] = useState<Record<string, Record<Size, string>>>({});
  const [savingClosing, setSavingClosing] = useState(false);
  const [closingSaved, setClosingSaved] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [read, setRead] = useState<SheetReading | null>(null);
  /** Cells the photo filled that nobody has touched since. */
  const [fromPhoto, setFromPhoto] = useState<Set<string>>(new Set());
  /** A reading dated differently from the page, waiting for that day's sheet. */
  const [pending, setPending] = useState<SheetReading | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    api<Sheet>(`/api/sales/eggs/grading/${date}`)
      .then((s) => {
        setSheet(s);
        const base: Draft = Object.fromEntries(
          s.rows.map((r) => [
            r.houseId,
            Object.fromEntries(SIZES.map((z) => [z, r.boxes[z] ? String(r.boxes[z]) : ""])) as Record<Size, string>,
          ]),
        );
        // A photo dated for this day lands once the day's own sheet is here,
        // so it lays over what was already saved rather than replacing it.
        if (pending && pending.date === s.date) {
          const out = withReading(base, pending);
          setDraft(out.draft);
          setFromPhoto(out.marks);
          setPending(null);
        } else {
          setDraft(base);
          setFromPhoto(new Set());
        }
        setClosingDraft(
          Object.fromEntries(
            s.rows.map((r) => [
              r.houseId,
              Object.fromEntries(SIZES.map((z) => [z, r.closing?.[z] ? String(r.closing[z]) : ""])) as Record<Size, string>,
            ]),
          ),
        );
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, [date]);

  const set = (houseId: string, size: Size, v: string) => {
    setSaved(false);
    setDraft({ ...draft, [houseId]: { ...draft[houseId]!, [size]: v } });
    // Typing in a box takes it off the photo for good.
    if (fromPhoto.has(`${houseId}:${size}`)) {
      const next = new Set(fromPhoto);
      next.delete(`${houseId}:${size}`);
      setFromPhoto(next);
    }
  };

  /**
   * Read the paper sheet from a photograph. Suggestions only: the grid is
   * filled, every cell the photo touched is marked, and nothing is saved until
   * the person presses save. A sheet dated for another day moves the page to
   * that day first.
   */
  const readPhoto = async (file: File) => {
    setReading(true);
    setReadError(null);
    setRead(null);
    try {
      const image = await asDataUrl(await shrink(file, 1600));
      const r = await api<SheetReading>("/api/sales/eggs/grading/read", { method: "POST", body: { image } });
      setRead(r);
      setSaved(false);
      if (r.date && r.date !== date) {
        setPending(r);
        setDate(r.date);
      } else {
        const out = withReading(draft, r);
        setDraft(out.draft);
        setFromPhoto(out.marks);
      }
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "Could not read the photo");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const setClosing = (houseId: string, size: Size, v: string) => {
    setClosingSaved(null);
    setClosingDraft({ ...closingDraft, [houseId]: { ...closingDraft[houseId]!, [size]: v } });
  };

  const saveClosing = async () => {
    setSavingClosing(true);
    setError(null);
    try {
      const r = await api<{ adjustmentNumber: string | null }>("/api/sales/eggs/closing", {
        method: "POST",
        body: {
          countedOn: date,
          rows: Object.entries(closingDraft).map(([houseId, boxes]) => ({
            houseId,
            boxes: Object.fromEntries(SIZES.map((z) => [z, Number(boxes[z]) || 0])),
          })),
        },
      });
      setClosingSaved(r.adjustmentNumber ? `saved · ledger adjusted by ${r.adjustmentNumber}` : "saved · ledger already agreed");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save count");
    } finally {
      setSavingClosing(false);
    }
  };

  const colTotal = (size: Size) =>
    Object.values(draft).reduce((a, r) => a + (Number(r[size]) || 0), 0);
  const rowTotal = (houseId: string) => SIZES.reduce((a, z) => a + (Number(draft[houseId]?.[z]) || 0), 0);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("/api/sales/eggs/grading", {
        method: "POST",
        body: {
          gradedOn: date,
          rows: Object.entries(draft).map(([houseId, boxes]) => ({
            houseId,
            boxes: Object.fromEntries(SIZES.map((z) => [z, Number(boxes[z]) || 0])),
          })),
        },
      });
      setSaved(true);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Laying houses first; a pullet house only appears once it has a row.
  const rows = (sheet?.rows ?? []).filter((r) => r.purpose === "layer" || r.entered);

  return (
    <div className="min-h-full bg-soil-50 p-4 md:p-6">
      <div className="page-header -mx-4 mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:-mx-6 md:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-yolk-400 to-yolk-600 text-white shadow-sm">
            <Egg className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold text-soil-900">Egg stock</h1>
            </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void readPhoto(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={reading}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-soil-50 disabled:opacity-50"
          >
            {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            Read a photo
          </button>
          <DateInput
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          />
        </div>
      </div>

      {loading || !sheet ? (
        <div className="py-16 text-center text-sm text-muted-foreground">reading…</div>
      ) : (
        <>
          {date < sheet.stockFrom && (
            <p className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              Stock counting began {sheet.stockFrom}. A sheet before that is kept as a record but
              moves no stock.
            </p>
          )}

          {readError && (
            <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{readError}</p>
          )}
          {read && (
            <div className="mb-3 rounded-2xl bg-white p-3 text-xs shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-semibold text-soil-900">
                  Read from the photo{read.dateRaw ? ` dated ${read.dateRaw}` : ""}
                  {read.date && read.date !== sheet.date ? ` — showing ${sheet.date}` : ""}
                </div>
                <div className="text-muted-foreground">
                  Marked cells came from the photo. Check them against the paper, then save.
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {SIZES.filter((z) => read.totals[z]).map((z) => {
                  const t = read.totals[z]!;
                  return (
                    <span key={z} className={t.ok ? "text-success" : "text-destructive"}>
                      {LABEL[z]} {num(t.sum)}
                      {t.paper == null ? " · no total on paper" : t.ok ? " · matches total" : ` · paper says ${num(t.paper)}`}
                    </span>
                  );
                })}
              </div>
              {read.stock && (
                <div className="mt-2 text-muted-foreground">
                  Paper closing stock:{" "}
                  {SIZES.filter((z) => read.stock![z]?.closing != null)
                    .map((z) => {
                      const paper = read.stock![z]!.closing!;
                      const ledger = sheet.summary[z]?.closing ?? 0;
                      return `${LABEL[z]} ${num(paper)}${paper === ledger ? "" : ` (ledger ${num(ledger)})`}`;
                    })
                    .join(" · ")}
                </div>
              )}
              {read.warnings.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-warning">
                  {read.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-soil-400">
            Production report
          </div>
          <div className="overflow-x-auto rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
            <table className="data-table cols-auto w-full text-sm">
              <thead className="bg-soil-50 text-left text-[11px] font-semibold uppercase text-soil-400">
                <tr className="border-b border-soil-100">
                  <th className="whitespace-nowrap px-3 py-2 text-left">Shed</th>
                  {SIZES.map((z) => (
                    <th key={z} className="whitespace-nowrap px-3 py-2 text-right">
                      <span className="lg:hidden">{SHORT[z]}</span><span className="hidden lg:inline">{LABEL[z]}</span>
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-3 py-2 text-right"><span className="lg:hidden">Tot</span><span className="hidden lg:inline">Total</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.houseId} className="border-b border-soil-100/70 last:border-0 transition-colors hover:bg-yolk-50/70">
                    <td className="px-3 py-1.5 font-medium">{r.code}</td>
                    {SIZES.map((z) => (
                      <td key={z} className="px-2 py-1.5">
                        <input
                          type="number"
                          min="0"
                          value={draft[r.houseId]?.[z] ?? ""}
                          onChange={(e) => set(r.houseId, z, e.target.value)}
                          className={`${inputCls} ${fromPhoto.has(`${r.houseId}:${z}`) ? "border-yolk-400 bg-yolk-50" : ""}`}
                          placeholder="—"
                        />
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                      {rowTotal(r.houseId) ? num(rowTotal(r.houseId)) : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-soil-100 bg-soil-50 font-semibold">
                  <td className="px-3 py-2">Total</td>
                  {SIZES.map((z) => (
                    <td key={z} className="px-3 py-2 text-right tabular-nums">
                      {colTotal(z) ? num(colTotal(z)) : "—"}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums">
                    {num(SIZES.reduce((a, z) => a + colTotal(z), 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              Boxes of 210; a jumbo box holds 180, a niko box 360. Small under {Number(sheet.bands.smallMaxKg)} kg
              · Medium to {Number(sheet.bands.mediumMaxKg)} kg · Large to {Number(sheet.bands.largeMaxKg)} kg · XL
              above · Jumbo picked, not weighed · Brown sorted by colour.
            </p>
            <div className="flex items-center gap-3">
              {saved && <span className="text-xs text-success">saved</span>}
              {error && <span className="text-xs text-destructive">{error}</span>}
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-yolk-500 px-3 py-2 text-sm font-medium text-white hover:bg-yolk-600 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save sheet
              </button>
            </div>
          </div>

          <div className="mb-1 mt-6 flex items-baseline justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-soil-400">
              Closing count by shed
            </div>
            <div className="text-[11px] text-muted-foreground">
              The evening count in each shed's room. What left the shed is derived: opening + graded − counted.
            </div>
          </div>
          <div className="overflow-x-auto rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
            <table className="data-table cols-auto w-full text-sm">
              <thead className="bg-soil-50 text-left text-[11px] font-semibold uppercase text-soil-400">
                <tr className="border-b border-soil-100">
                  <th className="col-fill whitespace-nowrap px-3 py-2 text-left">Shed</th>
                  {SIZES.map((z) => (
                    <th key={z} className="whitespace-nowrap px-3 py-2 text-right">
                      <span className="lg:hidden">{SHORT[z]}</span><span className="hidden lg:inline">{LABEL[z]}</span>
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-3 py-2 text-right"><span className="lg:hidden">Tot</span><span className="hidden lg:inline">Total</span></th>
                  <th className="whitespace-nowrap px-3 py-2 text-right"><span className="lg:hidden">Lift</span><span className="hidden lg:inline">Lifted</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const total = SIZES.reduce((a, z) => a + (Number(closingDraft[r.houseId]?.[z]) || 0), 0);
                  const liftedTotal = r.lifted ? SIZES.reduce((a, z) => a + (r.lifted![z] ?? 0), 0) : null;
                  return (
                    <tr key={r.houseId} className="border-b border-soil-100/70 last:border-0 transition-colors hover:bg-yolk-50/70">
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{r.code}</div>
                        {r.opening && (
                          <div className="text-[10px] text-muted-foreground">
                            opened {num(SIZES.reduce((a, z) => a + (r.opening![z] ?? 0), 0))} · counted {r.openingFrom}
                          </div>
                        )}
                      </td>
                      {SIZES.map((z) => (
                        <td key={z} className="px-2 py-1.5">
                          <input
                            type="number"
                            min="0"
                            value={closingDraft[r.houseId]?.[z] ?? ""}
                            onChange={(e) => setClosing(r.houseId, z, e.target.value)}
                            className={inputCls}
                            placeholder="—"
                          />
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{total ? num(total) : "—"}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${liftedTotal != null && liftedTotal < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                        {liftedTotal != null ? num(liftedTotal) : "—"}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t border-soil-100 bg-soil-50 font-semibold">
                  <td className="col-fill px-3 py-2">Counted</td>
                  {SIZES.map((z) => {
                    const v = Object.values(closingDraft).reduce((a, r) => a + (Number(r[z]) || 0), 0);
                    return (
                      <td key={z} className="px-3 py-2 text-right tabular-nums">
                        {v ? num(v) : "—"}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right tabular-nums">
                    {num(SIZES.reduce((a, z) => a + Object.values(closingDraft).reduce((b, r) => b + (Number(r[z]) || 0), 0), 0))}
                  </td>
                  <td />
                </tr>
                {sheet.variance && (
                  <tr className="border-t border-soil-200 text-xs">
                    <td className="px-3 py-1.5 text-muted-foreground">vs ledger closing</td>
                    {SIZES.map((z) => {
                      const v = sheet.variance![z] ?? 0;
                      return (
                        <td key={z} className={`px-3 py-1.5 text-right tabular-nums ${v === 0 ? "text-muted-foreground" : v < 0 ? "text-destructive" : "text-warning"}`}>
                          {v === 0 ? "·" : `${v > 0 ? "+" : ""}${num(v)}`}
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {(() => {
                        const v = SIZES.reduce((a, z) => a + (sheet.variance![z] ?? 0), 0);
                        return <span className={v === 0 ? "text-success" : v < 0 ? "text-destructive" : "text-warning"}>{v === 0 ? "agrees" : `${v > 0 ? "+" : ""}${num(v)}`}</span>;
                      })()}
                    </td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-end">
            <div className="flex items-center gap-3">
              {closingSaved && <span className="text-xs text-success">{closingSaved}</span>}
              <button
                onClick={saveClosing}
                disabled={savingClosing}
                className="btn-yolk"
              >
                {savingClosing && <Loader2 className="h-4 w-4 animate-spin" />}
                Save count
              </button>
            </div>
          </div>
          <div className="mb-1 mt-6 text-xs font-semibold uppercase tracking-wide text-soil-400">
            Stock summary
          </div>
          <div className="overflow-x-auto rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
            <table className="data-table cols-auto w-full text-sm">
              <thead className="bg-soil-50 text-left text-[11px] font-semibold uppercase text-soil-400">
                <tr className="border-b border-soil-100">
                  <th className="col-fill whitespace-nowrap px-3 py-2 text-left" />
                  {SIZES.map((z) => (
                    <th key={z} className="whitespace-nowrap px-3 py-2 text-right">
                      <span className="lg:hidden">{SHORT[z]}</span><span className="hidden lg:inline">{LABEL[z]}</span>
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-3 py-2 text-right"><span className="lg:hidden">Tot</span><span className="hidden lg:inline">Total</span></th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Opening stock", "opening"],
                    ["Production", "production"],
                    ["Sales", "sales"],
                    ["Adjustments", "other"],
                    ["Closing stock", "closing"],
                  ] as const
                ).map(([label, key]) => {
                  const total = SIZES.reduce((a, z) => a + (sheet.summary[z]?.[key] ?? 0), 0);
                  if (key === "other" && total === 0) return null;
                  const strong = key === "closing";
                  return (
                    <tr
                      key={key}
                      className={`border-b border-soil-100/70 last:border-0 ${strong ? "bg-soil-50 font-semibold" : ""}`}
                    >
                      <td className="col-fill px-3 py-1.5">{label}</td>
                      {SIZES.map((z) => {
                        const v = sheet.summary[z]?.[key] ?? 0;
                        return (
                          <td
                            key={z}
                            className={`px-3 py-1.5 text-right tabular-nums ${
                              key === "sales" && v ? "text-destructive" : ""
                            } ${!v && !strong ? "text-muted-foreground" : ""}`}
                          >
                            {v ? num(v) : "—"}
                          </td>
                        );
                      })}
                      <td className="px-3 py-1.5 text-right tabular-nums">{total ? num(total) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
