/**
 * Egg stock — the Daily Production & Stock Statement, as the farm's sheet
 * lays it out (7 Oct 2026).
 *
 * Production Report: graded boxes per shed per size, keyed. Stock Summary:
 * opening (yesterday's closing, unchanged), + production (the report's
 * total), − sales (trucks loaded in the bay, nothing else), = closing —
 * calculated, never keyed. The physical count checks the closing and never
 * changes it; a difference shows in red. The supervisor submits the day,
 * which locks it until an Admin or a Director reopens it.
 */
import { useEffect, useRef, useState } from "react";
import { Camera, Egg, FileDown, Loader2, Lock, LockOpen } from "lucide-react";
import { api } from "../api";
import { asDataUrl, shrink } from "../lib/image";
import { EGG_SIZE_LABEL, EGG_SIZE_SHORT, STOCK_SHEET_SIZES, type EggSize } from "@shared/egg-sizes";
import { localYmd } from "../lib/utils";
import { DateInput } from "../components/date-input";

/** The grades this screen shows, in the statement's own order. */
const SIZES = STOCK_SHEET_SIZES;
type Size = EggSize;
const LABEL: Record<Size, string> = { ...EGG_SIZE_LABEL, niko: "NIKO" };
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

/**
 * The paper sheet's closing line laid over the count, one total per size, and
 * which sizes it touched. Suggestions like the grading cells: nothing is saved
 * until the count is.
 */
function countFromReading(base: Record<Size, string>, r: SheetReading): { draft: Record<Size, string>; marks: Set<Size> } {
  const draft = { ...base };
  const marks = new Set<Size>();
  for (const z of SIZES) {
    const n = r.stock?.[z]?.closing;
    if (n == null) continue;
    draft[z] = n ? String(n) : "";
    marks.add(z);
  }
  return { draft, marks };
}

interface Row {
  houseId: string;
  code: string;
  purpose: string;
  boxes: Record<Size, number>;
  entered: boolean;
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
  /** The evening count, one total per size; null until counted. */
  count: Record<Size, number> | null;
  /** Counted minus the calculated closing, per size. */
  variance: Record<Size, number> | null;
  bands: { smallMaxKg: string; mediumMaxKg: string; largeMaxKg: string };
  stockFrom: string;
  submission: { submittedBy: string | null; submittedAt: string; reopenedBy: string | null; reopenedAt: string | null } | null;
  locked: boolean;
  canReopen: boolean;
}

