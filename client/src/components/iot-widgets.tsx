/**
 * The two drawings ported from the farm's own app: the bhfarm-style house card
 * and the fan wall.
 *
 * Both are faithful re-creations of what the staff already read every day —
 * the house card mirrors bhfarm.net's home-page layer card (beige outline,
 * sun under the apex, data pills inside the walls, silo tile), and the fan
 * wall mirrors the physical "Ventilation Fan Layout Diagram" printed on the
 * controller cabinet. Familiarity is the point; neither is redesigned.
 *
 * Fed by GET /api/farms/iot/house/:id/live. The colours are literals because
 * SVG cannot read a Tailwind class; they are the palette carried over from
 * the original.
 */
import { Bell } from "lucide-react";

/** What /api/farms/iot/house/:id/live answers with. */
export interface LiveShed {
  temps: Record<string, number>; //      "01".."13" → °C
  fanStatus: Record<string, boolean>; // "01".."22" → running
  tempC: number | null;
  targetTempC: number | null;
  humidityPct: number | null;
  co2Ppm: number | null;
  pressurePa: number | null;
  birdCount: number | null;
  birdAgeDays: number | null;
  waterPerBirdMl: number | null;
  feedPerBirdG: number | null;
  siloKg: number | null;
  ventLevel: number | null;
  ventMin: number | null;
  ventMax: number | null;
  airVolume: number | null;
  speedFanPct: number | null;
  curtain1: number | null;
  curtain2: number | null;
  coolingPump: string | null;
  fetchedAt: string | null;
}

/* ── Health, carried over from the original's thresholds ─────────────────── */

export type ShedHealth = "good" | "warning" | "critical" | "offline";

export function shedHealth(live: LiveShed | null): ShedHealth {
  if (!live || live.tempC === null) return "offline";
  const delta = live.targetTempC !== null ? live.tempC - live.targetTempC : 0;
  if (delta > 4 || (live.co2Ppm !== null && live.co2Ppm > 2500)) return "critical";
  if (delta > 2 || (live.co2Ppm !== null && live.co2Ppm > 1500) || (live.humidityPct !== null && live.humidityPct > 82))
    return "warning";
  return "good";
}

const HEALTH_DOT: Record<ShedHealth, string> = {
  good: "#16a34a",
  warning: "#d97706",
  critical: "#dc2626",
  offline: "#6b7280",
};

/* ── Icons (re-created to match bhfarm's /homeicon/house/*.svg) ──────────── */

function IconAge() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <circle cx="12" cy="12.5" r="8.5" fill="#fff3e6" stroke="#f59e0b" strokeWidth="1.6" />
      <path d="M12 8v4.5l3 2" fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 3.5h6" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconTemp() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <path d="M10 4.5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z" fill="#fff3e6" stroke="#f97316" strokeWidth="1.6" />
      <circle cx="12" cy="17" r="2.4" fill="#f97316" />
      <rect x="11.2" y="8" width="1.6" height="8" rx="0.8" fill="#f97316" />
    </svg>
  );
}

function IconVent() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <g fill="#22c55e">
        <path d="M12 12c0-4 .6-7 2.5-7s2 3 .8 5.2C14 12 12 12 12 12z" />
        <path d="M12 12c4 0 7 .6 7 2.5s-3 2-5.2.8C12 14 12 12 12 12z" transform="rotate(120 12 12)" />
        <path d="M12 12c4 0 7 .6 7 2.5s-3 2-5.2.8C12 14 12 12 12 12z" transform="rotate(240 12 12)" />
      </g>
      <circle cx="12" cy="12" r="2" fill="#16a34a" />
    </svg>
  );
}

function IconPressure() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <path d="M4 16a8 8 0 0 1 16 0" fill="none" stroke="#a78bfa" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 16l4.5-4" stroke="#7c3aed" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16" r="1.8" fill="#7c3aed" />
    </svg>
  );
}

function IconWater() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <path d="M6.5 5h11l-1 13.5a2 2 0 0 1-2 1.8h-5a2 2 0 0 1-2-1.8z" fill="#e0f2fe" stroke="#0ea5e9" strokeWidth="1.5" />
      <path d="M7.2 12.5h9.6l-.5 6a2 2 0 0 1-2 1.8h-4.6a2 2 0 0 1-2-1.8z" fill="#38bdf8" />
    </svg>
  );
}

function IconHumidity() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <path d="M12 3.5C12 3.5 6 10 6 14a6 6 0 0 0 12 0c0-4-6-10.5-6-10.5z" fill="#e0f2fe" stroke="#0ea5e9" strokeWidth="1.5" />
      <path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" fill="none" stroke="#0ea5e9" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconOutside() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <circle cx="12" cy="12" r="4.2" fill="#fde68a" stroke="#f59e0b" strokeWidth="1.4" />
      <g stroke="#f59e0b" strokeWidth="1.6" strokeLinecap="round">
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <line key={a} x1="12" y1="3.2" x2="12" y2="5.2" transform={`rotate(${a} 12 12)`} />
        ))}
      </g>
    </svg>
  );
}

