/**
 * Home — the boss view. The whole operation on one screen for a chosen
 * range: what the sheds laid, what the market bought, who's on the ground,
 * what came through the gate, what the mill made, and what is owed either
 * way. Every tile opens into the table it was summed from.
 *
 * Farm leads — it is what the whole place is for, and the reason there is a
 * feed mill or a sales ledger at all. Visual language is the home page's own
 * (the yolk/soil tokens in index.css, added just for this page); every other
 * screen keeps the brand-blue system exactly as it was.
 *
 * Ported from Amino's executive report, People section included now that
 * the Payroll module supplies it.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Egg,
  Factory,
  Landmark,
  Loader2,
  ShoppingCart,
  Sprout,
  Truck,
  Users,
} from "lucide-react";
import { api, formatMoney } from "../api";
import { useAuth } from "../auth";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/* ── Shape of /api/boss-view ───────────────────────────────────────────── */
interface BossView {
  from: string;
  to: string;
  purchases: {
    totalTonnageKg: number;
    deliveryCount: number;
    pendingTonnageKg: number;
    tonnageByIngredient: { name: string; kg: number; avgRate: number }[];
    deliveries: { item: string; vendor: string; kg: number; rate: number; value: number; date: string }[];
    pendingPOs: { vendor: string; item: string; pendingKg: number; rate: number; number: string }[];
  };
  feedMill: {
    totalProducedKg: number;
    totalTransferredKg: number;
    costPerKg: number;
    produced: { formula: string; batches: number; kg: number; costPerKg: number }[];
    transferred: { house: string; item: string; kg: number; ratePerKg: number }[];
  };
  farm: {
    totalEggs: number;
    layRatePct: number;
    mortalityPct: number;
    feedPerEggG: number;
    houses: { house: string; eggs: number; feedKg: number; mortality: number; days: number; layRatePct: number; mortalityPct: number; feedPerEggG: number }[];
  };
  sales: {
    totalSales: number;
    totalEggs: number;
    invoiceCount: number;
    avgBenchmarkRate: number;
    salesList: { customer: string; value: number; invoices: number; eggs: number }[];
    priceHistory: { date: string; price: number }[];
  };
  finance: {
    totalRevenue: number;
    totalFeedCost: number;
    receivables: number;
    payables: number;
    grossMarginPct: number;
    apDetails: { vendor: string; number: string; total: number; balanceDue: number; dueDate: string | null; status: string }[];
  };
}

/* ── Shape of /api/payroll/reports/people ──────────────────────────────── */
interface PeopleView {
  totalStaff: number;
  presentToday: number;
  insideNow: { id: string; empCode: string; name: string; department?: string | null; since?: string | null }[];
  absentToday: { id: string; empCode: string; name: string; department?: string | null }[];
  byDepartment: { department: string; present: number; total: number }[];
  /** Null where there are no work days to divide by — a new farm, or a range
   *  with no roster in it. Not zero: nobody was absent, there was nothing. */
  attendancePct: number | null;
  wagesCost: number;
}

