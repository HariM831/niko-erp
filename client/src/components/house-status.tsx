/**
 * The sheds in one word each — the home tile — and one shed's last 24 hours —
 * the Controls panel. Both read GET /api/farms/iot/status; the verdict and
 * its bands are worked out on the server (services/iot/status.ts).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { RefreshCw, Thermometer } from "lucide-react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";

export type Level = "ok" | "watch" | "severe" | "critical";
export type Verdict = Level | "offline";

export interface HourCell {
  start: string;
  samples: number;
  tempAvg: number | null;
  rhAvg: number | null;
  bftMax: number | null;
  level: Level | null;
}

export interface DayStatus {
  from: string;
  to: string;
  samples: number;
  hoursCovered: number;
  hoursByLevel: Record<Level, number>;
  worst: Level;
  worstAt: string | null;
  worstReason: string | null;
  tempAvg: number | null;
  tempMin: number | null;
  tempMax: number | null;
  overTargetMax: number | null;
  rhAvg: number | null;
  rhMax: number | null;
  wetBulbMax: number | null;
  bftMax: number | null;
  thiMax: number | null;
  co2Max: number | null;
  ventMax: number | null;
  padsHours: number | null;
  airSpeedKnown: boolean;
  mortalityToday: number | null;
  waterPerBirdMl: number | null;
  feedPerBirdG: number | null;
  birdAgeDays: number | null;
  hours: HourCell[];
}

export interface HouseStatus {
  houseId: string;
  code: string;
  purpose: string;
  /** The site the house stands on; the home tile groups by it. */
  site: string | null;
  verdict: Verdict;
  reasons: string[];
  now: {
    at: string | null;
    tempC: number | null;
    targetTempC: number | null;
    humidityPct: number | null;
    co2Ppm: number | null;
    feelsLikeC: number | null;
    wetBulbC: number | null;
    thi: number | null;
    fans: number | null;
    ventLevel: number | null;
    padsOn: boolean | null;
    birdCount: number | null;
    birdAgeDays: number | null;
  };
  day: DayStatus | null;
}

export interface FarmStatus {
  at: string;
  overall: Verdict;
  counts: Record<Verdict, number>;
  houses: HouseStatus[];
  poll: { at: string; ok: boolean; error: string | null } | null;
}

export const VERDICT: Record<Verdict, { label: string; dot: string; chip: string; cell: string }> = {
  ok: { label: "OK", dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700", cell: "bg-emerald-400" },
  watch: { label: "Watch", dot: "bg-amber-400", chip: "bg-amber-50 text-amber-700", cell: "bg-amber-400" },
  severe: { label: "Severe", dot: "bg-orange-600", chip: "bg-orange-50 text-orange-700", cell: "bg-orange-600" },
  critical: { label: "Critical", dot: "bg-rose-600", chip: "bg-rose-50 text-rose-700", cell: "bg-rose-600" },
  offline: { label: "Offline", dot: "bg-soil-400", chip: "bg-soil-100 text-soil-600", cell: "bg-soil-200" },
};

const num = (v: number | null | undefined, d = 1, unit = "") => (v == null ? "—" : `${v.toFixed(d)}${unit}`);
const hhmm = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "—";

/** The status query, and the one-click "check now": a fresh poll where the user may ask for one, then a re-read. */
export function useFarmStatus() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["farm-status"],
    queryFn: () => api<FarmStatus>("/api/farms/iot/status"),
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  const checkNow = async () => {
    setChecking(true);
    setNote(null);
    try {
      if (can("farms", "manage")) {
        try {
          await api("/api/farms/iot/fetch-now", { method: "POST" });
        } catch (e) {
          // 409 is a poll already running and 422 no vendor token here: either way the stored readings are the answer.
          if (!(e instanceof ApiError && (e.status === 409 || e.status === 422))) {
            setNote(`Could not reach the controllers (${e instanceof Error ? e.message : "error"}); showing the last readings.`);
          }
        }
      }
      await qc.invalidateQueries({ queryKey: ["farm-status"] });
    } finally {
      setChecking(false);
    }
  };
  return { ...query, checkNow, checking, note };
}

function Dot({ v, className = "h-2.5 w-2.5" }: { v: Verdict; className?: string }) {
  return <span className={`inline-block shrink-0 rounded-full ${VERDICT[v].dot} ${className}`} />;
}

/** 24 small bars, one an hour, oldest on the left, coloured by the worst level in the hour. */
export function HourStrip({ hours, tall }: { hours: HourCell[]; tall?: boolean }) {
  return (
    <div className="flex gap-[2px]">
      {hours.map((h) => (
        <span
          key={h.start}
          title={`${hhmm(h.start)} · ${h.level ? VERDICT[h.level].label : "no data"}${h.tempAvg != null ? ` · ${h.tempAvg} °C` : ""}${h.rhAvg != null ? ` · ${Math.round(h.rhAvg)}%` : ""}${h.bftMax != null ? ` · feels ${h.bftMax} °C` : ""}`}
          className={`flex-1 rounded-sm ${tall ? "h-6" : "h-2.5"} ${h.level ? VERDICT[h.level].cell : "bg-soil-100"}`}
        />
      ))}
    </div>
  );
}

