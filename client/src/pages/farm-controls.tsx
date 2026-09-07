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
import { ArrowLeft, Camera, Check, ClipboardList, RefreshCw, Settings2, Wifi, WifiOff, X } from "lucide-react";
import { api, ApiError } from "../api";
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
  /** The shed's ladder ceiling, from the controller's own status; rows above it are padding. */
  maxStep?: number | null;
}
interface Status {
  code: string;
  controller: boolean;
  live: boolean;
  snapshot: { takenAt: string; registers: number } | null;
}
interface ProposedChange {
  register: string;
  label: string;
  unit: string;
  before: string | null;
  after: string;
  critical: boolean;
}
interface Proposal {
  id: number;
  rule: string;
  title: string;
  reason: string;
  evidence: Record<string, unknown>;
  changes: ProposedChange[];
  status: string;
  createdAt: string;
  decidedAt: string | null;
  writtenAt: string | null;
  writeRecord: { confirmed?: boolean; refused?: boolean; registers?: Array<{ fullName: string; before: string | null; sent: string; after: string | null; took: boolean }>; error?: string } | null;
}
interface RuleInfo {
  key: string;
  title: string;
  description: string;
  defaults: Record<string, number>;
  params: Record<string, number>;
  enabled: boolean;
  houseOverride: boolean;
}
interface RulesDoc {
  farm: { writesEnabled: boolean };
  rules: RuleInfo[];
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
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [decided, setDecided] = useState<Proposal[]>([]);
  const [rules, setRules] = useState<RulesDoc | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [showDecided, setShowDecided] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const controlPerm = can("farms", "control");

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
  const loadProposals = () => {
    if (!houseId) return;
    api<{ proposals: Proposal[] }>(`/api/farms/controls/${houseId}/proposals`)
      .then((d) => setProposals(d.proposals))
      .catch((e) => {
        setProposals([]);
        if (e instanceof ApiError && e.status === 401) setNotice(e.message);
      });
    api<{ proposals: Proposal[] }>(`/api/farms/controls/${houseId}/proposals?status=written,failed,dismissed,superseded`)
      .then((d) => setDecided(d.proposals))
      .catch(() => setDecided([]));
  };
  const loadRules = () => {
    api<RulesDoc>(`/api/farms/controls/rules${houseId ? `?houseId=${houseId}` : ""}`)
      .then(setRules)
      .catch(() => setRules(null));
  };
  useEffect(() => {
    loadStatus();
    loadChanges();
    loadProposals();
    loadRules();
  }, [houseId]);

