/**
 * Home — the boss view. The whole operation on one screen for a chosen
 * range: what came through the gate, what the mill made, what the sheds
 * laid, what the market bought, and what is owed either way. Every tile
 * opens into the table it was summed from.
 *
 * Ported from Amino's executive report, People section included now that
 * the Payroll module supplies it.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Egg, Factory, Landmark, Loader2, ShoppingCart, Truck, Users } from "lucide-react";
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
  attendancePct: number;
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
const num = (v: number, d = 0) => v.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const tons = (kg: number) => `${num(kg / 1000, 1)} t`;
const lakh = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${num(v / 1e7, 2)} cr`;
  if (a >= 1e5) return `₹${num(v / 1e5, 2)} L`;
  return formatMoney(v);
};
const dmy = (iso: string | null) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "—");

/* ── Pieces ────────────────────────────────────────────────────────────── */
function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="chip bg-brand-50 text-brand-600">{icon}</span>
          <h2 className="text-[15px] font-bold">{title}</h2>
        </div>
        {hint && <span className="text-xs text-gray-400">{hint}</span>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

/** A figure that opens its table. */
function Stat({
  label,
  value,
  sub,
  onClick,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
  tone?: "good" | "bad";
}) {
  const color = tone === "good" ? "text-green-600" : tone === "bad" ? "text-red-600" : "";
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="group rounded-md px-3 py-2 text-left transition hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
      {onClick && <div className="text-[10px] text-brand-600 opacity-0 group-hover:opacity-100">see detail →</div>}
    </button>
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
  if (!rows.length) return <div className="py-6 text-center text-sm text-gray-400">Nothing in this range.</div>;
  return (
    <div className="table-surface max-h-[60vh] overflow-auto">
      <table className="w-full text-sm">
        <thead className="table-head sticky top-0">
          <tr>
            {cols.map((c) => (
              <th key={c.h} className={`table-th ${c.right ? "text-right" : "text-left"}`}>
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-gray-100 last:border-0">
              {cols.map((c) => (
                <td key={c.h} className={`px-3 py-1.5 ${c.right ? "text-right tabular-nums" : ""}`}>
                  {c.v(r)}
                </td>
              ))}
            </tr>
          ))}
          {totals && (
            <tr className="bg-gray-50 font-semibold">
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

/** Benchmark price over the last thirty settings. */
function Sparkline({ points }: { points: { date: string; price: number }[] }) {
  if (points.length < 2) return <div className="text-xs text-gray-400">Not enough benchmark history for a line.</div>;
  const w = 320;
  const h = 64;
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
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none">
        <path d={`${d} L${w},${h} L0,${h} Z`} className="fill-brand-50" />
        <path d={d} className="fill-none stroke-brand-500" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <circle cx={x(points.length - 1)} cy={y(last.price)} r={3} className="fill-brand-600" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-gray-500">
        <span>
          {dmy(points[0]!.date)} · ₹{num(points[0]!.price, 2)}
        </span>
        <span>
          {dmy(last.date)} · <strong>₹{num(last.price, 2)}</strong>
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

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="border-b border-gray-200 bg-gradient-to-r from-white via-white to-brand-50 px-7 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight">Hello, {user?.name?.split(" ")[0] ?? "there"} 👋</h1>
            <div className="mt-0.5 text-[13px] text-gray-500">
              {org?.name || "Set up your organisation in Settings"} · {dmy(from)} – {dmy(to)}
            </div>
          </div>
          <div className="flex gap-1 rounded-md bg-white p-1 shadow-sm ring-1 ring-gray-200">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded px-3 py-1 text-[13px] font-medium ${range === r ? "bg-brand-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="flex items-center justify-center py-24 text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Adding it up…
        </div>
      ) : (
        <div className="mx-auto max-w-6xl space-y-4 p-6">
          {/* Farm — the hero: it is what the whole place is for */}
          <Section icon={<Egg size={17} />} title="Farm" hint={`${data.farm.houses.length} laying houses`}>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Eggs laid" value={num(data.farm.totalEggs)} onClick={() => setDetail("houses")} />
              <Stat label="Lay rate" value={`${num(data.farm.layRatePct, 1)}%`} tone={data.farm.layRatePct >= 85 ? "good" : undefined} onClick={() => setDetail("houses")} />
              <Stat label="Mortality" value={`${num(data.farm.mortalityPct, 2)}%`} tone={data.farm.mortalityPct > 1 ? "bad" : undefined} onClick={() => setDetail("houses")} />
              <Stat label="Feed per egg" value={`${num(data.farm.feedPerEggG, 1)} g`} onClick={() => setDetail("houses")} />
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {data.farm.houses.map((h) => (
                <div key={h.house} className="rounded-md bg-gray-50 px-3 py-2">
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold">{h.house}</span>
                    <span className="text-xs text-gray-500">{num(h.layRatePct, 1)}%</span>
                  </div>
                  <div className="text-sm tabular-nums">{num(h.eggs)} eggs</div>
                  <div className="text-[11px] text-gray-500">
                    {num(h.feedPerEggG, 0)} g/egg · {h.mortality} dead
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Purchases */}
            <Section icon={<Truck size={17} />} title="Purchases" hint="through the gate">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Received" value={tons(data.purchases.totalTonnageKg)} onClick={() => setDetail("received")} />
                <Stat label="Deliveries" value={num(data.purchases.deliveryCount)} onClick={() => setDetail("received")} />
                <Stat label="Pending PO" value={tons(data.purchases.pendingTonnageKg)} onClick={() => setDetail("pending")} />
              </div>
              <div className="mt-3 space-y-1.5">
                {ing.slice(0, 6).map((i) => (
                  <div key={i.name} className="flex items-center gap-2 text-xs">
                    <span className="w-28 truncate text-gray-600">{i.name}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                      <div className="h-full bg-brand-500" style={{ width: `${(i.kg / ingMax) * 100}%` }} />
                    </div>
                    <span className="w-14 text-right tabular-nums">{tons(i.kg)}</span>
                    <span className="w-16 text-right tabular-nums text-gray-500">₹{num(i.avgRate, 2)}/kg</span>
                  </div>
                ))}
                {!ing.length && <div className="text-xs text-gray-400">No receipts in this range.</div>}
              </div>
            </Section>

            {/* Feed mill */}
            <Section icon={<Factory size={17} />} title="Feed mill" hint={data.feedMill.totalProducedKg ? `${num(dispatchedPct, 0)}% of production sent to sheds` : undefined}>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Produced" value={tons(data.feedMill.totalProducedKg)} onClick={() => setDetail("produced")} />
                <Stat label="Sent to sheds" value={tons(data.feedMill.totalTransferredKg)} onClick={() => setDetail("sent")} />
                <Stat label="Cost per ton" value={data.feedMill.costPerKg ? formatMoney(data.feedMill.costPerKg * 1000) : "—"} sub="raw + ₹1/kg" onClick={() => setDetail("produced")} />
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded bg-gray-100">
                <div className="h-full bg-brand-500" style={{ width: `${Math.min(100, dispatchedPct)}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-gray-500">
                {data.feedMill.produced.length} formula{data.feedMill.produced.length === 1 ? "" : "s"} ·{" "}
                {data.feedMill.produced.reduce((a, p) => a + p.batches, 0)} batches
              </div>
            </Section>

            {/* Sales */}
            <Section icon={<ShoppingCart size={17} />} title="Sales" hint="market only, group companies excluded">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Total sales" value={lakh(data.sales.totalSales)} sub={`${data.sales.invoiceCount} invoices`} onClick={() => setDetail("customers")} />
                <Stat label="Eggs sold" value={num(data.sales.totalEggs)} onClick={() => setDetail("customers")} />
                <Stat label="Benchmark" value={`₹${num(data.sales.avgBenchmarkRate, 2)}`} sub="per egg, avg" />
              </div>
              <div className="mt-3">
                <Sparkline points={data.sales.priceHistory} />
              </div>
            </Section>

            {/* People — today's presence is always today; the range drives cost */}
            {people && (
              <Section icon={<Users size={17} />} title="People" hint={`${people.totalStaff} on the rolls`}>
                <div className="grid grid-cols-3 gap-2 md:grid-cols-5">
                  <Stat label="Present today" value={num(people.presentToday)} tone="good" onClick={() => setDetail("absent")} />
                  <Stat label="Inside now" value={num(people.insideNow.length)} onClick={() => setDetail("inside")} />
                  <Stat label="Absent" value={num(people.absentToday.length)} tone={people.absentToday.length ? "bad" : undefined} onClick={() => setDetail("absent")} />
                  <Stat label="Attendance" value={`${num(people.attendancePct, 1)}%`} sub="over the range" />
                  <Stat label="Wages cost" value={lakh(people.wagesCost)} sub="daily wage, range" />
                </div>
                <div className="mt-3 space-y-1.5">
                  {people.byDepartment.map((d) => (
                    <div key={d.department} className="flex items-center gap-2 text-xs">
                      <span className="w-28 truncate text-gray-600">{d.department}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                        <div className="h-full bg-brand-500" style={{ width: `${d.total ? (d.present / d.total) * 100 : 0}%` }} />
                      </div>
                      <span className="w-14 text-right tabular-nums">{d.present}/{d.total}</span>
                    </div>
                  ))}
                  {!people.byDepartment.length && <div className="text-xs text-gray-400">No departments yet.</div>}
                </div>
              </Section>
            )}

            {/* Finance */}
            <Section icon={<Landmark size={17} />} title="Finance" hint="AR / AP as of today">
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Revenue" value={lakh(data.finance.totalRevenue)} onClick={() => setDetail("customers")} />
                <Stat label="Feed cost" value={lakh(data.finance.totalFeedCost)} sub={`${num(data.finance.grossMarginPct, 1)}% gross margin`} onClick={() => setDetail("produced")} />
                <Stat label="Receivables" value={lakh(data.finance.receivables)} tone="good" />
                <Stat label="Payables" value={lakh(data.finance.payables)} tone="bad" onClick={() => setDetail("payables")} />
              </div>
            </Section>
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