/* ── Home: summary first, exceptions only; a site opens into its day ────── */

/** When the shed's current non-ok spell began, from the hour cells: the start of the trailing run of hours at or above watch. */
function sinceWhen(h: HouseStatus): string | null {
  if (h.verdict === "ok" || h.verdict === "offline" || !h.day) return null;
  const cells = h.day.hours;
  let i = cells.length - 1;
  while (i > 0 && cells[i - 1]!.level && cells[i - 1]!.level !== "ok") i--;
  return cells[i]?.start ?? null;
}

/** The share of shed-hours in the last day that were comfortable, across a set of sheds. */
function okShare(sheds: HouseStatus[]): number | null {
  let ok = 0;
  let all = 0;
  for (const h of sheds) {
    if (!h.day) continue;
    ok += h.day.hoursByLevel.ok;
    all += h.day.hoursCovered;
  }
  return all ? Math.round((ok / all) * 100) : null;
}

const RANK: Record<Verdict, number> = { ok: 0, offline: 1, watch: 2, severe: 3, critical: 4 };
const worstOf = (sheds: HouseStatus[]): Verdict => sheds.reduce<Verdict>((w, h) => (RANK[h.verdict] > RANK[w] ? h.verdict : w), "ok");
const dayMonth = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(new Date(iso)) : "—";