function IconFeed() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <path d="M7 7c1.5-1.2 8.5-1.2 10 0-1 1-1 2.5 0 3.5-1 1-1 6-1 8a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2c0-2 0-7-1-8 1-1 1-2.5 0-3.5z" fill="#fde9d0" stroke="#d97706" strokeWidth="1.4" />
      <path d="M9.5 13.5l2 2 3.5-3.5" fill="none" stroke="#d97706" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSilo() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full">
      <path d="M6.5 8c0-2.3 2.5-3.8 5.5-3.8s5.5 1.5 5.5 3.8z" fill="#cfd4d9" />
      <rect x="6.5" y="8" width="11" height="8.5" fill="#e3e6ea" stroke="#cfd4d9" strokeWidth="0.8" />
      <line x1="6.5" y1="11" x2="17.5" y2="11" stroke="#cfd4d9" strokeWidth="0.8" />
      <line x1="6.5" y1="13.8" x2="17.5" y2="13.8" stroke="#cfd4d9" strokeWidth="0.8" />
      <path d="M6.5 16.5h11l-3.4 4.4a1 1 0 0 1-.8.4h-2.6a1 1 0 0 1-.8-.4z" fill="#cfd4d9" />
    </svg>
  );
}

function Pill({ icon, tint, label, value }: { icon: React.ReactNode; tint: string; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted py-1.5 pl-1.5 pr-2">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded" style={{ backgroundColor: tint }}>
        <span className="h-4 w-4">{icon}</span>
      </span>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[10px] text-muted-foreground">{label}</span>
        <span className="truncate text-[13px] font-semibold">{value}</span>
      </div>
    </div>
  );
}

/* ── The house card ──────────────────────────────────────────────────────── */

const f = (v: number | null, dp = 0, unit = "") =>
  v === null ? "—" : `${dp > 0 ? v.toFixed(dp) : Math.round(v).toLocaleString("en-IN")}${unit}`;

/**
 * The probes, split the way bhfarm splits them: 01–05 and 07 hang at bird
 * level, 08–13 along the upper tier, and 06 is the one outside the wall —
 * which is why it must never be averaged in with the rest.
 */
const LOWER_PROBES = ["01", "02", "03", "04", "05", "07"];
const UPPER_PROBES = ["08", "09", "10", "11", "12", "13"];

export function BhHouseCard({ name, live }: { name: string; live: LiveShed }) {
  const health = shedHealth(live);
  const avgOf = (keys: string[]) => {
    const xs = keys.map((k) => live.temps[k]).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const age = live.birdAgeDays;

  return (
    <div className="table-surface relative p-4">
      {/* header */}
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: HEALTH_DOT[health] }} />
          <span className="text-base font-bold">{name}</span>
        </div>
        <Bell
          className={`h-4 w-4 ${health === "warning" || health === "critical" ? "text-destructive" : "text-muted-foreground/40"}`}
        />
      </div>

      {/* roof (beige outline) + sun */}
      <div className="relative">
        <svg viewBox="0 0 300 70" preserveAspectRatio="none" className="block w-full" style={{ height: 44 }}>
          <path d="M7 63 L150 9 L293 63" fill="none" stroke="#f0e7d8" strokeWidth="14" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx="150" cy="50" r="9" fill="#fbbf24" />
        </svg>
      </div>

      {/* body — beige walls enclose the data grid */}
      <div
        className="grid grid-cols-2 gap-1.5 px-2.5 py-3"
        style={{
          borderLeft: "14px solid #f0e7d8",
          borderRight: "14px solid #f0e7d8",
          borderBottom: "14px solid #f0e7d8",
          borderBottomLeftRadius: 14,
          borderBottomRightRadius: 14,
          marginTop: -3,
        }}
      >
        <Pill icon={<IconOutside />} tint="#fdebd3" label="Outside" value={f(live.temps["06"] ?? null, 1, "°C")} />
        <Pill icon={<IconTemp />} tint="#fde3d0" label="Lower avg" value={f(avgOf(LOWER_PROBES), 1, "°C")} />
        <Pill icon={<IconTemp />} tint="#fde3d0" label="Upper avg" value={f(avgOf(UPPER_PROBES), 1, "°C")} />
        <Pill icon={<IconAge />} tint="#fdebd3" label="Age" value={age === null ? "—" : `${Math.floor(age / 7)}w ${age % 7}d`} />
        <Pill icon={<IconHumidity />} tint="#d6eefb" label="Humidity" value={f(live.humidityPct, 0, "%")} />
        <Pill icon={<IconVent />} tint="#d8f3df" label="Vent" value={f(live.ventLevel)} />
        <Pill icon={<IconPressure />} tint="#e9e2fb" label="Pressure" value={f(live.pressurePa, 0, "Pa")} />
        <Pill icon={<IconSilo />} tint="#e5e7eb" label="Silo" value={f(live.siloKg, 0, " kg")} />
        <Pill icon={<IconWater />} tint="#d6eefb" label="Water/bird" value={f(live.waterPerBirdMl, 0, " mL")} />
        <Pill icon={<IconFeed />} tint="#fbe6cf" label="Feed/bird" value={f(live.feedPerBirdG, 0, " g")} />
      </div>
    </div>
  );
}

