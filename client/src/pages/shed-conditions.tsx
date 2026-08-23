/**
 * What one shed's instruments recorded, drawn.
 *
 * Reached by clicking a shed on the Houses board's conditions table. Its own
 * screen rather than another tab on the house, because these are the
 * controller's readings and the house page is the flock's paperwork — the two
 * disagree often enough that putting them side by side would invite the reader
 * to treat a sensor and a tally sheet as one claim.
 *
 * The window stops at fourteen days on purpose. Samples thin as they age — five
 * minutes for a week, then a quarter of an hour, then an hour — so a longer
 * window would draw a line whose resolution changes halfway across it without
 * saying so. Older than that is a question for the day summaries.
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";

/** recharts 3 types the tooltip callbacks tighter than these call sites want. */
const Tooltip = RechartsTooltip as unknown as (props: Record<string, unknown>) => ReactElement;

/* The strokes are literals because SVG cannot read a Tailwind class. EGGSY's
   palette: brand blue for the measured line, amber for feed and for a setpoint,
   green for water, red for anything that is a warning by itself. */
const BLUE = "#4f8ef7";
const GREEN = "#65c366";
const AMBER = "#f59e0b";
const RED = "#ef4444";
const GREY = "#9ca3af";

interface Sample {
  at: string;
  tempC: number | null;
  targetTempC: number | null;
  humidityPct: number | null;
  co2Ppm: number | null;
  pressurePa: number | null;
  siloKg: number | null;
  waterL: number | null;
  feedKg: number | null;
  ventLevel: number | null;
  ventRate: number | null;
  birdCount: number | null;
  birdAgeDays: number | null;
  waterPerBirdMl: number | null;
  feedPerBirdG: number | null;
}

interface BoardRow {
  houseId: string;
  code: string;
  purpose: string;
}

const RANGES = [
  { label: "24 hours", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "14 days", hours: 336 },
] as const;