const when = (t: string) =>
  new Date(t).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

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
  const [closingDraft, setClosingDraft] = useState<Record<Size, string>>(
    () => Object.fromEntries(SIZES.map((z) => [z, ""])) as Record<Size, string>,
  );
  /** Count cells the photo's closing line filled that nobody has touched since. */
  const [countFromPhoto, setCountFromPhoto] = useState<Set<Size>>(new Set());
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
        const countBase = Object.fromEntries(
          SIZES.map((z) => [z, s.count?.[z] ? String(s.count[z]) : ""]),
        ) as Record<Size, string>;
        // A photo dated for this day lands once the day's own sheet is here,
        // so it lays over what was already saved rather than replacing it.
        if (pending && pending.date === s.date) {
          const out = withReading(base, pending);
          setDraft(out.draft);
          setFromPhoto(out.marks);
          const counted = countFromReading(countBase, pending);
          setClosingDraft(counted.draft);
          setCountFromPhoto(counted.marks);
          setPending(null);
        } else {
          setDraft(base);
          setFromPhoto(new Set());
          setClosingDraft(countBase);
          setCountFromPhoto(new Set());
        }
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
        const counted = countFromReading(closingDraft, r);
        setClosingDraft(counted.draft);
        setCountFromPhoto(counted.marks);
      }
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "Could not read the photo");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const setClosing = (size: Size, v: string) => {
    setClosingSaved(null);
    setClosingDraft({ ...closingDraft, [size]: v });
    if (countFromPhoto.has(size)) {
      const next = new Set(countFromPhoto);
      next.delete(size);
      setCountFromPhoto(next);
    }
  };

  const saveClosing = async () => {
    setSavingClosing(true);
    setError(null);
    try {
      await api("/api/sales/eggs/closing", {
        method: "POST",
        body: {
          countedOn: date,
          boxes: Object.fromEntries(SIZES.map((z) => [z, Number(closingDraft[z]) || 0])),
        },
      });
      setClosingSaved("saved");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save count");
    } finally {
      setSavingClosing(false);
    }
  };

  const [signing, setSigning] = useState(false);
  /** Submit signs the day; reopen is an Admin's or a Director's. */
  const sign = async (action: "submit" | "reopen") => {
    if (action === "reopen" && !window.confirm(`Reopen ${date}? Its grading, count and trucks become editable again.`)) return;
    setSigning(true);
    setError(null);
    try {
      await api(`/api/sales/eggs/grading/${date}/${action}`, { method: "POST" });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${action}`);
    } finally {
      setSigning(false);
    }
  };

  const colTotal = (size: Size) =>
    Object.values(draft).reduce((a, r) => a + (Number(r[size]) || 0), 0);

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
          <a
            href={`/api/sales/eggs/grading/${date}/sheet.pdf`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-soil-50"
          >
            <FileDown className="h-4 w-4" />
            PDF
          </a>
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
                      const calc = sheet.summary[z]?.closing ?? 0;
                      return `${LABEL[z]} ${num(paper)}${paper === calc ? "" : ` (calculated ${num(calc)})`}`;
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

          {sheet.submission && (
            <div
              className={`mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-xs ${
                sheet.locked ? "bg-soil-100 text-soil-700" : "bg-warning/10 text-warning"
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                {sheet.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                Submitted by {sheet.submission.submittedBy ?? "—"} · {when(sheet.submission.submittedAt)}
                {!sheet.locked && sheet.submission.reopenedAt
                  ? ` · reopened by ${sheet.submission.reopenedBy ?? "—"} · ${when(sheet.submission.reopenedAt)}`
                  : " · locked"}
              </span>
              {sheet.locked && sheet.canReopen && (
                <button onClick={() => sign("reopen")} disabled={signing} className="font-medium underline">
                  Reopen
                </button>
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
                  <th className="whitespace-nowrap px-3 py-2 text-left">Particulars</th>
                  {SIZES.map((z) => (
                    <th key={z} className="whitespace-nowrap px-3 py-2 text-right">
                      <span className="lg:hidden">{SHORT[z]}</span><span className="hidden lg:inline">{LABEL[z]}</span>
                    </th>
                  ))}
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
                          disabled={sheet.locked}
                          className={`${inputCls} ${fromPhoto.has(`${r.houseId}:${z}`) ? "border-yolk-400 bg-yolk-50" : ""} disabled:bg-soil-50 disabled:text-soil-700`}
                          placeholder="—"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-soil-100 bg-soil-50 font-semibold">
                  <td className="px-3 py-2">Total</td>
                  {SIZES.map((z) => (
                    <td key={z} className="px-3 py-2 text-right tabular-nums">
                      {colTotal(z) ? num(colTotal(z)) : "—"}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">
              Boxes of 210; a jumbo box holds 180, a niko box 360. Dirty is counted in trays of 30. Small under {Number(sheet.bands.smallMaxKg)} kg
              · Medium to {Number(sheet.bands.mediumMaxKg)} kg · Large above · Jumbo picked, not weighed · Brown
              sorted by colour.
            </p>
            {!sheet.locked && (
              <div className="flex items-center gap-3">
                {saved && <span className="text-xs text-success">saved</span>}
                <button
                  onClick={save}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md bg-yolk-500 px-3 py-2 text-sm font-medium text-white hover:bg-yolk-600 disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save production
                </button>
              </div>
            )}
          </div>

          <div className="mb-1 mt-6 flex items-baseline justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-soil-400">Stock summary</div>
            <div className="text-[11px] text-muted-foreground">
              Calculated, never keyed: sales are the trucks loaded in the Loading Bay.
            </div>
          </div>
          <div className="overflow-x-auto rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
            <table className="data-table cols-auto w-full text-sm">
              <thead className="bg-soil-50 text-left text-[11px] font-semibold uppercase text-soil-400">
                <tr className="border-b border-soil-100">
                  <th className="col-fill whitespace-nowrap px-3 py-2 text-left">Particulars</th>
                  {SIZES.map((z) => (
                    <th key={z} className="whitespace-nowrap px-3 py-2 text-right">
                      <span className="lg:hidden">{SHORT[z]}</span><span className="hidden lg:inline">{LABEL[z]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Opening stock", "opening"],
                    ["(+) Production", "production"],
                    ["(−) Sales", "sales"],
                    ["(±) Adjustment", "other"],
                    ["Closing stock", "closing"],
                  ] as const
                ).map(([label, key]) => {
                  // Only a hand-made stock adjustment lands in "other"; the count never does.
                  if (key === "other" && SIZES.every((z) => !(sheet.summary[z]?.other ?? 0))) return null;
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
                            className={`px-3 py-1.5 text-right tabular-nums ${!v && !strong ? "text-muted-foreground" : ""}`}
                          >
                            {v ? num(v) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mb-1 mt-6 flex items-baseline justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-soil-400">Physical count</div>
            <div className="text-[11px] text-muted-foreground">
              The shelves, one total per size. Checks the closing; never changes it.
            </div>
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
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-soil-100/70">
                  <td className="px-3 py-1.5 font-medium">Counted</td>
                  {SIZES.map((z) => (
                    <td key={z} className="px-2 py-1.5">
                      <input
                        type="number"
                        min="0"
                        value={closingDraft[z] ?? ""}
                        onChange={(e) => setClosing(z, e.target.value)}
                        disabled={sheet.locked}
                        className={`${inputCls} ${countFromPhoto.has(z) ? "border-yolk-400 bg-yolk-50/60" : ""} disabled:bg-soil-50 disabled:text-soil-700`}
                        placeholder="—"
                        title={countFromPhoto.has(z) ? "From the photo's closing line" : undefined}
                      />
                    </td>
                  ))}
                </tr>
                {sheet.variance && (
                  <tr className="border-t border-soil-200">
                    <td className="px-3 py-1.5">Difference</td>
                    {SIZES.map((z) => {
                      const v = sheet.variance![z] ?? 0;
                      return (
                        <td
                          key={z}
                          className={`px-3 py-1.5 text-right tabular-nums ${v === 0 ? "text-muted-foreground" : "font-semibold text-destructive"}`}
                        >
                          {v === 0 ? "·" : `${v > 0 ? "+" : ""}${num(v)}`}
                        </td>
                      );
                    })}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {sheet.variance && SIZES.some((z) => sheet.variance![z]) && (
            <p className="mt-2 text-[11px] text-destructive">
              The shelves and the calculated closing disagree. Find the missing dispatch slip or the breakage before
              submitting; the closing carried into tomorrow stays the calculated one.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
            {error && <span className="text-xs text-destructive">{error}</span>}
            {closingSaved && <span className="text-xs text-success">{closingSaved}</span>}
            {!sheet.locked && (
              <>
                <button onClick={saveClosing} disabled={savingClosing} className="btn-yolk">
                  {savingClosing && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save count
                </button>
                <button
                  onClick={() => sign("submit")}
                  disabled={signing || !sheet.count}
                  title={sheet.count ? undefined : "Save the physical count first"}
                  className="inline-flex items-center gap-1.5 rounded-md bg-soil-800 px-3 py-2 text-sm font-medium text-white hover:bg-soil-900 disabled:opacity-40"
                >
                  {signing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                  Submit day
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
