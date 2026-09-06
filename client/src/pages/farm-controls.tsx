/**
 * What a shed's controller is set to, in niko's words.
 *
 * Its own screen under Farms. The vendor's remote-control tree is nine groups
 * of pages, each a form of settings or a grid where every cell is a register;
 * this draws the same pages from the catalogue niko keeps, with the values the
 * controller reports right now, and lists what changed on the panel since the
 * last snapshot. Stage 1: it reads everything and writes nothing.
 *
 * The page titles are niko's — what the page decides, not the vendor's menu
 * label — and the vendor's English and Chinese sit in a hover, so a call with
 * the vendor still has a shared vocabulary.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Camera, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";

interface BoardRow {
  houseId: string;
  code: string;
  purpose: string;
}
interface CatalogPageSummary {
  code: string;
  type: "Form" | "Table";
  path: string[];
  pathEn: string[];
  registers: number;
  readOnly: number;
}
interface Catalog {
  model: string | null;
  fetchedAt: string | null;
  pages: CatalogPageSummary[];
}
interface Option {
  value: string;
  label: string;
  labelEn: string;
}
interface Field {
  label: string;
  labelEn: string;
  explain?: string;
  register: string;
  range: string;
  unit: string;
  kind: string;
  options: Option[];
  readOnly: boolean;
  group: string;
}
interface Column {
  key: string;
  labelEn: string;
  explain?: string;
  range: string;
  unit: string;
  kind: string;
  options: Option[];
}
interface Row {
  id: number;
  label: string;
  cells: Record<string, string>;
}
interface PageDef {
  code: string;
  type: "Form" | "Table";
  path: string[];
  pathEn: string[];
  fields?: Field[];
  columns?: Column[];
  rows?: Row[];
  shared?: Field[];
  registers: string[];
  readOnlyRegisters: string[];
}
interface PageLive {
  page: PageDef;
  values: Record<string, string>;
  /** When the values are from: the kept copy's time, or the controller's answer. */
  at: string | null;
  /** "kept" until the controller has answered; then "live", or "offline" if it did not. */
  source: "kept" | "live" | "offline";
}
interface Status {
  code: string;
  controller: boolean;
  live: boolean;
  snapshot: { takenAt: string; registers: number } | null;
}
interface Change {
  id: number;
  register: string;
  pageCode: string | null;
  before: string | null;
  after: string | null;
  seenAt: string;
  source: string;
  labelEn: string;
  pageEn: string | null;
  unit: string;
  kind: string;
  options: Option[];
}

/**
 * The vendor's pages, grouped as decisions. Order and words are niko's; the
 * codes are the vendor's. A page in the catalogue that is not named here
 * still shows, under its vendor path, so nothing is hidden by a stale list.
 */
const SECTIONS: Array<{ title: string; pages: Array<[code: string, title: string]> }> = [
  {
    title: "Ventilation levels",
    pages: [
      ["TFJB_TFJB_S", "The ladder: fans and inlets at each step"],
      ["TFJB_TFJBTZ_S", "Ladder timing and the tunnel switch"],
    ],
  },
  {
    title: "Minimum and maximum level",
    pages: [
      ["JXJB_JXJB_S", "Floor and ceiling of the ladder"],
      ["JXJB_ZXZDJBQX_S", "Floor and ceiling by age"],
      ["JXJB_TZHXL_S", "Breathing-rate curve"],
      ["JXJB_TZHXL_KZCS_S", "Breathing-rate parameters"],
    ],
  },
  {
    title: "Temperature",
    pages: [
      ["QXTZ_WDQX_S", "Target temperature by age"],
      ["QXTZ_QXTZ_S", "How “at target” is judged"],
      ["QXTZ_TZQX_S", "Expected body weight by age"],
    ],
  },
  { title: "Heating", pages: [["JRSD_S", "When the heaters fire"]] },
  { title: "Cooling", pages: [["ZLSZ_S", "When the cooling pads run"]] },
  {
    title: "Schedules",
    pages: [
      ["BGSZ_DG_T", "Lighting programme"],
      ["BGSZ_DG_B", "Lighting behaviour"],
      ["BGSZ_SL_S", "Feeding windows"],
      ["BGSZ_FJFL_S", "Fan airflow ratings"],
      ["BGSZ_FLXS_S", "Wind-chill by age"],
    ],
  },
  { title: "Spray and humidity", pages: [["PW_S", "Mist and humidity"]] },
  {
    title: "Inlets and curtains",
    pages: [
      ["DBSD_XCMLSZ_S", "How the inlets are driven"],
      ["DBSD_XCMLJZ_S", "Inlet travel times"],
      ["DBSD_WDDY_S", "Which probes steer which inlet"],
    ],
  },
  { title: "Negative pressure", pages: [["FYSD_S", "Pressure control"]] },
];