const num = (n: number, dp = 0) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function ShedConditionsPage() {
  const [, params] = useRoute("/farms/conditions/:id");
  const [, setLocation] = useLocation();
  const houseId = params?.id ?? "";

  const [hours, setHours] = useState<number>(24);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [houses, setHouses] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ board: BoardRow[] }>("/api/farms/iot/board")
      .then((d) => setHouses(d.board))
      .catch(() => setHouses([]));
  }, []);

  useEffect(() => {
    if (!houseId) return;
    setLoading(true);
    api<{ samples: Sample[] }>(`/api/farms/iot/house/${houseId}/samples?hours=${hours}`)
      .then((d) => setSamples(d.samples))
      .catch(() => setSamples([]))
      .finally(() => setLoading(false));
  }, [houseId, hours]);

  const house = houses.find((h) => h.houseId === houseId);

  /**
   * Plotted against real time, with breaks where the readings stop.
   *
   * The x-axis carries the timestamp itself rather than a formatted label. A
   * label axis spaces every sample evenly whatever the clock says, so a night
   * when nothing was recorded closes up into a confident straight line across
   * the gap — a picture of a shed that was never watched, drawn as a shed that
   * was fine. A row of nulls in each gap breaks the line instead.
   */
  const rows = useMemo(() => {
    const mapped = samples.map((s) => ({
      ...s,
      t: new Date(s.at).getTime(),
      siloT: s.siloKg == null ? null : s.siloKg / 1000,
    }));
    if (mapped.length < 3) return mapped;

    // The usual spacing, taken as the median so one long gap does not define it.
    const steps = mapped.slice(1).map((r, i) => r.t - mapped[i]!.t).sort((a, b) => a - b);
    const normal = steps[Math.floor(steps.length / 2)] || 300_000;

    const out: typeof mapped = [];
    for (const [i, r] of mapped.entries()) {
      const prev = mapped[i - 1];
      if (prev && r.t - prev.t > normal * 3) {
        out.push({
          ...r,
          t: prev.t + (r.t - prev.t) / 2,
          tempC: null, targetTempC: null, humidityPct: null, co2Ppm: null,
          pressurePa: null, siloKg: null, siloT: null, waterL: null, feedKg: null,
          ventLevel: null, ventRate: null,
        });
      }
      out.push(r);
    }
    return out;
  }, [samples]);

  /** Evenly spaced along the clock, so the ticks say where the gaps are. */
  const ticks = useMemo(() => {
    if (!rows.length) return [];
    const lo = rows[0]!.t;
    const hi = rows[rows.length - 1]!.t;
    return Array.from({ length: 7 }, (_, i) => Math.round(lo + ((hi - lo) * i) / 6));
  }, [rows]);

  const tickLabel = (t: number) => {
    const d = new Date(t);
    return hours <= 24
      ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit" });
  };
  const fullLabel = (t: number) =>
    new Date(t).toLocaleString("en-IN", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });

  const latest = [...rows].reverse().find((r) => r.tempC != null) ?? rows[rows.length - 1];
  const span = (pick: (r: (typeof rows)[number]) => number | null) => {
    const v = rows.map(pick).filter((x): x is number => x != null);
    if (!v.length) return null;
    return { lo: Math.min(...v), hi: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length };
  };
  const temp = span((r) => r.tempC);
  const co2 = span((r) => r.co2Ppm);
  const humidity = span((r) => r.humidityPct);

  /**
   * A reading that never once changed across the whole window.
   *
   * Said out loud because a frozen sensor and a shed that used no water draw
   * exactly the same flat line, and the difference matters enormously. L3's
   * water and feed meters have both been stuck since at least 18 August while
   * its temperature and CO2 move normally, so this is not hypothetical.
   */
  const frozen = (pick: (r: (typeof rows)[number]) => number | null) => {
    const v = rows.map(pick).filter((x): x is number => x != null);
    return v.length > 12 && v.every((x) => x === v[0]);
  };
  const waterFeedFrozen = frozen((r) => r.waterL) && frozen((r) => r.feedKg);

  /** Where the readings stopped, if they did. */
  const gaps = rows.filter((r) => r.tempC == null).length;

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            onClick={() => setLocation("/farms")}
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            Houses
          </button>
          <h1 className="text-2xl font-semibold">{house?.code ?? "Shed"} conditions</h1>
          <p className="text-sm text-muted-foreground">
            Straight from the controller
            {latest?.birdCount != null && ` · ${num(latest.birdCount)} birds by its own count`}
            {latest?.birdAgeDays != null && ` · day ${num(latest.birdAgeDays)}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Other sheds, so the reader can flick between them without going
              back to the board and finding the row again. */}
          <select
            value={houseId}
            onChange={(e) => setLocation(`/farms/conditions/${e.target.value}`)}
            className="h-9 min-w-[5rem] rounded-md border border-border bg-background px-2 text-sm"
          >
            {houses.map((h) => (
              <option key={h.houseId} value={h.houseId}>
                {h.code}
              </option>
            ))}
          </select>
          <div className="flex rounded-md border border-border">
            {RANGES.map((r) => (
              <button
                key={r.hours}
                onClick={() => setHours(r.hours)}
                className={`px-3 py-1.5 text-xs first:rounded-l-md last:rounded-r-md ${
                  hours === r.hours
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">reading…</div>
      ) : !rows.length ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No readings in this window. The controller may not be reporting, or the samples for
          this stretch have aged out.
        </div>
      ) : (
        <>
          {/* What the window came to, in words, above the drawings. A chart
              answers "what shape"; these answer "how hot did it actually get". */}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Temperature"
              value={temp ? `${num(temp.avg, 1)}°` : "—"}
              detail={temp ? `${num(temp.lo, 1)}° to ${num(temp.hi, 1)}°` : ""}
            />
            <Stat
              label="Humidity"
              value={humidity ? `${num(humidity.avg)}%` : "—"}
              detail={humidity ? `${num(humidity.lo)}% to ${num(humidity.hi)}%` : ""}
            />
            <Stat
              label="CO₂"
              value={co2 ? `${num(co2.avg)} ppm` : "—"}
              detail={co2 ? `peak ${num(co2.hi)}` : ""}
              warn={!!co2 && co2.hi > 3000}
            />
            {/* A count on its own reads as coverage. Naming the breaks stops a
                half-watched window looking like a fully watched one. */}
            <Stat
              label="Samples"
              value={num(rows.length - gaps)}
              detail={
                gaps
                  ? `over ${RANGES.find((r) => r.hours === hours)?.label} · ${gaps} break${gaps > 1 ? "s" : ""}`
                  : `over ${RANGES.find((r) => r.hours === hours)?.label}`
              }
              warn={gaps > 0}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Panel
              title="Temperature against target"
              note="The dashed line is the controller's own setpoint. A gap that will not close is the shed losing an argument with the weather."
            >
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  ticks={ticks}
                  tickFormatter={tickLabel}
                  tick={{ fontSize: 10 }}
                />
                <YAxis tick={{ fontSize: 10 }} domain={["dataMin - 1", "dataMax + 1"]} unit="°" />
                <Tooltip formatter={(v: number) => `${v?.toFixed?.(1) ?? v}°C`} />
                <Legend />
                <Line isAnimationActive={false} dataKey="tempC" name="Measured" stroke={BLUE} strokeWidth={2} dot={false} />
                <Line
                  isAnimationActive={false}
                  dataKey="targetTempC"
                  name="Target"
                  stroke={GREY}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                  connectNulls
                />
              </LineChart>
            </Panel>

            <Panel
              title="CO₂ and humidity"
              note="CO₂ is the ventilation's report card; above about 3,000 ppm the shed is not getting enough air."
            >
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  ticks={ticks}
                  tickFormatter={tickLabel}
                  tick={{ fontSize: 10 }}
                />
                <YAxis yAxisId="co2" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="rh" orientation="right" tick={{ fontSize: 10 }} unit="%" domain={[0, 100]} />
                <Tooltip labelFormatter={fullLabel} />
                <Legend />
                <Line isAnimationActive={false} yAxisId="co2" dataKey="co2Ppm" name="CO₂ ppm" stroke={RED} strokeWidth={2} dot={false} />
                <Line isAnimationActive={false} yAxisId="rh" dataKey="humidityPct" name="Humidity %" stroke={BLUE} strokeWidth={2} dot={false} />
              </LineChart>
            </Panel>

            <Panel
              title="Water and feed today"
              note={
                waterFeedFrozen
                  ? "Both meters have reported the same figure for the whole window — the controller is not updating them. Treat this panel as broken, not as a shed that drank nothing."
                  : "The controller's own running totals for the day it is in."
              }
            >
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  ticks={ticks}
                  tickFormatter={tickLabel}
                  tick={{ fontSize: 10 }}
                />
                <YAxis yAxisId="w" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="f" orientation="right" tick={{ fontSize: 10 }} />
                <Tooltip labelFormatter={fullLabel} formatter={(v: number, n: string) => [`${num(v)} ${n.includes("Water") ? "L" : "kg"}`, n]} />
                <Legend />
                <Line isAnimationActive={false} yAxisId="w" dataKey="waterL" name="Water L" stroke={GREEN} strokeWidth={2} dot={false} />
                <Line isAnimationActive={false} yAxisId="f" dataKey="feedKg" name="Feed kg" stroke={AMBER} strokeWidth={2} dot={false} />
              </LineChart>
            </Panel>

            <Panel
              title="Silo weight"
              note="Filled steps up, eaten slopes down. A flat line while the birds are feeding means a sensor, not a fast."
            >
              <AreaChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  ticks={ticks}
                  tickFormatter={tickLabel}
                  tick={{ fontSize: 10 }}
                />
                <YAxis tick={{ fontSize: 10 }} unit="t" />
                <Tooltip formatter={(v: number) => `${num(v, 2)} t`} />
                <Area
                  isAnimationActive={false}
                  dataKey="siloT"
                  name="Silo"
                  stroke={AMBER}
                  fill={AMBER}
                  fillOpacity={0.15}
                  strokeWidth={2}
                  connectNulls
                />
              </AreaChart>
            </Panel>

            <Panel
              title="Ventilation"
              note="The level the controller chose and the airflow it got. Level climbing while flow does not is a fan that is not turning."
            >
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  ticks={ticks}
                  tickFormatter={tickLabel}
                  tick={{ fontSize: 10 }}
                />
                <YAxis yAxisId="lvl" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="rate" orientation="right" tick={{ fontSize: 10 }} />
                <Tooltip labelFormatter={fullLabel} />
                <Legend />
                <Line isAnimationActive={false} yAxisId="lvl" dataKey="ventLevel" name="Level" stroke={BLUE} strokeWidth={2} dot={false} />
                <Line isAnimationActive={false} yAxisId="rate" dataKey="ventRate" name="Airflow" stroke={GREY} strokeWidth={2} dot={false} />
              </LineChart>
            </Panel>

            <Panel
              title="Negative pressure"
              note="What holds the incoming air along the ceiling instead of dropping it on the birds. It should track the ventilation level."
            >
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  ticks={ticks}
                  tickFormatter={tickLabel}
                  tick={{ fontSize: 10 }}
                />
                <YAxis tick={{ fontSize: 10 }} unit="Pa" />
                <Tooltip formatter={(v: number) => `${num(v, 1)} Pa`} />
                <Line isAnimationActive={false} dataKey="pressurePa" name="Pressure" stroke={BLUE} strokeWidth={2} dot={false} />
              </LineChart>
            </Panel>
          </div>

          <p className="mt-4 text-[11px] text-muted-foreground">
            Readings are five minutes apart for the first week and thin with age — a quarter of an
            hour to two months, an hour beyond that. Nothing here is the daily sheet; the two are
            kept separate on purpose.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  warn,
}: {
  label: string;
  value: string;
  detail?: string;
  warn?: boolean;
}) {
  return (
    <div className="table-surface px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${warn ? "text-destructive" : ""}`}>
        {value}
      </div>
      {detail && <div className="text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  /** One line on what the shape means — a chart nobody can read is decoration. */
  note: string;
  children: ReactElement;
}) {
  return (
    <div className="table-surface p-3">
      <div className="mb-1 text-sm font-medium">{title}</div>
      <div className="mb-2 text-[11px] text-muted-foreground">{note}</div>
      <div className="h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
