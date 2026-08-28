/**
 * Egg stock — the day sheet, as the packing room fills it.
 *
 * The top half is what gets entered: graded boxes per shed per size. The
 * bottom half — opening, production, sales, closing per size — is derived
 * from the stock ledger and never keyed, so it cannot disagree with the bay.
 * A correction to a shed's row corrects its stock movement in place.
 */
import { useEffect, useState } from "react";
import { Egg, Loader2 } from "lucide-react";
import { api } from "../api";

const SIZES = ["small", "medium", "large", "xl", "jumbo", "dirty"] as const;
type Size = (typeof SIZES)[number];
const LABEL: Record<Size, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xl: "Extra Large",
  jumbo: "Jumbo",
  dirty: "Dirty",
};

/**
 * The same six, as the grading room writes them.
 *
 * Eight columns on a phone leaves about forty pixels a heading, and "Extra
 * Large" in forty pixels is "EX… LA…". These are not an abbreviation invented
 * for the layout — S, M, L, XL is how eggs are graded and marked on the box, so
 * the short form is the one the people using this already read.
 */
const SHORT: Record<Size, string> = {
  small: "S",
  medium: "M",
  large: "L",
  xl: "XL",
  jumbo: "J",
  dirty: "D",
};

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
  const today = new Date().toISOString().slice(0, 10);
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

  const load = () => {
    setLoading(true);
    api<Sheet>(`/api/sales/eggs/grading/${date}`)
      .then((s) => {
        setSheet(s);
        setDraft(
          Object.fromEntries(
            s.rows.map((r) => [
              r.houseId,
              Object.fromEntries(SIZES.map((z) => [z, r.boxes[z] ? String(r.boxes[z]) : ""])) as Record<Size, string>,
            ]),
          ),
        );
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
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        />
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
                          className={inputCls}
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
              Boxes of 210. Small under {Number(sheet.bands.smallMaxKg)} kg · Medium to{" "}
              {Number(sheet.bands.mediumMaxKg)} kg · Large to {Number(sheet.bands.largeMaxKg)} kg · XL
              above · Jumbo picked, not weighed.
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