/** The four fan states the vendor draws as circles, drawn the same way here. */
const FAN_GLYPH: Record<string, { glyph: string; title: string; cls: string }> = {
  "0": { glyph: "○", title: "stopped", cls: "text-soil-200" },
  "1": { glyph: "◐", title: "cycles on and off", cls: "text-yolk-600" },
  "2": { glyph: "●", title: "runs continuously", cls: "text-soil-900" },
  "3": { glyph: "◑", title: "alternates", cls: "text-yolk-700" },
};

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * A clock time the vendor encodes as H.MM in a number: 1.3 is 01:30, 5.3 is
 * 05:30, 8 is 08:00, 14 is 14:00. The decimal part is minutes as two digits
 * with any trailing zero dropped, so .3 means 30 and .05 means 5.
 */
function clock(value: string): string {
  const raw = value.trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const [h, m = ""] = raw.split(".");
  const minutes = Number(m.padEnd(2, "0").slice(0, 2));
  return `${String(Number(h)).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** A value as a person would say it: options named, clock times as clock times, on and off as words. */
function show(value: string | undefined, options?: Option[], kind?: string): string {
  if (value == null || value === "") return "—";
  const asFlag = value === "True" ? "1" : value === "False" ? "0" : value;
  if (options?.length) {
    const o = options.find((x) => Number(x.value) === Number(asFlag) || x.value === asFlag);
    if (o) return o.labelEn || o.label;
  }
  if (kind === "time") return clock(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return value === "True" ? "on" : value === "False" ? "off" : value;
  if (kind === "switch") return n ? "on" : "off";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

/** The vendor writes a range as 0~999 or 0-99.9; one dash for both. */
const range = (r: string) => r.replace(/\s*[~]\s*/g, "–").replace(/^(-?[\d.]+)-([\d.]+)$/, "$1–$2");

/** Kinds whose value is a word, so a unit beside it would be noise. */
const wordy = (kind: string) => kind === "switch" || kind === "select" || kind === "select-group" || kind === "switch-unit" || kind === "time";

export function FarmControlsPage() {
  const [, params] = useRoute("/farms/controls/:id");
  const [, setLocation] = useLocation();
  const { can } = useAuth();
  const manage = can("farms", "manage");

  const [houses, setHouses] = useState<BoardRow[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState<string>("TFJB_TFJB_S");
  const [page, setPage] = useState<PageLive | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const houseId = params?.id ?? houses[0]?.houseId ?? "";
  const house = houses.find((h) => h.houseId === houseId);

  useEffect(() => {
    api<{ board: BoardRow[] }>("/api/farms/iot/board")
      .then((d) => {
        setHouses(d.board);
        if (!params?.id && d.board[0]) setLocation(`/farms/controls/${d.board[0].houseId}`, { replace: true });
      })
      .catch(() => setHouses([]));
    api<Catalog>("/api/farms/controls/catalog").then(setCatalog).catch(() => setCatalog(null));
  }, []);

  const loadStatus = () => {
    if (!houseId) return;
    api<Status>(`/api/farms/controls/${houseId}/status`).then(setStatus).catch(() => setStatus(null));
  };
  const loadChanges = () => {
    if (!houseId) return;
    api<{ changes: Change[] }>(`/api/farms/controls/${houseId}/changes?days=30`)
      .then((d) => setChanges(d.changes))
      .catch(() => setChanges([]));
  };
  useEffect(() => {
    loadStatus();
    loadChanges();
  }, [houseId]);

  /*
   * Two answers for one page. The kept copy comes first and draws at once —
   * these settings change rarely and the copy is hours old at most. Then the
   * controller is asked in the background and its values replace the kept
   * ones when they arrive; if it does not answer, the kept copy stays, marked.
   */
  useEffect(() => {
    if (!houseId || !code || !catalog?.pages.length) return;
    let stop = false;
    setPageError(null);
    setLoadingPage(true);
    api<{ page: PageDef; values: Record<string, string>; at: string | null }>(`/api/farms/controls/${houseId}/page/${code}`)
      .then((d) => {
        if (!stop) setPage({ page: d.page, values: d.values, at: d.at, source: "kept" });
      })
      .catch((e) => {
        if (!stop) setPageError(e instanceof Error ? e.message : "Could not read the page");
      });
    api<{ page: PageDef; live: boolean; values: Record<string, string>; at: string; changes: number }>(
      `/api/farms/controls/${houseId}/page/${code}/live`,
    )
      .then((d) => {
        if (stop) return;
        if (d.live) {
          setPage({ page: d.page, values: d.values, at: d.at, source: "live" });
          if (d.changes) loadChanges();
        } else {
          setPage((prev) => (prev ? { ...prev, source: "offline" } : { page: d.page, values: {}, at: null, source: "offline" }));
        }
      })
      .catch(() => {
        if (!stop) setPage((prev) => (prev ? { ...prev, source: "offline" } : prev));
      })
      .finally(() => {
        if (!stop) setLoadingPage(false);
      });
    return () => {
      stop = true;
    };
  }, [houseId, code, catalog?.fetchedAt]);

  /** niko's sections, with any catalogue page the list does not name appended under its vendor path. */
  const sections = useMemo(() => {
    const have = new Map((catalog?.pages ?? []).map((p) => [p.code, p]));
    const named = new Set<string>();
    const out = SECTIONS.map((s) => ({
      title: s.title,
      pages: s.pages
        .filter(([c]) => have.has(c))
        .map(([c, t]) => {
          named.add(c);
          return { code: c, title: t, vendor: have.get(c)!.pathEn.join(" › ") };
        }),
    })).filter((s) => s.pages.length);
    const rest = [...have.values()].filter((p) => !named.has(p.code));
    if (rest.length) {
      out.push({
        title: "Other",
        pages: rest.map((p) => ({ code: p.code, title: p.pathEn.join(" › "), vendor: p.pathEn.join(" › ") })),
      });
    }
    return out;
  }, [catalog]);

  const current = sections.flatMap((s) => s.pages).find((p) => p.code === code);

  const snapshotNow = async () => {
    setBusy("snapshot");
    try {
      await api(`/api/farms/controls/${houseId}/snapshot`, { method: "POST" });
      loadStatus();
      loadChanges();
    } finally {
      setBusy(null);
    }
  };
  const refreshCatalog = async () => {
    setBusy("catalog");
    try {
      await api("/api/farms/controls/catalog/refresh", { method: "POST" });
      setCatalog(await api<Catalog>("/api/farms/controls/catalog"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-4 pb-10 pt-4 md:px-6">
      {/* ── Header: house, reachability, snapshot ─────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setLocation("/farms")}
          className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-soil-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Houses
        </button>
        <h1 className="text-[20px] font-bold text-soil-900">Controls</h1>
        <select
          value={houseId}
          onChange={(e) => setLocation(`/farms/controls/${e.target.value}`)}
          className="rounded-lg border border-soil-200 bg-white px-2.5 py-1.5 text-[13px] font-semibold text-soil-900"
        >
          {houses.map((h) => (
            <option key={h.houseId} value={h.houseId}>
              {h.code}
            </option>
          ))}
        </select>
        {status && (
          <span
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              status.live ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
            }`}
          >
            {status.live ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {status.controller ? (status.live ? "controller reachable" : "controller not reachable") : "no controller"}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">
          {status?.snapshot
            ? `settings kept ${fmtWhen(status.snapshot.takenAt)} · ${status.snapshot.registers.toLocaleString("en-IN")} registers`
            : "settings not yet kept"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {manage && houseId && (
            <button
              onClick={snapshotNow}
              disabled={busy !== null || !catalog?.pages.length}
              className="flex items-center gap-1.5 rounded-lg border border-soil-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-soil-900 hover:bg-yolk-50 disabled:opacity-50"
            >
              <Camera className="h-3.5 w-3.5" /> {busy === "snapshot" ? "Reading…" : "Keep settings now"}
            </button>
          )}
          {manage && (
            <button
              onClick={refreshCatalog}
              disabled={busy !== null}
              title={catalog?.fetchedAt ? `Catalogue fetched ${fmtWhen(catalog.fetchedAt)}` : "No catalogue yet"}
              className="flex items-center gap-1.5 rounded-lg border border-soil-200 bg-white px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-yolk-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy === "catalog" ? "animate-spin" : ""}`} />
              {catalog?.pages.length ? "Refresh catalogue" : "Fetch catalogue"}
            </button>
          )}
        </div>
      </div>

      {!catalog?.pages.length ? (
        <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-muted-foreground shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
          The controller catalogue has not been fetched yet.
          {manage ? " Use Fetch catalogue above; it asks the vendor for every page once." : " Ask a farm manager to fetch it."}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
          {/* ── Sections ─────────────────────────────────────────────── */}
          <nav className="rounded-2xl bg-white p-2 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)] lg:sticky lg:top-4 lg:self-start">
            {sections.map((s) => (
              <div key={s.title} className="mb-2">
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{s.title}</div>
                {s.pages.map((p) => (
                  <button
                    key={p.code}
                    onClick={() => setCode(p.code)}
                    title={p.vendor}
                    className={`block w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] leading-snug ${
                      p.code === code ? "bg-yolk-100 font-semibold text-yolk-800" : "text-soil-900 hover:bg-soil-50"
                    }`}
                  >
                    {p.title}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          {/* ── The page ─────────────────────────────────────────────── */}
          <section className="min-w-0 rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-soil-100/70 px-4 py-3">
              <div>
                <div className="text-[14px] font-bold text-soil-900">{current?.title ?? code}</div>
                <div className="text-[11px] text-muted-foreground">
                  {current?.vendor ?? page?.page.pathEn.join(" › ")}
                  {house ? ` · ${house.code}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {page?.source === "kept" && page.at && <span>as kept {fmtWhen(page.at)}</span>}
                {page?.source === "kept" && !page.at && <span>not yet kept</span>}
                {page?.source === "live" && page.at && <span>as the controller reports it, {fmtWhen(page.at)}</span>}
                {page?.source === "offline" && (
                  <span className="text-warning">controller not reachable{page.at ? ` — as kept ${fmtWhen(page.at)}` : ""}</span>
                )}
                {loadingPage && (
                  <span className="flex items-center gap-1">
                    <RefreshCw className="h-3 w-3 animate-spin" /> asking the controller
                  </span>
                )}
              </div>
            </header>
            {pageError && <div className="px-4 py-3 text-[12px] text-destructive">{pageError}</div>}
            {page?.page.shared && page.page.shared.length > 0 && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-soil-100/70 px-4 py-2 text-[12px]">
                {page.page.shared.map((f) => (
                  <span key={f.register} title={f.range ? `range ${range(f.range)}` : undefined}>
                    <span className="text-muted-foreground">{f.labelEn}</span>{" "}
                    <span className="font-semibold tabular-nums text-soil-900">
                      {show(page.values[f.register], f.options, f.kind)} {wordy(f.kind) ? "" : f.unit}
                    </span>
                  </span>
                ))}
              </div>
            )}
            {page?.page.type === "Form" && <FormPage page={page} />}
            {page?.page.type === "Table" && <TablePage page={page} />}
          </section>

          {/* ── Changed outside niko ─────────────────────────────────── */}
          <aside className="rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)] lg:col-start-2">
            <div className="border-b border-soil-100/70 px-4 py-3">
              <div className="text-[13px] font-bold text-soil-900">Changed outside niko</div>
              <div className="text-[11px] text-muted-foreground">
                Registers that differed between one kept copy of the settings and the next, last 30 days.
              </div>
            </div>
            {changes.length === 0 ? (
              <div className="px-4 py-5 text-[12px] text-muted-foreground">
                {status?.snapshot ? "Nothing has changed since the settings were first kept." : "Nothing to compare yet."}
              </div>
            ) : (
              <ul className="max-h-[50vh] overflow-y-auto divide-y divide-soil-100/70">
                {changes.map((c) => (
                  <li key={c.id} className="px-4 py-2.5 text-[12px]">
                    <div className="font-semibold text-soil-900">{c.labelEn}</div>
                    <div className="text-muted-foreground">{c.pageEn}</div>
                    <div className="mt-0.5 tabular-nums">
                      <span className="text-muted-foreground line-through">{show(c.before ?? undefined, c.options, c.kind)}</span>
                      <span className="mx-1.5 text-muted-foreground">→</span>
                      <span className="font-semibold text-soil-900">
                        {show(c.after ?? undefined, c.options, c.kind)} {wordy(c.kind) ? "" : c.unit}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {fmtWhen(c.seenAt)} · {c.source === "niko" ? "written by niko" : "on the panel or the vendor's site"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/** A form: one row per setting, the controller's value beside it. */
function FormPage({ page }: { page: PageLive }) {
  const fields = page.page.fields ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 text-left font-semibold">Setting</th>
            <th className="px-4 py-2 text-right font-semibold">Now</th>
            <th className="px-4 py-2 text-left font-semibold">Range</th>
            <th className="px-4 py-2 text-left font-semibold">What it does</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.register} className="border-t border-soil-100/70">
              <td className="px-4 py-2">
                <span className="font-medium text-soil-900">{f.labelEn}</span>
                {f.readOnly && (
                  <span className="ml-2 rounded border border-soil-200 px-1.5 text-[10px] text-muted-foreground">status</span>
                )}

              </td>
              <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                <span className={f.readOnly ? "text-muted-foreground" : "font-semibold text-soil-900"}>
                  {show(page.values[f.register], f.options, f.kind)}
                </span>
                {f.unit && !wordy(f.kind) && <span className="ml-1 text-[11px] text-muted-foreground">{f.unit}</span>}
              </td>
              <td className="whitespace-nowrap px-4 py-2 text-[11px] text-muted-foreground">
                {range(f.range)}
                {f.options.length > 0 && !f.readOnly && (
                  <span title={f.options.map((o) => `${o.value} = ${o.labelEn}`).join(", ")}>
                    {f.range ? " · " : ""}
                    {f.options.map((o) => o.labelEn).join(" / ")}
                  </span>
                )}
              </td>
              <td className="max-w-[60ch] px-4 py-2 text-[12px] leading-snug text-muted-foreground">{f.explain ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A grid: one row per level, age band or inlet; a register in every cell. Fan
 * cells are drawn as the vendor draws them, a circle per state, because
 * twenty-six columns of the word "continuous" is not a page anyone can read.
 */
function TablePage({ page }: { page: PageLive }) {
  const cols = page.page.columns ?? [];
  const rows = page.page.rows ?? [];
  /* Fan groups the ladder never switches on — the farm wires 22 of the 26 the
     controller allows — are left out, so the grid is as wide as the shed. */
  const fanCols = cols.filter(
    (c) => /^f\d+$/.test(c.key) && rows.some((r) => r.cells[c.key] && Number(page.values[r.cells[c.key]!] ?? 0) !== 0),
  );
  const plainCols = cols.filter((c) => !/^f\d+$/.test(c.key));
  const isLadder = page.page.code === "TFJB_TFJB_S";
  /** Rows the vendor pads out with zeros, dropped when every settable cell is zero — beyond the farm's 25 steps, or curve rows never filled. */
  const shown = rows.filter((r, i) => {
    if (i < 1) return true;
    // A schedule or curve row whose age is 0 is a row the vendor pads out, whatever else it holds.
    if (r.cells.day && Number(page.values[r.cells.day] ?? 0) === 0) return false;
    return Object.values(r.cells).some((reg) => {
      const v = Number(page.values[reg] ?? 0);
      return Number.isFinite(v) && v !== 0;
    });
  });
  return (
    <div className="overflow-x-auto">
      <table className="text-[12.5px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="sticky left-0 bg-white px-2 py-2 text-left font-semibold">{isLadder ? "Step" : "Row"}</th>
            {plainCols.map((c) => (
              <th key={c.key} className="max-w-[92px] px-2 py-2 text-right font-semibold leading-tight" title={`${c.labelEn}${c.range ? ` · range ${range(c.range)}` : ""}${c.explain ? `\n${c.explain}` : ""}`}>
                {isLadder ? c.labelEn.replace(/^Level\s+/i, "") : c.labelEn}
                {c.unit && !wordy(c.kind) && <span className="ml-1 normal-case tracking-normal text-muted-foreground/80">{c.unit}</span>}
              </th>
            ))}
            {fanCols.length > 0 && (
              <th className="px-1 py-2 text-left font-semibold" colSpan={fanCols.length} title={fanCols[0]!.options.map((o) => `${o.value} ${o.labelEn}`).join(" · ")}>
                Fan groups
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className="border-t border-soil-100/70">
              <td className="sticky left-0 bg-white px-2 py-1.5 font-semibold text-soil-900">{r.label}</td>
              {plainCols.map((c) => (
                <td key={c.key} className="px-2 py-1.5 text-right tabular-nums text-soil-900">
                  {r.cells[c.key]
                    ? c.key === "day" && Number(page.values[r.cells[c.key]!]) === 999
                      ? "onward"
                      : show(page.values[r.cells[c.key]!], c.options, c.kind)
                    : ""}
                </td>
              ))}
              {fanCols.map((c) => {
                const reg = r.cells[c.key];
                const v = reg ? page.values[reg] : undefined;
                const g = v == null ? null : FAN_GLYPH[String(Math.round(Number(v)))] ?? null;
                return (
                  <td key={c.key} className={`w-[18px] px-0 py-1.5 text-center text-[14px] leading-none ${g?.cls ?? "text-soil-200"}`} title={g ? `fan group ${c.key.slice(1)}: ${g.title}` : undefined}>
                    {g?.glyph ?? "·"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* What each column does, once, since a grid has no room for a sentence per cell. */}
      {(plainCols.some((c) => c.explain) || (page.page.shared ?? []).some((f) => f.explain)) && (
        <div className="border-t border-soil-100/70 px-3 py-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">What each column does</div>
          <dl className="grid gap-x-6 gap-y-1.5 text-[12px] md:grid-cols-2">
            {[...(page.page.shared ?? []), ...plainCols]
              .filter((c) => c.explain)
              .map((c) => (
                <div key={"key" in c ? c.key : c.register} className="grid grid-cols-[minmax(90px,140px)_1fr] gap-2">
                  <dt className="font-medium text-soil-900">{c.labelEn}</dt>
                  <dd className="m-0 leading-snug text-muted-foreground">{c.explain}</dd>
                </div>
              ))}
            {fanCols.length > 0 && fanCols[0]!.explain && (
              <div className="grid grid-cols-[minmax(90px,140px)_1fr] gap-2">
                <dt className="font-medium text-soil-900">Fan groups</dt>
                <dd className="m-0 leading-snug text-muted-foreground">{fanCols[0]!.explain}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
      {fanCols.length > 0 && (
        <div className="flex flex-wrap gap-4 px-3 py-2 text-[11px] text-muted-foreground">
          {Object.entries(FAN_GLYPH).map(([k, g]) => (
            <span key={k}>
              <span className={`mr-1 text-[14px] ${g.cls}`}>{g.glyph}</span>
              {g.title}
            </span>
          ))}
          {rows.length > shown.length && <span>{rows.length - shown.length} unused rows hidden</span>}
        </div>
      )}
    </div>
  );
}
