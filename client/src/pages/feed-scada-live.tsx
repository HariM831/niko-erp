/**
 * Feed Mill › Live Mill — the SCADA's main screen, in niko.
 *
 * Laid out like WinCC's "Batching section" screen on the mill PC: the two
 * scales and the bin table along the top, the plant drawn in the middle —
 * bins, elevators, conveyors, grinder, mixer, silos, green while they run — the
 * amps on the right and the mode and holds along the bottom.
 *
 * VIEW ONLY. There is not one button here that reaches the mill: starting,
 * stopping, holding and resetting stay at the SCADA, where the operator can
 * see the plant. The values are the helper's latest reading (shared/scada-live.ts
 * maps each one to its tag), and the screen
 * says plainly when they are stale rather than showing old numbers as now.
 *
 * Where the values come from: WinCC's OPC UA server is not installed on the
 * mill PC (checked 6 Oct 2026), so a WinCC script writes the screen's tags to
 * BATCH.dbo.NIKO_LIVE and the helper reads that table.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

type V = number | string | boolean | null;
interface Live {
  readAt: string | null;
  receivedAt: string | null;
  stale: boolean;
  values: Record<string, V> | null;
  missing: string[];
}

const BINS = [1, 2, 3, 4, 5, 6, 7, 8];
const SILOS = [1, 2, 3, 4, 5];

const num = (v: V | undefined) => (v == null || v === "" || typeof v === "boolean" ? null : Number(v));
const on = (v: V | undefined) => v === true || v === 1 || v === "1" || v === "true";
const txt = (v: V | undefined) => (v == null ? "" : String(v).trim());
const show = (v: V | undefined, digits = 0) => {
  const n = num(v);
  return n == null || Number.isNaN(n) ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
};

/** A PLC TIME is milliseconds; the screen speaks in seconds. */
const secs = (v: V | undefined) => {
  const n = num(v);
  return n == null ? "—" : `${Math.round(n / 1000)} s`;
};

const RUN = "var(--color-green-500, #22c55e)";
const IDLE = "#cbd5e1";

function Digital({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 rounded border border-dashed border-gray-400 px-1 text-center text-[11px] font-semibold text-gray-600">{label}</span>
      <span className="min-w-[96px] rounded-md border-2 border-teal-500 bg-slate-800 px-3 py-1 text-right font-mono text-[26px] font-bold leading-none text-yellow-300 tabular-nums">
        {value}
      </span>
    </div>
  );
}

function Stat({ label, value, tone = "plain" }: { label: string; value: string; tone?: "plain" | "warn" | "good" }) {
  const t = tone === "warn" ? "bg-red-50 text-red-700" : tone === "good" ? "bg-green-50 text-green-700" : "bg-white text-gray-900";
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-gray-200 px-2 py-1 text-[12px]">
      <span className="text-gray-500">{label}</span>
      <span className={`rounded px-1.5 font-semibold tabular-nums ${t}`}>{value}</span>
    </div>
  );
}

function Gauge({ label, value, max = 90, sp }: { label: string; value: number | null; max?: number; sp?: number | null }) {
  const v = Math.max(0, Math.min(max, value ?? 0));
  const angle = (v / max) * 180 - 180;
  const spAngle = sp != null ? (Math.min(max, sp) / max) * 180 - 180 : null;
  const pt = (deg: number, r: number) => [60 + r * Math.cos((deg * Math.PI) / 180), 60 + r * Math.sin((deg * Math.PI) / 180)];
  const [nx, ny] = pt(angle, 44);
  const over = sp != null && value != null && value > sp;
  return (
    <div className="text-center">
      <svg viewBox="0 0 120 70" className="mx-auto w-36">
        <path d="M 10 60 A 50 50 0 0 1 110 60" fill="none" stroke="#e5e7eb" strokeWidth="10" />
        <path d={`M 10 60 A 50 50 0 0 1 ${pt(angle, 50)[0]} ${pt(angle, 50)[1]}`} fill="none" stroke={over ? "#dc2626" : "#0d9488"} strokeWidth="10" />
        {spAngle != null && (
          <line x1={pt(spAngle, 40)[0]} y1={pt(spAngle, 40)[1]} x2={pt(spAngle, 58)[0]} y2={pt(spAngle, 58)[1]} stroke="#f59e0b" strokeWidth="2" />
        )}
        <line x1="60" y1="60" x2={nx} y2={ny} stroke="#1f2937" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="60" cy="60" r="4" fill="#1f2937" />
      </svg>
      <div className={`font-mono text-[20px] font-bold tabular-nums ${over ? "text-red-600" : "text-gray-900"}`}>
        {value == null ? "—" : value.toFixed(2)}
      </div>
      <div className="mx-auto w-fit rounded bg-slate-800 px-2 text-[10px] font-semibold uppercase tracking-wide text-white">{label}</div>
    </div>
  );
}