/* ── The fan wall ────────────────────────────────────────────────────────── */
//
// Layout matches the physical "Ventilation Fan Layout Diagram" on the
// bhfarm.net controller cabinet exactly.
//
// LAYER SHED (12 × 4 = 48 physical fans, 22 groups)
//
//   Col:  0    1    2    3    4    5    6    7    8    9   10   11
// Row 0: [22] [21] [18] [14] [10] [06] [02] [06] [10] [14] [18] [21]
// Row 1: [22] [21] [17] [13] [09] [05] [02] [05] [09] [13] [17] [21]
// Row 2: [22] [20] [16] [12] [08] [04] [01] [04] [08] [12] [16] [20]
// Row 3: [22] [19] [15] [11] [07] [03] [01] [03] [07] [11] [15] [19]
//
// G01 & G02 → 2 fans each (centre column), G03–G20 → 2 each (mirrored),
// G21 → 4, G22 → 4. Total 48.
//
// PULLET SHED — wiring diagram not yet confirmed; a plain numbered grid until
// someone reads it off the cabinet.

const LAYER_FAN_ROWS: (string | null)[][] = [
  ["22", "21", "18", "14", "10", "06", "02", "06", "10", "14", "18", "21"],
  ["22", "21", "17", "13", "09", "05", "02", "05", "09", "13", "17", "21"],
  ["22", "20", "16", "12", "08", "04", "01", "04", "08", "12", "16", "20"],
  ["22", "19", "15", "11", "07", "03", "01", "03", "07", "11", "15", "19"],
];

const PULLET_FAN_ROWS: (string | null)[][] = [
  ["01", "02", "03", "04", "05", "06"],
  ["07", "08", "09", "10", "11", "12"],
  ["13", "14", "15", "16", "17", "18"],
  ["19", "20", "21", "22", null, null],
];

export function FanWall({ live, purpose }: { live: LiveShed; purpose: string }) {
  const fanStatus = live.fanStatus;
  const active = Object.values(fanStatus).filter(Boolean).length;
  const rows = purpose.toLowerCase() === "layer" ? LAYER_FAN_ROWS : PULLET_FAN_ROWS;
  const wide = (rows[0]?.length ?? 0) >= 12;
  const cellCls = wide ? "w-8 h-8" : "w-10 h-10";
  const iconCls = wide ? "w-4 h-4" : "w-5 h-5";

  return (
    <div className="table-surface p-4">
      {/* The animation the spinning blades use, declared beside its one user. */}
      <style>{`@keyframes fanSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Fan wall</div>
          <div className="text-[11px] text-muted-foreground">
            As wired on the controller cabinet — a group lights its fans wherever they physically sit.
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {live.speedFanPct !== null && (
            <span>
              Speed fan{" "}
              <strong className={live.speedFanPct > 0 ? "text-primary" : ""}>{live.speedFanPct.toFixed(0)}%</strong>
            </span>
          )}
          <span>
            <strong className="text-primary">{active}</strong> / 22 groups on
          </span>
        </div>
      </div>

      <div className="space-y-1.5 overflow-x-auto">
        {rows.map((row, ri) => (
          <div key={ri} className={`flex justify-center ${wide ? "gap-1" : "gap-2"}`}>
            {row.map((fanId, ci) => {
              if (fanId === null) return <div key={`${ri}-${ci}`} className={cellCls} />;
              const on = fanStatus[fanId] ?? false;
              return (
                <div key={`${ri}-${ci}`} className="flex flex-col items-center gap-0.5">
                  <div
                    title={`Group ${fanId}: ${on ? "running" : "off"}`}
                    className={`${cellCls} flex items-center justify-center rounded-full border-2 transition-all ${
                      on ? "border-info/40 bg-info/10" : "border-border bg-muted"
                    }`}
                    style={on ? { boxShadow: "0 0 6px #93c5fd" } : undefined}
                  >
                    <svg viewBox="0 0 24 24" className={iconCls} aria-hidden>
                      <g transform="translate(12,12)" style={on ? { animation: "fanSpin 1.2s linear infinite" } : undefined}>
                        {[0, 90, 180, 270].map((angle) => (
                          <ellipse
                            key={angle}
                            cx="0"
                            cy="-4"
                            rx="2.5"
                            ry="5"
                            fill={on ? "#3b82f6" : "#9ca3af"}
                            transform={`rotate(${angle})`}
                            opacity={on ? 0.9 : 0.45}
                          />
                        ))}
                        <circle r="2" fill={on ? "#1d4ed8" : "#6b7280"} />
                      </g>
                    </svg>
                  </div>
                  <span className={`text-[8px] font-bold leading-none ${on ? "text-info" : "text-muted-foreground"}`}>
                    {fanId}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-4 border-t border-border/60 pt-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-info" /> running
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground/30" /> off
        </span>
        {purpose.toLowerCase() !== "layer" && (
          <span className="ml-auto italic">pullet shed wiring not yet mapped — shown as a plain grid</span>
        )}
        {active === 0 && <span className="ml-auto italic">no fans running</span>}
      </div>
    </div>
  );
}