export function BirdComfortTile() {
  const { data, isLoading, isError, checkNow, checking, note } = useFarmStatus();
  const [open, setOpen] = useState<string | null>(null);
  // No farms permission, or the module is off: the tile stays away, like People.
  if (isError) return null;

  const sites = new Map<string, HouseStatus[]>();
  for (const h of data?.houses ?? []) {
    const k = h.site ?? "Farm";
    sites.set(k, [...(sites.get(k) ?? []), h]);
  }
  const attention = (data?.houses ?? []).filter((h) => h.verdict !== "ok" && h.verdict !== "offline").sort((a, b) => RANK[b.verdict] - RANK[a.verdict]);
  const offline = (data?.houses ?? []).filter((h) => h.verdict === "offline");
  const fine = (data?.houses ?? []).length - attention.length - offline.length;
  const opened = open ? sites.get(open) : undefined;

  return (
    <div className="rounded-2xl bg-white p-4 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-yolk-50 text-yolk-600">
            <Thermometer size={15} />
          </span>
          <h2 className="text-[14px] font-bold text-soil-900">Bird comfort</h2>
          {data && data.overall !== "ok" && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${VERDICT[data.overall].chip}`}>{VERDICT[data.overall].label}</span>}
        </div>
        <div className="flex items-center gap-3">
          {data && <span className="text-[11px] text-soil-400">as of {hhmm(data.at)}</span>}
          <button
            onClick={checkNow}
            disabled={checking}
            className="flex items-center gap-1.5 rounded-lg bg-yolk-500 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-yolk-600 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} /> {checking ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>
      {note && <div className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">{note}</div>}
      {isLoading || !data ? (
        <div className="py-4 text-[12px] text-soil-400">Reading the sheds…</div>
      ) : !data.houses.length ? (
        <div className="py-4 text-[12px] text-soil-400">No house has a controller linked yet.</div>
      ) : (
        <>
          {/* One figure per site: the share of shed-hours that were comfortable in the last day. Tap a site for its day. */}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {[...sites].map(([site, sheds]) => {
              const share = okShare(sheds);
              const worst = worstOf(sheds);
              const live = sheds.filter((h) => h.verdict !== "offline").length;
              const shown: Verdict = worst === "offline" && live ? "ok" : worst;
              const isOpen = open === site;
              return (
                <button
                  key={site}
                  onClick={() => setOpen(isOpen ? null : site)}
                  aria-expanded={isOpen}
                  className={`rounded-xl border px-3 py-2.5 text-left transition hover:bg-yolk-50 ${isOpen ? "border-yolk-300 bg-yolk-50/60" : "border-soil-100"}`}
                >
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-soil-400">
                    {site} · {sheds.length} shed{sheds.length === 1 ? "" : "s"}
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-[22px] font-bold tabular-nums leading-tight text-soil-900">{share == null ? "—" : `${share}%`}</span>
                    <span className={`rounded-full px-1.5 text-[10px] font-bold ${VERDICT[shown].chip}`}>{VERDICT[shown].label}</span>
                  </div>
                  <div className="text-[11px] text-soil-500">
                    of shed-hours comfortable, last 24 h
                    {live < sheds.length ? ` · ${sheds.length - live} controller${sheds.length - live === 1 ? "" : "s"} off` : ""}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Only the sheds that need a look, one line each, worst first. */}
          {attention.length > 0 && (
            <div className="mt-3 grid gap-1.5">
              {attention.map((h) => {
                const since = sinceWhen(h);
                const why = [h.reasons.join(" · "), h.now.tempC != null ? num(h.now.tempC, 1, "°") : "", h.now.fans != null ? `${h.now.fans} fans` : ""].filter(Boolean).join(" · ");
                return (
                  <Link
                    key={h.houseId}
                    href={`/farms/controls/${h.houseId}`}
                    className={`grid grid-cols-[auto_44px_1fr] items-center gap-2.5 rounded-lg px-3 py-1.5 text-[12.5px] transition hover:brightness-95 sm:grid-cols-[auto_44px_1fr_auto] ${VERDICT[h.verdict].chip}`}
                  >
                    <Dot v={h.verdict} />
                    <span className="font-bold">{h.code}</span>
                    <span className="truncate text-soil-700" title={why}>
                      {why}
                    </span>
                    <span className="hidden whitespace-nowrap text-[11px] text-soil-500 sm:inline">{since ? `since ${hhmm(since)}` : ""}</span>
                  </Link>
                );
              })}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-soil-500">
            {fine > 0 && (
              <span className="flex items-center gap-1.5">
                <Dot v="ok" className="h-2 w-2" />
                {attention.length ? `${fine} other shed${fine === 1 ? "" : "s"}` : `All ${fine} shed${fine === 1 ? "" : "s"}`} comfortable through the last 24 hours.
              </span>
            )}
            {offline.length > 0 && (
              <span className="flex items-center gap-1.5" title={offline.map((h) => `${h.code}: ${h.reasons.join(", ")}`).join(" · ")}>
                <Dot v="offline" className="h-2 w-2" />
                {offline.map((h) => h.code).join(", ")} controller{offline.length === 1 ? "" : "s"} off
                {offline.length === 1 && offline[0]!.now.at ? ` since ${dayMonth(offline[0]!.now.at)}` : ""}.
              </span>
            )}
          </div>

          {/* A site, opened: every shed's day as a strip, one row each. */}
          {open && opened && (
            <div className="mt-3 border-t border-soil-100 pt-3">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-wide text-soil-400">
                <span>{open} · last 24 hours</span>
                <span className="flex gap-3 font-normal normal-case tracking-normal">
                  {(["ok", "watch", "severe", "critical"] as Level[]).map((l) => (
                    <span key={l} className="flex items-center gap-1">
                      <Dot v={l} className="h-2 w-2" />
                      {VERDICT[l].label}
                    </span>
                  ))}
                </span>
              </div>
              <div className="grid gap-1">
                {opened.map((h) => (
                  <Link
                    key={h.houseId}
                    href={`/farms/controls/${h.houseId}`}
                    className="grid grid-cols-[34px_1fr_50px] items-center gap-2.5 rounded-md px-1 py-0.5 hover:bg-yolk-50 sm:grid-cols-[34px_1fr_50px_64px]"
                    title={h.reasons.join(" · ") || `feels-like ${num(h.now.feelsLikeC, 1, " °C")}`}
                  >
                    <span className="flex items-center gap-1.5 text-[12px] font-bold text-soil-900">
                      <Dot v={h.verdict} className="h-2 w-2" />
                      {h.code}
                    </span>
                    {h.day ? <HourStrip hours={h.day.hours} /> : <span className="h-2.5 rounded-sm bg-soil-100" />}
                    <span className="text-right text-[12px] tabular-nums text-soil-700">{h.verdict === "offline" ? "off" : num(h.now.tempC, 1, "°")}</span>
                    <span className="hidden text-right text-[11px] tabular-nums text-soil-400 sm:inline">{h.now.fans != null ? `${h.now.fans} fans` : ""}</span>
                  </Link>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-[34px_1fr_50px] gap-2.5 text-[10px] text-soil-400 sm:grid-cols-[34px_1fr_50px_64px]">
                <span />
                <span className="flex justify-between">
                  <span>{hhmm(opened[0]?.day?.from ?? null)} yesterday</span>
                  <span>now</span>
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Controls: one shed's last 24 hours ─────────────────────────────────── */

function Fig({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bad" | "warn" }) {
  const color = tone === "bad" ? "text-rose-600" : tone === "warn" ? "text-amber-600" : "text-soil-900";
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-[15px] font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="truncate text-[10.5px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Last24Hours({ houseId }: { houseId: string }) {
  const { data, isLoading, isError, checkNow, checking, note } = useFarmStatus();
  const h = data?.houses.find((x) => x.houseId === houseId);
  const d = h?.day;

  return (
    <section className="rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-soil-100/70 px-4 py-3">
        <div className="flex items-center gap-2">
          {h && <Dot v={h.verdict} />}
          <div>
            <div className="text-[13px] font-bold text-soil-900">
              Last 24 hours{h ? ` · now ${VERDICT[h.verdict].label.toLowerCase()}` : ""}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {h?.reasons.length ? h.reasons.join(" · ") : "Bird comfort from feels-like, wet-bulb, temperature against target, CO₂ and humidity."}
            </div>
          </div>
        </div>
        <button
          onClick={checkNow}
          disabled={checking}
          className="flex items-center gap-1.5 rounded-lg border border-soil-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-soil-900 hover:bg-yolk-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} /> {checking ? "Checking…" : "Check now"}
        </button>
      </header>
      {note && <div className="px-4 pt-2 text-[11px] text-amber-700">{note}</div>}
      {isLoading ? (
        <div className="px-4 py-5 text-[12px] text-muted-foreground">Reading the last day…</div>
      ) : isError ? (
        <div className="px-4 py-5 text-[12px] text-destructive">Could not read the shed's status.</div>
      ) : !d || !d.samples ? (
        <div className="px-4 py-5 text-[12px] text-muted-foreground">No readings from this shed in the last 24 hours.</div>
      ) : (
        <div className="space-y-3 px-4 py-3">
          <div>
            <HourStrip hours={d.hours} tall />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{hhmm(d.from)}</span>
              <span>{hhmm(d.hours[12]?.start ?? null)}</span>
              <span>now</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
            {(["ok", "watch", "severe", "critical"] as Level[]).map((l) => (
              <span key={l} className="flex items-center gap-1.5">
                <Dot v={l} className="h-2 w-2" />
                <span className="text-muted-foreground">{VERDICT[l].label}</span>
                <span className="font-semibold tabular-nums text-soil-900">{d.hoursByLevel[l].toFixed(1)} h</span>
              </span>
            ))}
            {d.hoursCovered < 23 && <span className="text-amber-700">{(24 - d.hoursCovered).toFixed(1)} h with no readings</span>}
          </div>
          {d.worst !== "ok" && (
            <div className={`rounded-lg px-3 py-1.5 text-[12px] ${VERDICT[d.worst].chip}`}>
              Worst: {VERDICT[d.worst].label.toLowerCase()} at {hhmm(d.worstAt)}
              {d.worstReason ? ` — ${d.worstReason}` : ""}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
            <Fig label="Temperature" value={num(d.tempAvg, 1, " °C")} sub={`${num(d.tempMin, 1)} – ${num(d.tempMax, 1)} °C`} />
            <Fig
              label="Over target, max"
              value={num(d.overTargetMax, 1, " °C")}
              tone={d.overTargetMax != null && d.overTargetMax > 4 ? "bad" : d.overTargetMax != null && d.overTargetMax > 2 ? "warn" : undefined}
            />
            <Fig label="Humidity" value={num(d.rhAvg, 0, "%")} sub={`max ${num(d.rhMax, 0, "%")}`} tone={d.rhMax != null && d.rhMax > 82 ? "warn" : undefined} />
            <Fig
              label="Feels-like, max"
              value={num(d.bftMax, 1, " °C")}
              sub={d.airSpeedKnown ? undefined : "still air assumed"}
              tone={d.bftMax != null && d.bftMax >= 31 ? "bad" : d.bftMax != null && d.bftMax >= 29 ? "warn" : undefined}
            />
            <Fig label="Wet-bulb, max" value={num(d.wetBulbMax, 1, " °C")} tone={d.wetBulbMax != null && d.wetBulbMax >= 29 ? "bad" : d.wetBulbMax != null && d.wetBulbMax >= 27 ? "warn" : undefined} />
            <Fig label="THI, max" value={num(d.thiMax, 1)} sub="Thom, no air speed" />
            <Fig label="CO₂, max" value={num(d.co2Max, 0, " ppm")} tone={d.co2Max != null && d.co2Max > 2500 ? "bad" : d.co2Max != null && d.co2Max > 1500 ? "warn" : undefined} />
            <Fig label="Pads ran" value={num(d.padsHours, 1, " h")} sub={d.ventMax != null ? `top vent step ${d.ventMax}` : undefined} />
            <Fig label="Mortality today" value={num(d.mortalityToday, 0)} />
            <Fig label="Water / bird" value={num(d.waterPerBirdMl, 0, " ml")} />
            <Fig label="Feed / bird" value={num(d.feedPerBirdG, 0, " g")} />
            <Fig label="Age" value={d.birdAgeDays != null ? `${Math.floor(d.birdAgeDays / 7)} wk` : "—"} sub={d.birdAgeDays != null ? `${d.birdAgeDays} days` : undefined} />
          </div>
        </div>
      )}
    </section>
  );
}