function Chip({ label, active, tone }: { label: string; active: boolean; tone: "good" | "warn" | "info" }) {
  const lit = tone === "good" ? "bg-green-500 text-white" : tone === "warn" ? "bg-red-600 text-white" : "bg-amber-500 text-white";
  return (
    <span className={`rounded px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${active ? lit : "bg-gray-100 text-gray-400"}`}>{label}</span>
  );
}

/** The plant, drawn: bins, elevators, conveyors, grinder, mixer, silos. */
function Plant({ v }: { v: Record<string, V> }) {
  const run = (k: string) => (on(v[k]) ? RUN : IDLE);
  const binX = (n: number) => 250 + (n - 1) * 62;
  const siloX = (n: number) => 985 + (n - 1) * 44;
  const runningBins = new Set([num(v.runningBin1), num(v.runningBin2)].filter((x): x is number => x != null && x > 0));

  return (
    <svg viewBox="0 0 1220 360" className="w-full" role="img" aria-label="Mill process">
      <rect x="0" y="0" width="1220" height="360" fill="#eef2f7" rx="6" />

      {/* Grinder and its elevator */}
      <rect x="40" y="70" width="70" height="60" rx="8" fill="#d6c7a1" />
      <text x="75" y="64" textAnchor="middle" className="fill-gray-600 text-[10px]">GRINDER</text>
      <circle cx="75" cy="165" r="26" fill={run("grinder")} stroke="#475569" strokeWidth="2" />
      <text x="75" y="169" textAnchor="middle" className="fill-gray-800 text-[10px] font-semibold">{on(v.grinderHold) ? "HOLD" : "MILL"}</text>
      <rect x="130" y="40" width="14" height="270" fill={run("grinderElevator")} />
      <text x="137" y="330" textAnchor="middle" className="fill-gray-600 text-[9px]">GRND ELEV</text>

      {/* RM elevators and the top screw conveyor */}
      <rect x="200" y="30" width="14" height="280" fill={run("rmElevator1")} />
      <text x="207" y="24" textAnchor="middle" className="fill-gray-600 text-[9px]">RM ELEV-1</text>
      <rect x="240" y="38" width="460" height="10" rx="5" fill={run("topScrew")} />
      <text x="470" y="32" textAnchor="middle" className="fill-gray-600 text-[9px]">TOP SCREW CONVEYOR</text>
      <rect x="745" y="30" width="14" height="280" fill={run("rmElevator2")} />
      <text x="752" y="24" textAnchor="middle" className="fill-gray-600 text-[9px]">RM ELEV-2</text>

      {/* The eight bins */}
      {BINS.map((n) => {
        const x = binX(n);
        const name = txt(v[`bin${n}Name`]) || `BIN ${n}`;
        const feeding = runningBins.has(n);
        const selected = on(v[`bin${n}Selected`]);
        return (
          <g key={n}>
            <rect x={x} y="60" width="46" height="130" rx="6"
              fill={feeding ? "#fde68a" : selected ? "#dbeafe" : "#f8fafc"}
              stroke={feeding ? "#d97706" : "#64748b"} strokeWidth={feeding ? 3 : 1.5} />
            <rect x={x + 9} y="76" width="28" height="96" rx="3" fill="#1e293b" />
            <text x={x + 23} y="124" textAnchor="middle" transform={`rotate(-90 ${x + 23} 124)`}
              className="fill-white text-[10px] font-semibold">{name.slice(0, 10)}</text>
            {/* High-level sensor at the top, low-level at the bottom */}
            <circle cx={x + 40} cy="68" r="4" fill={on(v[`bin${n}High`]) ? "#dc2626" : "#e2e8f0"} />
            <circle cx={x + 40} cy="182" r="4" fill={on(v[`bin${n}Low`]) ? "#f59e0b" : "#e2e8f0"} />
            {/* Coarse and fine gates */}
            <rect x={x + 6} y="196" width="16" height="10" rx="2" fill={on(v[`bin${n}Coarse`]) ? RUN : "#ef4444"} />
            <rect x={x + 24} y="196" width="16" height="10" rx="2" fill={on(v[`bin${n}Fine`]) ? RUN : "#ef4444"} />
            <text x={x + 23} y="218" textAnchor="middle" className="fill-gray-500 text-[8px]">C · F</text>
            <text x={x + 23} y="54" textAnchor="middle" className="fill-gray-700 text-[10px] font-semibold">{n}</text>
          </g>
        );
      })}

      {/* Weigh hoppers and the batch conveyor */}
      <path d="M 250 228 L 485 228 L 445 268 L 290 268 Z" fill="#c9a6a6" />
      <path d="M 498 228 L 733 228 L 693 268 L 538 268 Z" fill="#c9a6a6" />
      <text x="367" y="252" textAnchor="middle" className="fill-gray-800 text-[10px] font-semibold">WG-1 {show(v.wg1)}</text>
      <text x="615" y="252" textAnchor="middle" className="fill-gray-800 text-[10px] font-semibold">WG-2 {show(v.wg2)}</text>
      <rect x="260" y="290" width="470" height="10" rx="5" fill={run("batchConveyor")} />
      <text x="495" y="316" textAnchor="middle" className="fill-gray-600 text-[9px]">BATCH CONVEYOR</text>

      {/* Mixer elevator, mixer */}
      <rect x="790" y="40" width="14" height="270" fill={run("mixerElevator")} />
      <text x="797" y="34" textAnchor="middle" className="fill-gray-600 text-[9px]">MIXER ELEV</text>
      <rect x="822" y="80" width="40" height="40" rx="6" fill="#d6c7a1" />
      <rect x="812" y="140" width="64" height="44" rx="8" fill={run("mixer")} stroke="#475569" strokeWidth="2" />
      <text x="844" y="166" textAnchor="middle" className="fill-gray-900 text-[10px] font-bold">{on(v.mixerHold) ? "HOLD" : "MIXER"}</text>
      <path d="M 820 190 L 868 190 L 852 240 L 836 240 Z" fill="#0f766e" />
      <rect x="815" y="300" width="70" height="8" rx="4" fill={run("mixerElevatorScrew")} />

      {/* Finished-feed elevator, distribution and silos */}
      <rect x="905" y="30" width="14" height="280" fill={run("ffElevator")} />
      <text x="912" y="24" textAnchor="middle" className="fill-gray-600 text-[9px]">FF ELEV</text>
      <rect x="930" y="58" width="270" height="10" rx="5" fill={on(v.distChain1) || on(v.distChain2) || on(v.distChain3) || on(v.ffTopConveyor) ? RUN : IDLE} />
      <text x="1065" y="52" textAnchor="middle" className="fill-gray-600 text-[9px]">DISTRIBUTION</text>
      {SILOS.map((n) => {
        const x = siloX(n);
        const name = txt(v[`silo${n}Name`]) || `S${n}`;
        const open = on(v[`silo${n}Gate`]);
        return (
          <g key={n}>
            <rect x={x} y="84" width="30" height="150" rx="12" fill={open ? "#bbf7d0" : "#e0f2fe"} stroke={open ? "#16a34a" : "#64748b"} strokeWidth={open ? 3 : 1.5} />
            <text x={x + 15} y="162" textAnchor="middle" transform={`rotate(-90 ${x + 15} 162)`} className="fill-gray-800 text-[10px] font-semibold">
              {name.slice(0, 10)}
            </text>
            <circle cx={x + 15} cy="92" r="4" fill={on(v[`silo${n}Full`]) ? "#dc2626" : "#e2e8f0"} />
            <text x={x + 15} y="252" textAnchor="middle" className={`text-[9px] font-semibold ${open ? "fill-green-700" : "fill-gray-400"}`}>{open ? "ON" : "OFF"}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function FeedScadaLivePage() {
  const { data } = useQuery<Live>({
    queryKey: ["scada", "live"],
    queryFn: () => api("/api/scada/live"),
    refetchInterval: 2_000,
  });
  const v = data?.values ?? {};
  const has = !!data?.values;
  const stale = !has || data!.stale;
  const read = data?.readAt ? new Date(data.readAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;

  const setTotal = num(v.setTotal);
  const actTotal = num(v.actTotal);
  const grinderSp = num(v.grinderAmpsSp);

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-6 py-3">
        <h1 className="text-lg font-semibold">Live Mill</h1>
        <span
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${
            !has ? "bg-gray-100 text-gray-500" : stale ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-700"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${!has ? "bg-gray-400" : stale ? "bg-amber-500" : "animate-pulse bg-green-500"}`} />
          {!has ? "No live values yet" : stale ? `Stale — last read ${read}` : `Live · ${read}`}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-surface p-3 lg:p-5">
        <div className="mx-auto max-w-[1400px] space-y-3">
          {!has && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
              Nothing has arrived from the SCADA PC yet. The values come from a table WinCC will write every couple of
              seconds once the integrator adds that script (scripts/scada/INTEGRATOR-live-values.md); the helper on the
              PC then sends them here. The layout below is the SCADA's batching screen.
            </div>
          )}
          {has && data!.missing.length > 0 && (
            <p className="text-[11px] text-gray-400">Not read from the SCADA: {data!.missing.join(", ")}</p>
          )}

          {/* ── Top strip: scales, bin table, totals, counters ── */}
          <div className={`card grid gap-4 p-3 lg:grid-cols-[auto_1fr_auto_auto] ${stale && has ? "opacity-60" : ""}`}>
            <div className="flex flex-col justify-center gap-2">
              <Digital label="WG-1" value={show(v.wg1)} />
              <Digital label="WG-2" value={show(v.wg2)} />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {[BINS.slice(0, 4), BINS.slice(4)].map((half, h) => (
                <table key={h} className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-orange-50 text-[10px] uppercase tracking-wide text-orange-800">
                      <th className="px-1 py-0.5 text-left">Bin</th>
                      <th className="px-1 py-0.5 text-left">Name</th>
                      <th className="px-1 py-0.5 text-right">Set</th>
                      <th className="px-1 py-0.5 text-right">Act</th>
                      <th className="px-1 py-0.5 text-right">Inflt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {half.map((n) => {
                      const feeding = num(v.runningBin1) === n || num(v.runningBin2) === n;
                      return (
                        <tr key={n} className={`border-b border-gray-100 ${feeding ? "bg-amber-50 font-semibold" : ""}`}>
                          <td className="px-1 py-0.5">BIN {n}</td>
                          <td className="px-1 py-0.5">{txt(v[`bin${n}Name`]) || "—"}</td>
                          <td className="px-1 py-0.5 text-right tabular-nums">{show(v[`bin${n}Set`])}</td>
                          <td className="px-1 py-0.5 text-right tabular-nums">{show(v[`bin${n}Act`])}</td>
                          <td className="px-1 py-0.5 text-right tabular-nums text-gray-500">{show(v[`bin${n}Inflight`])}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ))}
            </div>

            <div className="flex min-w-44 flex-col gap-1.5">
              <div className="rounded bg-blue-100 px-2 text-center text-[10px] font-semibold uppercase text-blue-900">Set total</div>
              <div className="rounded bg-orange-100 px-2 text-center font-mono text-[20px] font-bold tabular-nums">{setTotal == null ? "—" : `${setTotal} KG`}</div>
              <div className="rounded bg-blue-100 px-2 text-center text-[10px] font-semibold uppercase text-blue-900">Set actual</div>
              <div className="rounded bg-orange-100 px-2 text-center font-mono text-[20px] font-bold tabular-nums">{actTotal == null ? "—" : `${actTotal} KG`}</div>
              <div className="rounded border-2 border-gray-700 bg-yellow-100 px-2 text-center text-[14px] font-bold">{txt(v.recipeName) || "—"}</div>
            </div>

            <div className="flex min-w-48 flex-col gap-1">
              <Stat label="Batches set" value={show(v.batchesSet)} />
              <Stat label="Running batch" value={show(v.batchRunning)} tone="warn" />
              <Stat label="Completed" value={show(v.batchesDone)} />
              <Stat label="Running bin" value={[num(v.runningBin1), num(v.runningBin2)].filter((x) => x).join(" · ") || "—"} />
              <Stat label="Mixing time" value={secs(v.mixSet)} />
              <Stat label="MBG" value={secs(v.mbgSet)} />
              <Stat label="Amps SP" value={grinderSp == null ? "—" : `${grinderSp.toFixed(2)} A`} />
            </div>
          </div>

          {/* ── Plant and amps ── */}
          <div className={`grid gap-3 lg:grid-cols-[1fr_auto] ${stale && has ? "opacity-60" : ""}`}>
            <div className="card p-2">
              <Plant v={v} />
              <div className="mt-1 flex flex-wrap gap-3 px-2 text-[10px] text-gray-500">
                <span><span className="inline-block h-2 w-2 rounded-full bg-green-500" /> running</span>
                <span><span className="inline-block h-2 w-2 rounded bg-amber-300" /> bin feeding now</span>
                <span><span className="inline-block h-2 w-2 rounded-full bg-red-600" /> high level / silo full</span>
                <span><span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> low level</span>
                <span>C · F = coarse and fine gate, green when open</span>
              </div>
            </div>
            <div className="card flex flex-row items-center justify-around gap-4 p-3 lg:flex-col">
              <Gauge label="Grinder amps" value={num(v.grinderAmps)} sp={grinderSp} />
              <Gauge label="Mixer amps" value={num(v.mixerAmps)} />
            </div>
          </div>

          {/* ── Mode and holds (indicators only) ── */}
          <div className={`card flex flex-wrap items-center gap-2 p-3 ${stale && has ? "opacity-60" : ""}`}>
            <Chip label="RM feeding" active={on(v.group1On)} tone="good" />
            <Chip label="Batching" active={on(v.batchStart)} tone="good" />
            <Chip label="Mixing" active={on(v.group2On)} tone="good" />
            <Chip label="Silo" active={on(v.group3On)} tone="good" />
            <span className="mx-1 h-5 w-px bg-gray-200" />
            <Chip label="Batch hold" active={on(v.batchHold)} tone="info" />
            <Chip label="Mixer hold" active={on(v.mixerHold)} tone="info" />
            <Chip label="Grinder hold" active={on(v.grinderHold)} tone="info" />
            <span className="mx-1 h-5 w-px bg-gray-200" />
            <Chip label="Auto" active={on(v.auto)} tone="good" />
            <Chip label="Emergency" active={on(v.emergency)} tone="warn" />
            <span className="ml-auto text-[11px] text-gray-400">View only — control stays at the SCADA.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