/* ── Ranges, in IST ────────────────────────────────────────────────────── */
const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const RANGES = ["Today", "Yesterday", "This week", "This month", "This year"] as const;
type Range = (typeof RANGES)[number];
function rangeDates(r: Range): { from: string; to: string } {
  const t = istToday();
  switch (r) {
    case "Today":
      return { from: t, to: t };
    case "Yesterday":
      return { from: shift(t, -1), to: shift(t, -1) };
    case "This week": {
      const dow = (new Date(`${t}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      return { from: shift(t, -dow), to: t };
    }
    case "This month":
      return { from: `${t.slice(0, 7)}-01`, to: t };
    case "This year": {
      const y = Number(t.slice(0, 4));
      const fy = Number(t.slice(5, 7)) >= 4 ? y : y - 1;
      return { from: `${fy}-04-01`, to: t };
    }
  }
}

/* ── Formatting ────────────────────────────────────────────────────────── */
/**
 * Nullish renders as a dash rather than throwing.
 *
 * This is a whole dashboard of figures behind one error boundary's worth of
 * nothing: a single null reaching `.toLocaleString()` blanks the entire page,
 * which is exactly what a brand new database did — no employees means no
 * attendance percentage, the API rightly says null, and the app showed a white
 * screen instead of a farm with nothing in it yet. A metric with no value is
 * not an error, so it is not treated as one.
 */
const num = (v: number | null | undefined, d = 0) =>
  v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const tons = (kg: number) => `${num(kg / 1000, 1)} t`;
const lakh = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${num(v / 1e7, 2)} cr`;
  if (a >= 1e5) return `₹${num(v / 1e5, 2)} L`;
  return formatMoney(v);
};
const dmy = (iso: string | null) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "—");

/* ── Pieces ────────────────────────────────────────────────────────────── */

/** A bento tile: white, soft shadow, no border — the tables' own convention. */
function Tile({
  icon,
  title,
  hint,
  span,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  span?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-2xl bg-white p-4 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)] ${span ?? ""}`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-yolk-50 text-yolk-600">{icon}</span>
          <h2 className="text-[14px] font-bold text-soil-900">{title}</h2>
        </div>
        {hint && <span className="text-[11px] text-soil-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** A figure that opens its table — the bento version, bigger and warmer. */
function Metric({
  label,
  value,
  sub,
  onClick,
  tone,
  big,
  invert,
}: {
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
  tone?: "good" | "bad";
  big?: boolean;
  invert?: boolean;
}) {
  const color = tone === "good" ? (invert ? "text-yolk-100" : "text-emerald-600") : tone === "bad" ? (invert ? "text-white" : "text-rose-600") : invert ? "text-white" : "text-soil-900";
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      // min-w-0 so a grid cell can hold it to its share of the row: without it a
      // long figure sets the cell's width and pushes into its neighbour.
      className={`group min-w-0 rounded-xl px-2 py-2 text-left transition sm:px-2.5 ${invert ? "hover:bg-white/10" : "hover:bg-yolk-50"} disabled:cursor-default ${invert ? "" : "disabled:hover:bg-transparent"}`}
    >
      <div className={`truncate text-[10.5px] font-bold uppercase tracking-wider ${invert ? "text-yolk-100/80" : "text-soil-400"}`}>{label}</div>
      {/*
        Sized off the viewport, not off a breakpoint.
        At 375px a two-column hero cell is ~111px and `65,79,709` set at text-3xl
        wants 152px. It did not clip — nothing here hides overflow — it drew over
        the cell beside it, so LAY RATE 94.5% read as 4.5%.

        A breakpoint step fixed the overlap but broke the number across two lines
        instead, which is barely better. clamp() scales it with the screen and
        stops at the old desktop size, so the figure stays on one line from a
        small phone up. break-all is left as a floor for a number longer than any
        we have: wrapped is still better than drawn over the neighbour.
      */}
      <div
        className={`break-all font-extrabold tabular-nums leading-tight ${color} ${
          big ? "text-[clamp(1rem,5vw,1.875rem)]" : "text-[clamp(0.8125rem,3.8vw,1.25rem)]"
        }`}
      >
        {value}
      </div>
      {sub && <div className={`mt-0.5 text-[11px] ${invert ? "text-yolk-50/85" : "text-soil-400"}`}>{sub}</div>}
      {onClick && (
        <div className={`mt-0.5 text-[10px] font-semibold opacity-0 transition group-hover:opacity-100 ${invert ? "text-white" : "text-yolk-600"}`}>
          see detail →
        </div>
      )}
    </button>
  );
}

/** A slim progress bar in the yolk ramp, on a soil track. */
function Bar({ pct, invert }: { pct: number; invert?: boolean }) {
  return (
    <div className={`h-1.5 flex-1 overflow-hidden rounded-full ${invert ? "bg-white/25" : "bg-soil-100"}`}>
      <div
        className={`h-full rounded-full ${invert ? "bg-white" : "bg-yolk-500"}`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

/** A ring gauge — the hero's lay-rate dial. */
function Ring({ pct, size = 64, stroke = 8 }: { pct: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (Math.min(100, Math.max(0, pct)) / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="white"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={off}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Tables inside the drill-downs: flat header, no outer border, totals line. */
function DTable<T>({
  rows,
  cols,
  totals,
}: {
  rows: T[];
  cols: { h: string; v: (r: T) => ReactNode; right?: boolean }[];
  totals?: ReactNode[];
}) {
  if (!rows.length) return <div className="py-6 text-center text-sm text-soil-400">Nothing in this range.</div>;
  return (
    <div className="max-h-[60vh] overflow-auto rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
      <table className="w-full text-sm">
        <thead className="sticky top-0">
          <tr>
            {cols.map((c) => (
              <th
                key={c.h}
                className={`whitespace-nowrap bg-soil-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-soil-400 ${c.right ? "text-right" : "text-left"}`}
              >
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-soil-100/70 transition-colors last:border-0 hover:bg-yolk-50/70">
              {cols.map((c) => (
                <td key={c.h} className={`px-3 py-1.5 ${c.right ? "text-right tabular-nums" : ""}`}>
                  {c.v(r)}
                </td>
              ))}
            </tr>
          ))}
          {totals && (
            <tr className="bg-soil-50 font-semibold">
              {totals.map((t, i) => (
                <td key={i} className={`px-3 py-2 ${cols[i]?.right ? "text-right tabular-nums" : ""}`}>
                  {t}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Benchmark price over the last thirty settings — recoloured to yolk. */
function Sparkline({ points }: { points: { date: string; price: number }[] }) {
  if (points.length < 2) return <div className="text-xs text-soil-400">Not enough benchmark history for a line.</div>;
  const w = 320;
  const h = 60;
  const ys = points.map((p) => p.price);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => h - 6 - ((v - min) / span) * (h - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const last = points[points.length - 1]!;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none">
        <path d={`${d} L${w},${h} L0,${h} Z`} fill="var(--color-yolk-50)" />
        <path d={d} fill="none" stroke="var(--color-yolk-500)" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
        <circle cx={x(points.length - 1)} cy={y(last.price)} r={3} fill="var(--color-yolk-600)" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-soil-400">
        <span>
          {dmy(points[0]!.date)} · ₹{num(points[0]!.price, 2)}
        </span>
        <span>
          {dmy(last.date)} · <strong className="text-soil-800">₹{num(last.price, 2)}</strong>
        </span>
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */
type Detail = "received" | "pending" | "produced" | "sent" | "houses" | "customers" | "payables" | "absent" | "inside" | null;

export function HomePage() {
  const { user } = useAuth();
  const [range, setRange] = useState<Range>("This month");
  const [detail, setDetail] = useState<Detail>(null);
  const { from, to } = useMemo(() => rangeDates(range), [range]);

  const { data, isLoading } = useQuery({
    queryKey: ["boss-view", from, to],
    queryFn: () => api<BossView>(`/api/boss-view?from=${from}&to=${to}`),
  });
  // People comes from the Payroll module; the card simply stays away if the
  // endpoint errors (module off, or no permission).
  const { data: people } = useQuery({
    queryKey: ["people", from, to],
    queryFn: () => api<PeopleView>(`/api/payroll/reports/people?from=${from}&to=${to}`),
    retry: false,
  });
  const { data: org } = useQuery({
    queryKey: ["org"],
    queryFn: () => api<{ name: string } | null>("/api/settings/org"),
  });

  const ing = data?.purchases.tonnageByIngredient ?? [];
  const ingMax = ing[0]?.kg || 1;
  const dispatchedPct = data && data.feedMill.totalProducedKg ? (data.feedMill.totalTransferredKg / data.feedMill.totalProducedKg) * 100 : 0;
  const bestHouse = data?.farm.houses.length ? [...data.farm.houses].sort((a, b) => b.layRatePct - a.layRatePct)[0] : null;

  return (
    <div className="h-full overflow-y-auto bg-soil-50">
      {/* Header — warm, quiet, a live dot rather than noise */}
      <div className="border-b border-soil-100 bg-gradient-to-r from-white via-yolk-50/40 to-white px-7 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yolk-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-yolk-500" />
              </span>
              <h1 className="text-[22px] font-extrabold tracking-tight text-soil-900">
                Hello, {user?.name?.split(" ")[0] ?? "there"} 👋
              </h1>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-soil-400">
              <Sprout size={13} className="text-yolk-600" />
              {org?.name || "Set up your organisation in Settings"} · {dmy(from)} – {dmy(to)}
            </div>
          </div>
          <div className="flex gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-soil-100">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${
                  range === r ? "bg-yolk-500 text-white shadow-sm" : "text-soil-600 hover:bg-yolk-50"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="flex items-center justify-center py-24 text-soil-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Adding it up…
        </div>
      ) : (
        <div className="mx-auto max-w-[1800px] space-y-4 p-6 xl:p-8">
          {/* ── Farm hero — the reason there is a mill or a ledger at all ── */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-yolk-400 via-yolk-500 to-yolk-600 p-5 text-white shadow-[0_8px_30px_-12px_rgba(224,109,5,0.55)] lg:col-span-2">
              {/* A quiet sun, not a texture — one soft circle, nothing more */}
              <div className="pointer-events-none absolute -right-10 -top-14 h-48 w-48 rounded-full bg-white/10" />
              <div className="relative flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/15">
                    <Egg size={17} />
                  </span>
                  <div>
                    <h2 className="text-[15px] font-bold">Farm</h2>
                    <div className="text-[11px] text-yolk-50/85">{data.farm.houses.length} laying houses</div>
                  </div>
                </div>
                <Ring pct={data.farm.layRatePct} />
              </div>
              <div className="relative mt-3 grid grid-cols-2 gap-1 sm:grid-cols-4">
                <Metric label="Eggs laid" value={num(data.farm.totalEggs)} onClick={() => setDetail("houses")} big invert />
                <Metric label="Lay rate" value={`${num(data.farm.layRatePct, 1)}%`} onClick={() => setDetail("houses")} invert />
                <Metric label="Mortality" value={`${num(data.farm.mortalityPct, 2)}%`} tone={data.farm.mortalityPct > 1 ? "bad" : undefined} onClick={() => setDetail("houses")} invert />
                <Metric label="Feed / egg" value={`${num(data.farm.feedPerEggG, 1)} g`} onClick={() => setDetail("houses")} invert />
              </div>
              {bestHouse && (
                <div className="relative mt-2 text-[11px] text-yolk-50/90">
                  Best today: <span className="font-bold text-white">{bestHouse.house}</span> at {num(bestHouse.layRatePct, 1)}%
                </div>
              )}
            </div>

            {/* Per-house register, beside the hero */}
            <div className="rounded-2xl bg-white p-4 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="text-[12px] font-bold uppercase tracking-wide text-soil-400">Houses</h3>
                <button onClick={() => setDetail("houses")} className="text-[11px] font-semibold text-yolk-600 hover:underline">
                  all →
                </button>
              </div>
              <div className="space-y-1.5">
                {data.farm.houses.map((h) => (
                  <button
                    key={h.house}
                    onClick={() => setDetail("houses")}
                    className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-yolk-50"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-yolk-100 text-[10px] font-bold text-yolk-700">
                      {h.house}
                    </span>
                    <span className="min-w-0 flex-1">
                      <Bar pct={h.layRatePct} />
                    </span>
                    <span className="w-9 shrink-0 text-right text-[11px] font-bold tabular-nums text-soil-800">{num(h.layRatePct, 0)}%</span>
                  </button>
                ))}
                {!data.farm.houses.length && <div className="text-xs text-soil-400">No laying houses in this range.</div>}
              </div>
            </div>
          </div>

          {/* ── Everything the farm feeds and is fed by ── */}
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {/* Sales */}
            <Tile icon={<ShoppingCart size={15} />} title="Sales" hint="market only, group excluded">
              <div className="grid grid-cols-3 gap-1">
                <Metric label="Total sales" value={lakh(data.sales.totalSales)} sub={`${data.sales.invoiceCount} invoices`} onClick={() => setDetail("customers")} />
                <Metric label="Eggs sold" value={num(data.sales.totalEggs)} onClick={() => setDetail("customers")} />
                <Metric label="Benchmark" value={`₹${num(data.sales.avgBenchmarkRate, 2)}`} sub="per egg, avg" />
              </div>
              <div className="mt-2 border-t border-soil-100 pt-2.5">
                <Sparkline points={data.sales.priceHistory} />
              </div>
            </Tile>

            {/* People — today's presence is always today; the range drives cost */}
            {people && (
              <Tile icon={<Users size={15} />} title="People" hint={`${people.totalStaff} on the rolls`}>
                <div className="grid grid-cols-3 gap-1 md:grid-cols-5">
                  <Metric label="Present" value={num(people.presentToday)} tone="good" onClick={() => setDetail("absent")} />
                  <Metric label="Inside now" value={num(people.insideNow.length)} onClick={() => setDetail("inside")} />
                  <Metric label="Absent" value={num(people.absentToday.length)} tone={people.absentToday.length ? "bad" : undefined} onClick={() => setDetail("absent")} />
                  <Metric
                    label="Attend."
                    value={people.attendancePct == null ? "—" : `${num(people.attendancePct, 1)}%`}
                    sub="range"
                  />
                  <Metric label="Wages" value={lakh(people.wagesCost)} sub="daily wage" />
                </div>
                <div className="mt-2 space-y-1.5 border-t border-soil-100 pt-2.5">
                  {people.byDepartment.map((d) => (
                    <div key={d.department} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 truncate text-soil-600">{d.department}</span>
                      <Bar pct={d.total ? (d.present / d.total) * 100 : 0} />
                      <span className="w-11 shrink-0 text-right tabular-nums text-soil-500">{d.present}/{d.total}</span>
                    </div>
                  ))}
                  {!people.byDepartment.length && <div className="text-xs text-soil-400">No departments yet.</div>}
                </div>
              </Tile>
            )}

            {/* Purchases */}
            <Tile icon={<Truck size={15} />} title="Purchases" hint="through the gate">
              <div className="grid grid-cols-3 gap-1">
                <Metric label="Received" value={tons(data.purchases.totalTonnageKg)} onClick={() => setDetail("received")} />
                <Metric label="Deliveries" value={num(data.purchases.deliveryCount)} onClick={() => setDetail("received")} />
                <Metric label="Pending PO" value={tons(data.purchases.pendingTonnageKg)} onClick={() => setDetail("pending")} />
              </div>
              <div className="mt-2 space-y-1.5 border-t border-soil-100 pt-2.5">
                {ing.slice(0, 6).map((i) => (
                  <div key={i.name} className="flex items-center gap-2 text-xs">
                    <span className="w-24 shrink-0 truncate text-soil-600">{i.name}</span>
                    <Bar pct={(i.kg / ingMax) * 100} />
                    <span className="w-12 shrink-0 text-right tabular-nums text-soil-800">{tons(i.kg)}</span>
                    <span className="w-14 shrink-0 text-right tabular-nums text-soil-400">₹{num(i.avgRate, 2)}/kg</span>
                  </div>
                ))}
                {!ing.length && <div className="text-xs text-soil-400">No receipts in this range.</div>}
              </div>
            </Tile>

            {/* Feed mill */}
            <Tile
              icon={<Factory size={15} />}
              title="Feed mill"
              hint={data.feedMill.totalProducedKg ? `${num(dispatchedPct, 0)}% sent to sheds` : undefined}
            >
              <div className="grid grid-cols-3 gap-1">
                <Metric label="Produced" value={tons(data.feedMill.totalProducedKg)} onClick={() => setDetail("produced")} />
                <Metric label="Sent" value={tons(data.feedMill.totalTransferredKg)} onClick={() => setDetail("sent")} />
                <Metric label="₹ / ton" value={data.feedMill.costPerKg ? formatMoney(data.feedMill.costPerKg * 1000) : "—"} sub="raw + ₹1/kg" onClick={() => setDetail("produced")} />
              </div>
              <div className="mt-2.5 border-t border-soil-100 pt-2.5">
                <Bar pct={dispatchedPct} />
                <div className="mt-1.5 text-[11px] text-soil-400">
                  {data.feedMill.produced.length} formula{data.feedMill.produced.length === 1 ? "" : "s"} ·{" "}
                  {data.feedMill.produced.reduce((a, p) => a + p.batches, 0)} batches
                </div>
              </div>
            </Tile>

            {/* Finance */}
            <Tile icon={<Landmark size={15} />} title="Finance" hint="AR / AP as of today" span="lg:col-span-2 2xl:col-span-3">
              <div className="grid grid-cols-2 gap-1 md:grid-cols-4">
                <Metric label="Revenue" value={lakh(data.finance.totalRevenue)} onClick={() => setDetail("customers")} />
                <Metric label="Feed cost" value={lakh(data.finance.totalFeedCost)} sub={`${num(data.finance.grossMarginPct, 1)}% margin`} onClick={() => setDetail("produced")} />
                <Metric label="Receivables" value={lakh(data.finance.receivables)} tone="good" />
                <Metric label="Payables" value={lakh(data.finance.payables)} tone="bad" onClick={() => setDetail("payables")} />
              </div>
            </Tile>
          </div>
        </div>
      )}

      {/* Drill-downs */}
      <Dialog open={detail !== null} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-w-4xl">
          {data && detail === "received" && (
            <>
              <DialogHeader><DialogTitle>Received at the gate · {dmy(from)} – {dmy(to)}</DialogTitle></DialogHeader>
              <DTable
                rows={data.purchases.deliveries}
                cols={[
                  { h: "Date", v: (r) => dmy(r.date) },
                  { h: "Item", v: (r) => r.item },
                  { h: "Vendor", v: (r) => r.vendor },
                  { h: "Kg", v: (r) => num(r.kg), right: true },
                  { h: "₹/kg", v: (r) => num(r.rate, 2), right: true },
                  { h: "Value", v: (r) => formatMoney(r.value), right: true },
                ]}
                totals={["Total", `${data.purchases.deliveryCount} deliveries`, "", num(data.purchases.totalTonnageKg), "", formatMoney(data.purchases.deliveries.reduce((a, r) => a + r.value, 0))]}
              />
            </>
          )}
          {data && detail === "pending" && (
            <>
              <DialogHeader><DialogTitle>Open purchase orders</DialogTitle></DialogHeader>
              <DTable
                rows={data.purchases.pendingPOs}
                cols={[
                  { h: "PO", v: (r) => r.number },
                  { h: "Vendor", v: (r) => r.vendor },
                  { h: "Item", v: (r) => r.item },
                  { h: "Pending kg", v: (r) => num(r.pendingKg), right: true },
                  { h: "₹/kg", v: (r) => num(r.rate, 2), right: true },
                ]}
                totals={["Total", "", "", num(data.purchases.pendingTonnageKg), ""]}
              />
            </>
          )}
          {data && detail === "produced" && (
            <>
              <DialogHeader><DialogTitle>Feed produced · {dmy(from)} – {dmy(to)}</DialogTitle></DialogHeader>
              <DTable
                rows={data.feedMill.produced}
                cols={[
                  { h: "Formula", v: (r) => r.formula },
                  { h: "Batches", v: (r) => r.batches, right: true },
                  { h: "Kg", v: (r) => num(r.kg), right: true },
                  { h: "₹/kg", v: (r) => num(r.costPerKg, 2), right: true },
                  { h: "Value", v: (r) => formatMoney(r.kg * r.costPerKg), right: true },
                ]}
                totals={["Total", data.feedMill.produced.reduce((a, p) => a + p.batches, 0), num(data.feedMill.totalProducedKg), num(data.feedMill.costPerKg, 2), formatMoney(data.finance.totalFeedCost)]}
              />
            </>
          )}
          {data && detail === "sent" && (
            <>
              <DialogHeader><DialogTitle>Feed sent to sheds · {dmy(from)} – {dmy(to)}</DialogTitle></DialogHeader>
              <DTable
                rows={data.feedMill.transferred}
                cols={[
                  { h: "House", v: (r) => r.house },
                  { h: "Feed", v: (r) => r.item },
                  { h: "Kg", v: (r) => num(r.kg), right: true },
                  { h: "₹/kg", v: (r) => num(r.ratePerKg, 2), right: true },
                ]}
                totals={["Total", "", num(data.feedMill.totalTransferredKg), ""]}
              />
            </>
          )}
          {data && detail === "houses" && (
            <>
              <DialogHeader><DialogTitle>Laying houses · {dmy(from)} – {dmy(to)}</DialogTitle></DialogHeader>
              <DTable
                rows={data.farm.houses}
                cols={[
                  { h: "House", v: (r) => r.house },
                  { h: "Days", v: (r) => r.days, right: true },
                  { h: "Eggs", v: (r) => num(r.eggs), right: true },
                  { h: "Lay %", v: (r) => num(r.layRatePct, 1), right: true },
                  { h: "Feed kg", v: (r) => num(r.feedKg), right: true },
                  { h: "g/egg", v: (r) => num(r.feedPerEggG, 1), right: true },
                  { h: "Dead", v: (r) => r.mortality, right: true },
                  { h: "Mort %", v: (r) => num(r.mortalityPct, 2), right: true },
                ]}
                totals={["Total", "", num(data.farm.totalEggs), num(data.farm.layRatePct, 1), num(data.farm.houses.reduce((a, h) => a + h.feedKg, 0)), num(data.farm.feedPerEggG, 1), data.farm.houses.reduce((a, h) => a + h.mortality, 0), num(data.farm.mortalityPct, 2)]}
              />
            </>
          )}
          {data && detail === "customers" && (
            <>
              <DialogHeader><DialogTitle>Sales by customer · {dmy(from)} – {dmy(to)}</DialogTitle></DialogHeader>
              <DTable
                rows={data.sales.salesList}
                cols={[
                  { h: "Customer", v: (r) => r.customer },
                  { h: "Invoices", v: (r) => r.invoices, right: true },
                  { h: "Eggs", v: (r) => num(r.eggs), right: true },
                  { h: "₹/egg", v: (r) => (r.eggs ? num(r.value / r.eggs, 2) : "—"), right: true },
                  { h: "Value", v: (r) => formatMoney(r.value), right: true },
                ]}
                totals={["Total", data.sales.invoiceCount, num(data.sales.totalEggs), data.sales.totalEggs ? num(data.sales.totalSales / data.sales.totalEggs, 2) : "—", formatMoney(data.sales.totalSales)]}
              />
            </>
          )}
          {people && detail === "absent" && (
            <>
              <DialogHeader><DialogTitle>Absent today</DialogTitle></DialogHeader>
              <DTable
                rows={people.absentToday}
                cols={[
                  { h: "Employee", v: (r) => r.name },
                  { h: "Code", v: (r) => r.empCode },
                  { h: "Department", v: (r) => r.department ?? "—" },
                ]}
                totals={[`${people.absentToday.length} absent`, "", ""]}
              />
            </>
          )}
          {people && detail === "inside" && (
            <>
              <DialogHeader><DialogTitle>Inside now</DialogTitle></DialogHeader>
              <DTable
                rows={people.insideNow}
                cols={[
                  { h: "Employee", v: (r) => r.name },
                  { h: "Code", v: (r) => r.empCode },
                  { h: "Department", v: (r) => r.department ?? "—" },
                  { h: "In since", v: (r) => (r.since ? new Date(r.since).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—"), right: true },
                ]}
                totals={[`${people.insideNow.length} inside`, "", "", ""]}
              />
            </>
          )}
          {data && detail === "payables" && (
            <>
              <DialogHeader><DialogTitle>Open bills</DialogTitle></DialogHeader>
              <DTable
                rows={data.finance.apDetails}
                cols={[
                  { h: "Vendor", v: (r) => r.vendor },
                  { h: "Bill", v: (r) => r.number },
                  { h: "Due", v: (r) => dmy(r.dueDate) },
                  { h: "Status", v: (r) => r.status.replace("_", " ") },
                  { h: "Total", v: (r) => formatMoney(r.total), right: true },
                  { h: "Balance", v: (r) => formatMoney(r.balanceDue), right: true },
                ]}
                totals={["Total", `${data.finance.apDetails.length} bills`, "", "", "", formatMoney(data.finance.payables)]}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