  const evaluateNow = async () => {
    setBusy("evaluate");
    setNotice(null);
    try {
      const r = await api<{ results: Array<{ code: string; drafts: number; created: number; superseded: number; skipped?: string }> }>(
        "/api/farms/controls/proposals/evaluate",
        { method: "POST", body: { houseId } },
      );
      const x = r.results[0];
      setNotice(x?.skipped ? `Could not evaluate: ${x.skipped}` : `${x?.drafts ?? 0} rule(s) had something to say · ${x?.created ?? 0} new · ${x?.superseded ?? 0} withdrawn`);
      loadProposals();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Evaluation failed");
    } finally {
      setBusy(null);
    }
  };
  const [confirming, setConfirming] = useState<number | null>(null);
  const decide = async (p: Proposal, action: "approve" | "dismiss", confirmed = false) => {
    // Approval asks once more, on the page itself: a browser dialog is swallowed in some shells.
    if (action === "approve" && !confirmed) {
      setConfirming(p.id);
      return;
    }
    setConfirming(null);
    setBusy(`p${p.id}`);
    setNotice(null);
    try {
      const r = await api<{ record?: { confirmed: boolean; refused: boolean; registers: Array<{ took: boolean }> } }>(`/api/farms/controls/proposals/${p.id}/${action}`, { method: "POST" });
      if (action === "approve") {
        const took = r.record?.registers.filter((x) => x.took).length ?? 0;
        setNotice(r.record?.confirmed ? `Written and read back: ${took} of ${p.changes.length} register(s) took.` : `The controller did not take every value: ${took} of ${p.changes.length}. See the decided list.`);
        loadStatus();
        loadChanges();
        setCode((c) => c); // the open page re-reads on the next refresh
      }
      loadProposals();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "That did not go through");
      loadProposals(); // the proposal may have been replaced under us
    } finally {
      setBusy(null);
    }
  };
  // proposals are replaced by every evaluation, so keep the list current while the page is open
  useEffect(() => {
    const t = setInterval(loadProposals, 60_000);
    return () => clearInterval(t);
  }, [houseId]);
  const saveRule = async (key: string, params: Record<string, number>, enabled: boolean, thisHouse = false) => {
    setBusy(`r${key}`);
    try {
      await api(`/api/farms/controls/rules/${key}`, { method: "PUT", body: { houseId: thisHouse ? houseId : null, params, enabled } });
      loadRules();
    } finally {
      setBusy(null);
    }
  };
  const setWrites = async (on: boolean) => {
    if (on && !window.confirm("Turn on writing to the sheds' controllers for the whole farm? Approved proposals will then be sent to the controllers.")) return;
    setBusy("farm");
    try {
      await api("/api/farms/controls/rules/farm", { method: "PUT", body: { houseId: null, params: { writesEnabled: on }, enabled: true } });
      loadRules();
    } finally {
      setBusy(null);
    }
  };

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
    api<{ page: PageDef; values: Record<string, string>; at: string | null; maxStep?: number | null }>(`/api/farms/controls/${houseId}/page/${code}`)
      .then((d) => {
        if (!stop) setPage({ page: d.page, values: d.values, at: d.at, source: "kept", maxStep: d.maxStep });
      })
      .catch((e) => {
        if (!stop) setPageError(e instanceof Error ? e.message : "Could not read the page");
      });
    api<{ page: PageDef; live: boolean; values: Record<string, string>; at: string; changes: number; maxStep?: number | null }>(
      `/api/farms/controls/${houseId}/page/${code}/live`,
    )
      .then((d) => {
        if (stop) return;
        if (d.live) {
          setPage({ page: d.page, values: d.values, at: d.at, source: "live", maxStep: d.maxStep });
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
              onClick={evaluateNow}
              disabled={busy !== null || !status?.snapshot}
              title="Ask every rule what this week says about this house"
              className="flex items-center gap-1.5 rounded-lg border border-soil-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-soil-900 hover:bg-yolk-50 disabled:opacity-50"
            >
              <ClipboardList className="h-3.5 w-3.5" /> {busy === "evaluate" ? "Asking…" : "Evaluate now"}
            </button>
          )}
          {manage && (
            <button
              onClick={() => setShowRules((v) => !v)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold ${showRules ? "border-yolk-300 bg-yolk-100 text-yolk-800" : "border-soil-200 bg-white text-soil-900 hover:bg-yolk-50"}`}
            >
              <Settings2 className="h-3.5 w-3.5" /> Rules
              {rules && (
                <span className={`ml-1 rounded-full px-1.5 text-[10px] ${rules.farm.writesEnabled ? "bg-green-100 text-green-800" : "bg-soil-100 text-muted-foreground"}`}>
                  {rules.farm.writesEnabled ? "writing on" : "writing off"}
                </span>
              )}
            </button>
          )}
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

          {/* ── Proposals and rules, above the page ────────────────────── */}
          <div className="min-w-0 space-y-4 lg:col-start-2">
            {notice && (
              <div className="rounded-lg border border-yolk-200 bg-yolk-50 px-3 py-2 text-[12px] text-yolk-800">{notice}</div>
            )}
            {showRules && rules && (
              <RulesPanel rules={rules} busy={busy} onSave={saveRule} onWrites={setWrites} manage={manage} houseCode={house?.code ?? ""} />
            )}
            <ProposalsPanel
              proposals={proposals}
              decided={decided}
              showDecided={showDecided}
              onToggleDecided={() => setShowDecided((v) => !v)}
              canDecide={controlPerm}
              writesOn={rules?.farm.writesEnabled ?? false}
              busy={busy}
              onDecide={decide}
              confirming={confirming}
              onCancel={() => setConfirming(null)}
              houseCode={house?.code ?? ""}
            />
          </div>

          {/* ── The page ─────────────────────────────────────────────── */}
          <section className="min-w-0 rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)] lg:col-start-2">
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
    // The ladder stops where the shed's ceiling is; the vendor pads the rows above it.
    if (isLadder && page.maxStep && r.id > page.maxStep) return false;
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
          {rows.length > shown.length && (
            <span>
              {isLadder && page.maxStep
                ? `steps above ${page.maxStep}, the shed's ceiling, are not in use`
                : `${rows.length - shown.length} unused rows hidden`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** What the rules want changed on this house, and what a person did about it. */
function ProposalsPanel({
  proposals,
  decided,
  showDecided,
  onToggleDecided,
  canDecide,
  writesOn,
  busy,
  onDecide,
  confirming,
  onCancel,
  houseCode,
}: {
  proposals: Proposal[];
  decided: Proposal[];
  showDecided: boolean;
  onToggleDecided: () => void;
  canDecide: boolean;
  writesOn: boolean;
  busy: string | null;
  onDecide: (p: Proposal, action: "approve" | "dismiss", confirmed?: boolean) => void;
  confirming: number | null;
  onCancel: () => void;
  houseCode: string;
}) {
  return (
    <section className="rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-soil-100/70 px-4 py-3">
        <div>
          <div className="text-[14px] font-bold text-soil-900">
            Proposals for {houseCode}
            {proposals.length > 0 && <span className="ml-2 rounded-full bg-yolk-100 px-2 text-[11px] text-yolk-800">{proposals.length} open</span>}
          </div>
          <div className="text-[11px] text-muted-foreground">
            What the farm's climate rules would change on this shed, from the last week's data. Nothing is written until someone approves it.
          </div>
        </div>
        <button onClick={onToggleDecided} className="text-[11px] text-muted-foreground hover:text-soil-900">
          {showDecided ? "hide decided" : `decided (${decided.length})`}
        </button>
      </header>
      {proposals.length === 0 && (
        <div className="px-4 py-4 text-[12px] text-muted-foreground">No open proposals. The rules are asked every morning after the settings are kept, and by Evaluate now.</div>
      )}
      <ul className="divide-y divide-soil-100/70">
        {proposals.map((p) => (
          <li key={p.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[13px] font-semibold text-soil-900">{p.title}</div>
              <div className="text-[11px] text-muted-foreground">
                {p.rule} · {fmtWhen(p.createdAt)}
              </div>
            </div>
            <p className="mt-1 max-w-[80ch] text-[12.5px] leading-snug text-soil-900">{p.reason}</p>
            {Array.isArray(p.evidence.ladder) ? (
              <LadderGrid ladder={p.evidence.ladder as LadderRow[]} registers={p.changes.length} />
            ) : p.changes.length > 0 ? (
              <table className="mt-2 text-[12.5px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-1 pr-6 text-left font-semibold">Setting</th>
                    <th className="py-1 pr-6 text-right font-semibold">Was</th>
                    <th className="py-1 pr-6 text-right font-semibold">Will be</th>
                  </tr>
                </thead>
                <tbody>
                  {p.changes.map((c) => (
                    <tr key={c.register} className="border-t border-soil-100/70">
                      <td className="py-1 pr-6">
                        {c.label}
                        {c.critical && <span className="ml-2 rounded border border-yolk-300 px-1 text-[10px] text-yolk-800">master</span>}
                      </td>
                      <td className="py-1 pr-6 text-right tabular-nums text-muted-foreground">{show(c.before ?? undefined)}</td>
                      <td className="py-1 pr-6 text-right tabular-nums font-semibold text-soil-900">
                        {c.after} {c.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="mt-2 text-[11.5px] text-muted-foreground">Nothing to write; this one asks for a sitting at the panel.</div>
            )}
            {canDecide && confirming === p.id && (
              <div className="mt-2 rounded-lg border border-yolk-300 bg-yolk-50 px-3 py-2 text-[12px] text-soil-900">
                <div className="font-semibold">
                  Send {p.changes.length} register{p.changes.length === 1 ? "" : "s"} to {houseCode}?
                  {p.changes.some((c) => c.critical) && <span className="ml-2 font-normal text-yolk-800">This changes a master register on a live shed.</span>}
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  niko reads the registers, writes, and reads them back until the controller reports the new values, up to a minute or two for a whole ladder.
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => onDecide(p, "approve", true)}
                    disabled={busy !== null}
                    className="rounded-lg bg-yolk-500 px-3 py-1 text-[12px] font-semibold text-white hover:bg-yolk-600 disabled:opacity-50"
                  >
                    {busy === `p${p.id}` ? "Sending…" : "Yes, send"}
                  </button>
                  <button onClick={onCancel} disabled={busy !== null} className="rounded-lg border border-soil-200 bg-white px-3 py-1 text-[12px] hover:bg-soil-50 disabled:opacity-50">
                    Not now
                  </button>
                </div>
              </div>
            )}
            {canDecide && confirming !== p.id && (
              <div className="mt-2 flex items-center gap-2">
                {p.changes.length > 0 && (
                  <button
                    onClick={() => onDecide(p, "approve")}
                    disabled={busy !== null || !writesOn}
                    title={writesOn ? "Write these values to the controller and read them back" : "Writing to controllers is off for the farm; a manager turns it on under Rules"}
                    className="flex items-center gap-1 rounded-lg bg-yolk-500 px-3 py-1 text-[12px] font-semibold text-white hover:bg-yolk-600 disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" /> {busy === `p${p.id}` ? "Sending…" : "Approve and send"}
                  </button>
                )}
                <button
                  onClick={() => onDecide(p, "dismiss")}
                  disabled={busy !== null}
                  className="flex items-center gap-1 rounded-lg border border-soil-200 bg-white px-3 py-1 text-[12px] text-soil-900 hover:bg-soil-50 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" /> Dismiss
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {showDecided && decided.length > 0 && (
        <ul className="divide-y divide-soil-100/70 border-t border-soil-100/70 bg-soil-50/40">
          {decided.map((p) => (
            <li key={p.id} className="px-4 py-2 text-[12px]">
              <span
                className={`mr-2 rounded px-1.5 text-[10px] uppercase tracking-wide ${
                  p.status === "written" ? "bg-green-100 text-green-800" : p.status === "failed" ? "bg-red-100 text-red-800" : "bg-soil-100 text-muted-foreground"
                }`}
              >
                {p.status}
              </span>
              <span className="font-medium text-soil-900">{p.title}</span>
              <span className="ml-2 text-muted-foreground">{fmtWhen(p.decidedAt ?? p.createdAt)}</span>
              {p.writeRecord?.registers && (
                <span className="ml-2 text-muted-foreground">
                  {p.writeRecord.registers.filter((r) => r.took).length} of {p.writeRecord.registers.length} took
                </span>
              )}
              {p.writeRecord?.error && <span className="ml-2 text-destructive">{p.writeRecord.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface LadderRow {
  step: number;
  offsetWas: number | null;
  offset: number;
  fansWas: number;
  fans: number;
  c1Was?: number | null;
  c1?: number;
  c2Was?: number | null;
  c2?: number;
}

/** A rebuilt ladder, step by step: where each step starts and how many fans it runs, was and will be. */
function LadderGrid({ ladder, registers }: { ladder: LadderRow[]; registers: number }) {
  const curtains = ladder.some((r) => r.c1 != null);
  const cell = (was: number | null, will: number, unit = "") => (
    <>
      <td className="py-0.5 pr-3 text-right tabular-nums text-muted-foreground">{was == null ? "—" : `${was}${unit}`}</td>
      <td className={`py-0.5 pr-5 text-right tabular-nums ${was !== will ? "font-semibold text-soil-900" : "text-muted-foreground"}`}>
        {will}
        {unit}
      </td>
    </>
  );
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="py-1 pr-4 text-left font-semibold">Step</th>
            <th className="py-1 pr-3 text-right font-semibold">Starts, was</th>
            <th className="py-1 pr-5 text-right font-semibold">Will be</th>
            <th className="py-1 pr-3 text-right font-semibold">Fans, was</th>
            <th className="py-1 pr-5 text-right font-semibold">Will be</th>
            {curtains && (
              <>
                <th className="py-1 pr-3 text-right font-semibold">Gable curtain, was</th>
                <th className="py-1 pr-5 text-right font-semibold">Will be</th>
                <th className="py-1 pr-3 text-right font-semibold">Side curtains, was</th>
                <th className="py-1 pr-5 text-right font-semibold">Will be</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {ladder.map((r) => (
            <tr key={r.step} className="border-t border-soil-100/70">
              <td className="py-0.5 pr-4 tabular-nums">{r.step}</td>
              {cell(r.offsetWas, r.offset, "°")}
              {cell(r.fansWas, r.fans)}
              {curtains && cell(r.c1Was ?? null, r.c1 ?? 0, "%")}
              {curtains && cell(r.c2Was ?? null, r.c2 ?? 0, "%")}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1 text-[11px] text-muted-foreground">
        "Starts" is degrees above the tunnel temperature. {registers} registers on the ladder page change; fans are added in the order the ladder already uses
        {curtains ? "; the gable curtain opens fully before the side curtains start" : ""}.
      </div>
    </div>
  );
}

/** The farm's climate rules and their numbers, and the switch that lets approved proposals reach a controller. */
function RulesPanel({
  rules,
  busy,
  onSave,
  onWrites,
  manage,
  houseCode,
}: {
  rules: RulesDoc;
  busy: string | null;
  onSave: (key: string, params: Record<string, number>, enabled: boolean, thisHouse?: boolean) => void;
  onWrites: (on: boolean) => void;
  manage: boolean;
  houseCode: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  // Whether a save goes to this shed only, or to the farm. A rule already set for this shed starts as "this shed".
  const [scope, setScope] = useState<Record<string, boolean>>({});
  const forHouse = (r: RuleInfo) => scope[r.key] ?? r.houseOverride;
  const value = (r: RuleInfo, k: string) => drafts[r.key]?.[k] ?? String(r.params[k] ?? r.defaults[k] ?? "");
  const edit = (r: RuleInfo, k: string, v: string) => setDrafts((d) => ({ ...d, [r.key]: { ...(d[r.key] ?? {}), [k]: v } }));
  const commit = (r: RuleInfo, enabled = r.enabled) => {
    const params: Record<string, number> = {};
    for (const k of Object.keys(r.defaults)) {
      const n = Number(value(r, k));
      if (Number.isFinite(n)) params[k] = n;
    }
    onSave(r.key, params, enabled, forHouse(r));
  };
  return (
    <section className="rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-soil-100/70 px-4 py-3">
        <div>
          <div className="text-[14px] font-bold text-soil-900">Climate rules</div>
          <div className="text-[11px] text-muted-foreground">The numbers the rules read: farm-wide, or set for one shed with "this shed only".</div>
        </div>
        {manage && (
          <label className="flex items-center gap-2 text-[12px] font-semibold text-soil-900">
            <input type="checkbox" checked={rules.farm.writesEnabled} disabled={busy !== null} onChange={(e) => onWrites(e.target.checked)} />
            Writing to controllers {rules.farm.writesEnabled ? "on" : "off"}
          </label>
        )}
      </header>
      <ul className="divide-y divide-soil-100/70">
        {rules.rules.map((r) => (
          <li key={r.key} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[13px] font-semibold text-soil-900">{r.title}</div>
              {manage && (
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  {r.houseOverride && <span className="rounded bg-yolk-100 px-1.5 text-[10px] text-yolk-800">set for {houseCode}</span>}
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={forHouse(r)} disabled={busy !== null || !houseCode} onChange={(e) => setScope((s) => ({ ...s, [r.key]: e.target.checked }))} /> {houseCode || "this shed"} only
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={r.enabled} disabled={busy !== null} onChange={(e) => commit(r, e.target.checked)} /> enabled
                  </label>
                </div>
              )}
            </div>
            <p className="mt-0.5 max-w-[80ch] text-[12px] leading-snug text-muted-foreground">{r.description}</p>
            {Object.keys(r.defaults).length > 0 && (
              <div className="mt-2 flex flex-wrap items-end gap-3">
                {Object.keys(r.defaults).map((k) => (
                  <label key={k} className="text-[11px] text-muted-foreground">
                    <div>{k}</div>
                    <input
                      type="number"
                      step="any"
                      value={value(r, k)}
                      disabled={!manage || busy !== null}
                      onChange={(e) => edit(r, k, e.target.value)}
                      className="mt-0.5 w-24 rounded border border-soil-200 px-2 py-1 text-[12px] tabular-nums text-soil-900"
                    />
                  </label>
                ))}
                {manage && (
                  <button
                    onClick={() => commit(r)}
                    disabled={busy !== null || !drafts[r.key]}
                    className="rounded-lg border border-soil-200 bg-white px-3 py-1 text-[12px] font-semibold text-soil-900 hover:bg-yolk-50 disabled:opacity-50"
                  >
                    {busy === `r${r.key}` ? "Saving…" : "Save"}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
