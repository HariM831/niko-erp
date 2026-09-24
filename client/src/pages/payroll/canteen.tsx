/**
 * Canteen — plates served by the canteen devices, reconciled against the
 * day's attendance.
 *
 *   Today       the day's servings per canteen × meal
 *   Exceptions  overrides, guests, second plates, outside-window, and plates
 *               served to people the gate never saw
 *   Report      plates by canteen × meal × state over a range, cost per plate
 *   Canteens & windows   the rooms and their meal timings
 *   Eligibility          who gets breakfast / dinner
 */
import { SERVING_STATES, SERVING_STATE_LABEL, type ServingState } from "@shared/canteen";
import { filterRows, useAdvancedSearch, type Criteria, type SearchField } from "../../components/advanced-search";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearch } from "../../components/search-context";
import { matchesTerm } from "../../lib/utils";
import { Plus } from "lucide-react";
import { api, formatMoney } from "../../api";
import { SearchSelect } from "../../components/search-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Badge, Empty, ErrorBanner, Field, PAGE_SIZE, PageHeader, Pager, PillTabs, Spinner, Td, Th, dmy, fmtTime, istToday,
  num, useEmployees, useErr, usePaged,
} from "../../components/payroll/ui";
import { DateInput, TimeInput } from "../../components/date-input";

interface Canteen { id: string; code: string; name: string; locationId: string; isActive: boolean }
interface Window { id?: string; canteenId: string | null; meal: Meal; startTime: string; endTime: string; isActive?: boolean }
interface Serving {
  id: string;
  canteenId: string;
  canteenName?: string;
  mealDate: string;
  meal: Meal;
  employeeId: string | null;
  personName: string;
  state: "verified" | "name_matched" | "unverified_attendance" | "override" | "guest";
  matchScore: number | null;
  servedAt: string;
  tokenNumber: string;
  outsideWindow: boolean;
  extraPlateKind: "guest" | "second_plate" | "override" | null;
  guestParty: string | null;
  reasonCode: string | null;
  reasonText: string | null;
  attendancePresent: boolean | null;
}
interface Eligibility { employeeId: string; name?: string; empCode?: string; breakfast: boolean; breakfastAuto?: boolean; dinner: boolean; note: string | null }
/** Shape of GET /api/canteen/report — one cell per canteen × meal × state. */
interface Report {
  cells: { canteen: string; meal: Meal; state: string; plates: number }[];
  plates: number;
  guests?: number;
  byDate?: { date: string; plates: number }[];
  days?: { date: string; breakfast: number; lunch: number; dinner: number; total: number }[];
  totals?: { breakfast: number; lunch: number; dinner: number; total: number };
  costPerPlate?: number | null;
  totalExpense?: number | null;
  note?: string;
}
type Meal = "breakfast" | "lunch" | "dinner";
const MEALS: Meal[] = ["breakfast", "lunch", "dinner"];

const STATE_TONE: Record<Serving["state"], "green" | "gray" | "amber" | "red" | "blue"> = {
  verified: "green",
  name_matched: "blue",
  unverified_attendance: "amber",
  override: "red",
  guest: "gray",
};

type Tab = "today" | "exceptions" | "report" | "setup" | "eligibility";

const MEAL_OPTIONS = MEALS.map((m) => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1) }));
const FLAG_OPTIONS = [
  { value: "outside_window", label: "Outside window" },
  { value: "second_plate", label: "Second plate" },
  { value: "extra_plate", label: "Any extra plate" },
  { value: "no_punch", label: "Not at gate" },
];

/**
 * One advanced search per list. Plates served are paged on the server, so
 * that tab's criteria go there; exceptions and eligibility arrive whole and
 * are filtered here. Canteen and meal stay the Today tab's own pickers.
 */
const SERVING_SEARCH: SearchField[] = [
  { key: "employee", label: "Employee", kind: "employee" },
  // Replaces the tab's single day when given.
  { key: "mealDate", label: "Date Range", kind: "dateRange" },
  {
    key: "state",
    label: "State",
    kind: "select",
    options: SERVING_STATES.map((s) => ({ value: s, label: SERVING_STATE_LABEL[s] })),
  },
  { key: "flag", label: "Flag", kind: "select", options: [...FLAG_OPTIONS, { value: "not_on_list", label: "Not on the list" }] },
  { key: "token", label: "Token", kind: "text" },
  { key: "guestParty", label: "Guest Party", kind: "text" },
];
const EXCEPTION_SEARCH: SearchField[] = [
  { key: "employee", label: "Employee", kind: "employee" },
  { key: "meal", label: "Meal", kind: "select", options: MEAL_OPTIONS },
  { key: "flag", label: "Flag", kind: "select", options: [...FLAG_OPTIONS, { value: "guest", label: "Guest" }, { value: "override", label: "Override" }] },
  { key: "reason", label: "Reason Given", kind: "text" },
];
const ELIGIBILITY_SEARCH: SearchField[] = [
  { key: "employee", label: "Employee", kind: "employee" },
  { key: "breakfast", label: "Breakfast", kind: "select", options: [{ value: "yes", label: "Gets breakfast" }, { value: "no", label: "No breakfast" }] },
  { key: "dinner", label: "Dinner", kind: "select", options: [{ value: "yes", label: "Gets dinner" }, { value: "no", label: "No dinner" }] },
  { key: "payType", label: "Pay Type", kind: "select", options: [{ value: "salaried", label: "Salaried" }, { value: "daily_wage", label: "Daily wage" }] },
];

export function PayrollCanteenPage() {
  const [tab, setTab] = useState<Tab>("today");
  // One "Search in Canteen" for the tabs that list people; the report and the
  // setup are not lists of anyone. Switching tab clears it, as moving between
  // lists does.
  const peopleTab = tab === "today" || tab === "exceptions" || tab === "eligibility";
  const term = useLocalSearch("Canteen", peopleTab ? `payroll:canteen:${tab}` : null);
  const advToday = useAdvancedSearch("Plates served", SERVING_SEARCH);
  const advExceptions = useAdvancedSearch("Exceptions", EXCEPTION_SEARCH);
  const advEligibility = useAdvancedSearch("Eligibility", ELIGIBILITY_SEARCH);
  const adv = tab === "today" ? advToday : tab === "exceptions" ? advExceptions : tab === "eligibility" ? advEligibility : null;
  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Canteen" sub="Plates served on the devices, reconciled against the gate's attendance.">
        {adv?.button}
      </PageHeader>
      {adv?.dialog}
      <PillTabs
        tabs={[
          { key: "today", label: "Today" },
          { key: "exceptions", label: "Exceptions" },
          { key: "report", label: "Report" },
          { key: "setup", label: "Canteens & windows" },
          { key: "eligibility", label: "Eligibility" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "today" && <TodayTab term={term} criteria={advToday.criteria} />}
      {tab === "exceptions" && <ExceptionsTab term={term} criteria={advExceptions.criteria} />}
      {tab === "report" && <ReportTab />}
      {tab === "setup" && <SetupTab />}
      {tab === "eligibility" && <EligibilityTab term={term} criteria={advEligibility.criteria} />}
    </div>
  );
}

function useCanteens() {
  return useQuery({ queryKey: ["canteen", "canteens"], queryFn: () => api<Canteen[]>("/api/canteen/canteens") });
}

/* ── Today ─────────────────────────────────────────────────────────────── */
function TodayTab({ term, criteria }: { term: string; criteria: Criteria }) {
  const [date, setDate] = useState(istToday());
  const [canteenId, setCanteenId] = useState("");
  const [meal, setMeal] = useState("");
  const [offset, setOffset] = useState(0);

  const canteensQ = useCanteens();
  const advanced = new URLSearchParams(criteria).toString();
  // A date range in the advanced search replaces the day picked here.
  const ranged = !!(criteria.mealDateFrom || criteria.mealDateTo);
  const servingsQ = useQuery({
    queryKey: ["canteen", "servings", date, canteenId, meal, offset, term.trim(), advanced],
    queryFn: () =>
      api<{ rows: Serving[]; total: number }>(
        `/api/canteen/servings?date=${date}${canteenId ? `&canteenId=${canteenId}` : ""}${meal ? `&meal=${meal}` : ""}${term.trim() ? `&search=${encodeURIComponent(term.trim())}` : ""}${advanced ? `&${advanced}` : ""}&limit=${PAGE_SIZE}&offset=${offset}`,
      ),
    placeholderData: keepPreviousData,
  });
  // A new term or search starts from the first page; page 4 of the old one may not exist.
  useEffect(() => setOffset(0), [term, advanced]);

  const rows = servingsQ.data?.rows ?? [];
  const counts = useMemo(() => {
    const m: Record<Meal, number> = { breakfast: 0, lunch: 0, dinner: 0 };
    for (const r of rows) m[r.meal] += 1;
    return m;
  }, [rows]);
  const canteenName = (r: Serving) => r.canteenName ?? canteensQ.data?.find((c) => c.id === r.canteenId)?.name ?? "—";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DateInput
          className="input w-auto disabled:opacity-50"
          value={date}
          disabled={ranged}
          title={ranged ? "The advanced search's date range is in force" : undefined}
          onChange={(e) => { setDate(e.target.value); setOffset(0); }}
        />
        <SearchSelect
          className="w-44"
          value={canteenId || null}
          onChange={(id) => { setCanteenId(id ?? ""); setOffset(0); }}
          placeholder="All canteens"
          options={(canteensQ.data ?? []).map((c) => ({ id: c.id, label: c.name, sub: c.code }))}
        />
        <SearchSelect
          className="w-36"
          keepOrder
          value={meal || null}
          onChange={(v) => { if ((v ?? "") === meal) return; setMeal(v ?? ""); setOffset(0); }}
          placeholder="All meals"
          options={MEALS.map((m) => ({ id: m, label: m.charAt(0).toUpperCase() + m.slice(1) }))}
        />
        <span className="ml-auto text-[12px] tabular-nums text-gray-500">
          {servingsQ.data?.total ?? 0} plates{meal === "" && rows.length > 0 && ` · B ${counts.breakfast} / L ${counts.lunch} / D ${counts.dinner} on this page`}
        </span>
      </div>
      <div className="table-surface overflow-x-auto">
        {servingsQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Token</Th><Th>Person</Th><Th>Canteen</Th><Th>Meal</Th><Th>At</Th><Th>State</Th><Th>Flags</Th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="table-row">
                  <Td className="tabular-nums">{r.tokenNumber}</Td>
                  <Td className="font-medium">{r.personName}{r.guestParty && <span className="ml-1 text-[11px] text-gray-400">({r.guestParty})</span>}</Td>
                  <Td>{canteenName(r)}</Td>
                  <Td className="capitalize">{r.meal}</Td>
                  <Td className="tabular-nums">{ranged && `${dmy(r.mealDate)} `}{fmtTime(r.servedAt)}</Td>
                  <Td><Badge tone={STATE_TONE[r.state]}>{SERVING_STATE_LABEL[r.state as ServingState] ?? r.state}</Badge></Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {r.outsideWindow && <Badge tone="amber">outside window</Badge>}
                      {r.extraPlateKind && <Badge tone="red">{r.extraPlateKind.replace(/_/g, " ")}</Badge>}
                      {r.attendancePresent === false && <Badge tone="red">not at gate</Badge>}
                    </span>
                  </Td>
                </tr>
              ))}
              {!rows.length && <tr><Td colSpan={7}><Empty>No plates served.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={servingsQ.data?.total ?? 0} offset={offset} onChange={setOffset} />
      </div>
    </div>
  );
}

/* ── Exceptions ────────────────────────────────────────────────────────── */
function ExceptionsTab({ term, criteria }: { term: string; criteria: Criteria }) {
  const [date, setDate] = useState(istToday());
  const exQ = useQuery({
    queryKey: ["canteen", "exceptions", date],
    // The server answers { date, exceptions }; reading only `rows` left this
    // tab empty whatever was flagged.
    queryFn: () => api<Serving[] | { rows?: Serving[]; exceptions?: Serving[] }>(`/api/canteen/exceptions?date=${date}`),
    select: (d) => (Array.isArray(d) ? d : (d.exceptions ?? d.rows ?? [])),
  });
  const rows = filterRows(
    (exQ.data ?? []).filter((r) => matchesTerm(term, [r.personName, r.guestParty, r.tokenNumber])),
    EXCEPTION_SEARCH,
    criteria,
    (r, key) => {
      switch (key) {
        case "employee":
          return r.employeeId;
        case "meal":
          return r.meal;
        case "flag": {
          // The same reasons the "Why flagged" column gives, as keys.
          const flags: string[] = [];
          if (r.outsideWindow) flags.push("outside_window");
          if (r.extraPlateKind) flags.push("extra_plate");
          if (r.extraPlateKind === "second_plate") flags.push("second_plate");
          if (r.attendancePresent === false) flags.push("no_punch");
          if (r.state === "guest" || r.extraPlateKind === "guest") flags.push("guest");
          if (r.state === "override" || r.extraPlateKind === "override") flags.push("override");
          return flags;
        }
        case "reason":
          return [r.reasonCode, r.reasonText];
      }
    },
  );
  const paged = usePaged(rows);

  const why = (r: Serving): string[] => {
    const out: string[] = [];
    if (r.extraPlateKind === "guest" || r.state === "guest") out.push("guest");
    if (r.extraPlateKind === "second_plate") out.push("second plate");
    if (r.extraPlateKind === "override" || r.state === "override") out.push("override");
    if (r.outsideWindow) out.push("outside window");
    if (r.attendancePresent === false) out.push("no gate punch");
    return out.length ? out : ["review"];
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <DateInput className="input w-auto" value={date} onChange={(e) => setDate(e.target.value)} />
        <span className="text-[12px] text-gray-500">{rows.length} to review</span>
      </div>
      <div className="table-surface overflow-x-auto">
        {exQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Person</Th><Th>Meal</Th><Th>At</Th><Th>Why flagged</Th><Th>Reason given</Th></tr>
            </thead>
            <tbody>
              {paged.page.map((r) => (
                <tr key={r.id} className="table-row">
                  <Td className="font-medium">{r.personName}{r.guestParty && <span className="ml-1 text-[11px] text-gray-400">({r.guestParty})</span>}</Td>
                  <Td className="capitalize">{r.meal}</Td>
                  <Td className="tabular-nums">{fmtTime(r.servedAt)}</Td>
                  <Td><span className="flex flex-wrap gap-1">{why(r).map((w) => <Badge key={w} tone="amber">{w}</Badge>)}</span></Td>
                  <Td className="text-gray-500">{[r.reasonCode, r.reasonText].filter(Boolean).join(" — ") || "—"}</Td>
                </tr>
              ))}
              {!paged.page.length && <tr><Td colSpan={5}><Empty>Nothing to review — every plate matches a face and a punch.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>
    </div>
  );
}

/* ── Report ────────────────────────────────────────────────────────────── */
function ReportTab() {
  const today = istToday();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const repQ = useQuery({
    queryKey: ["canteen", "report", from, to],
    queryFn: () => api<Report>(`/api/canteen/report?from=${from}&to=${to}`),
    enabled: from <= to,
  });
  const monthsQ = useQuery({
    queryKey: ["canteen", "report-monthly"],
    queryFn: () => api<{ months: { month: string; breakfast: number; lunch: number; dinner: number; total: number }[] }>("/api/canteen/report/monthly?months=12"),
  });
  const d = repQ.data;
  const cells = d?.cells ?? [];
  const total = d?.plates ?? cells.reduce((a, r) => a + r.plates, 0);

  return (
    <div>
      {/* The year at a glance, newest first; a month opens below as the range. */}
      {(monthsQ.data?.months.length ?? 0) > 0 && (
        <div className="table-surface mb-4">
          <table className="w-full">
            <thead className="table-head"><tr><Th>Month</Th><Th right>Breakfast</Th><Th right>Lunch</Th><Th right>Dinner</Th><Th right>Plates</Th></tr></thead>
            <tbody>
              {monthsQ.data!.months.map((m) => (
                <tr
                  key={m.month}
                  className="table-row cursor-pointer"
                  onClick={() => {
                    const [y, mo] = m.month.split("-").map(Number);
                    const last = new Date(Date.UTC(y!, mo!, 0)).toISOString().slice(0, 10);
                    setFrom(`${m.month}-01`);
                    setTo(last > today ? today : last);
                  }}
                >
                  <Td className="tabular-nums">{m.month}</Td>
                  <Td right>{num(m.breakfast)}</Td><Td right>{num(m.lunch)}</Td><Td right>{num(m.dinner)}</Td>
                  <Td right className="font-semibold">{num(m.total)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DateInput className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-gray-400">–</span>
        <DateInput className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} />
        {from <= to && (
          <a className="btn-secondary" href={`/api/canteen/report?from=${from}&to=${to}&format=csv`}>Download CSV</a>
        )}
        {d && (
          <span className="ml-auto flex gap-4 text-[12px] tabular-nums text-gray-500">
            <span>{num(total)} plates</span>
            {d.guests != null && <span>{num(d.guests)} guest</span>}
            {d.costPerPlate != null && <span>{formatMoney(d.costPerPlate)} / plate</span>}
            {d.totalExpense != null && <span>{formatMoney(d.totalExpense)} total</span>}
            {d.note && <span className="text-gray-400">{d.note}</span>}
          </span>
        )}
      </div>
      {(d?.days?.length ?? 0) > 1 && <PlatesByDay days={d!.days!} />}
      {(d?.days?.length ?? 0) > 0 && (
        <div className="table-surface mb-4">
          <table className="w-full">
            <thead className="table-head"><tr><Th>Date</Th><Th right>Breakfast</Th><Th right>Lunch</Th><Th right>Dinner</Th><Th right>Total</Th></tr></thead>
            <tbody>
              {d!.days!.map((r) => (
                <tr key={r.date} className="table-row">
                  <Td className="tabular-nums">{dmy(r.date)}</Td>
                  <Td right>{num(r.breakfast)}</Td><Td right>{num(r.lunch)}</Td><Td right>{num(r.dinner)}</Td><Td right>{num(r.total)}</Td>
                </tr>
              ))}
              {d!.totals && (
                <tr className="bg-gray-50 font-semibold">
                  <Td>Total</Td><Td right>{num(d!.totals.breakfast)}</Td><Td right>{num(d!.totals.lunch)}</Td><Td right>{num(d!.totals.dinner)}</Td><Td right>{num(d!.totals.total)}</Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-surface">
        {repQ.isLoading ? (
          <Spinner />
        ) : (
          <CellsGrid cells={cells} total={total} />
        )}
      </div>
    </div>
  );
}

/**
 * recharts 3 types the Tooltip's formatters more tightly than these charts
 * need; widened once, as the shed-conditions charts do.
 */
const Tooltip = RechartsTooltip as unknown as (props: Record<string, unknown>) => ReactElement;

/** Plates a day in the range, stacked by meal — which days spiked, and in which meal. */
function PlatesByDay({ days }: { days: NonNullable<Report["days"]> }) {
  const data = days.map((r) => ({ ...r, label: dmy(r.date).slice(0, 5) }));
  return (
    <div className="table-surface mb-4 px-3 pb-2 pt-3">
      <div className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
            <Tooltip formatter={(v: number, n: string) => [`${v} plates`, n]} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="breakfast" name="Breakfast" stackId="m" fill="var(--color-brand-200)" isAnimationActive={false} />
            <Bar dataKey="lunch" name="Lunch" stackId="m" fill="var(--color-brand-500)" isAnimationActive={false} />
            <Bar dataKey="dinner" name="Dinner" stackId="m" fill="var(--color-soil-600)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * The range's plates by canteen and state, with the meals across. It was one
 * row per canteen, meal and state — thirty rows for two canteens — so the
 * same canteen's lunch and dinner sat far apart.
 */
function CellsGrid({ cells, total }: { cells: Report["cells"]; total: number }) {
  const meals: Meal[] = ["breakfast", "lunch", "dinner"];
  const rows = new Map<string, { canteen: string; state: string; by: Record<Meal, number> }>();
  for (const c of cells) {
    const k = `${c.canteen}\u0000${c.state}`;
    const r = rows.get(k) ?? { canteen: c.canteen, state: c.state, by: { breakfast: 0, lunch: 0, dinner: 0 } };
    r.by[c.meal] += c.plates;
    rows.set(k, r);
  }
  const list = [...rows.values()].sort((a, b) => a.canteen.localeCompare(b.canteen) || SERVING_STATES.indexOf(a.state as ServingState) - SERVING_STATES.indexOf(b.state as ServingState));
  const col = (m: Meal) => cells.filter((c) => c.meal === m).reduce((a, c) => a + c.plates, 0);
  return (
    <table className="w-full">
      <thead className="table-head">
        <tr><Th>Canteen</Th><Th>State</Th><Th right>Breakfast</Th><Th right>Lunch</Th><Th right>Dinner</Th><Th right>Plates</Th></tr>
      </thead>
      <tbody>
        {list.map((r, i) => (
          <tr key={i} className="table-row">
            <Td className={i > 0 && list[i - 1]!.canteen === r.canteen ? "text-transparent" : "font-medium"}>{r.canteen}</Td>
            <Td>{SERVING_STATE_LABEL[r.state as ServingState] ?? r.state}</Td>
            {meals.map((m) => <Td key={m} right>{r.by[m] ? num(r.by[m]) : ""}</Td>)}
            <Td right className="font-medium">{num(r.by.breakfast + r.by.lunch + r.by.dinner)}</Td>
          </tr>
        ))}
        {!list.length && <tr><Td colSpan={6}><Empty>No plates in this range.</Empty></Td></tr>}
        {list.length > 0 && (
          <tr className="bg-gray-50 font-semibold">
            <Td colSpan={2}>Total</Td>
            {meals.map((m) => <Td key={m} right>{num(col(m))}</Td>)}
            <Td right>{num(total)}</Td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/* ── Canteens & windows ────────────────────────────────────────────────── */
function SetupTab() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const canteensQ = useCanteens();
  const locQ = useQuery({ queryKey: ["locations"], queryFn: () => api<{ id: string; name: string }[]>("/api/locations") });
  const [scope, setScope] = useState<string>("global");
  const windowsQ = useQuery({
    queryKey: ["canteen", "windows", scope],
    queryFn: () => api<Window[]>(`/api/canteen/windows${scope !== "global" ? `?canteenId=${scope}` : ""}`),
  });
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", locationId: "" });

  const createM = useMutation({
    mutationFn: () => api("/api/canteen/canteens", { method: "POST", body: form }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["canteen", "canteens"] }); setAddOpen(false); setForm({ code: "", name: "", locationId: "" }); },
    onError: fail,
  });
  const toggleM = useMutation({
    mutationFn: (c: Canteen) => api(`/api/canteen/canteens/${c.id}`, { method: "PATCH", body: { isActive: !c.isActive } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["canteen", "canteens"] }),
    onError: fail,
  });

  // Meal-window editor: one row per meal for the chosen scope, PUT the lot.
  const [winForm, setWinForm] = useState<Record<Meal, { startTime: string; endTime: string }> | null>(null);
  const windows = windowsQ.data ?? [];
  const current = (m: Meal) => {
    const scoped = windows.find((w) => w.meal === m && (scope === "global" ? w.canteenId == null : w.canteenId === scope));
    return scoped ?? windows.find((w) => w.meal === m && w.canteenId == null) ?? null;
  };
  const effective = winForm ?? (Object.fromEntries(
    MEALS.map((m) => {
      const w = current(m);
      return [m, { startTime: w?.startTime ?? "", endTime: w?.endTime ?? "" }];
    }),
  ) as Record<Meal, { startTime: string; endTime: string }>);

  const saveWindows = useMutation({
    mutationFn: () =>
      api("/api/canteen/windows", {
        method: "PUT",
        body: MEALS.filter((m) => effective[m].startTime && effective[m].endTime).map((m) => ({
          canteenId: scope === "global" ? null : scope,
          meal: m,
          startTime: effective[m].startTime,
          endTime: effective[m].endTime,
        })),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["canteen", "windows"] }); setWinForm(null); },
    onError: fail,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">Canteens</h2>
          <button className="btn-secondary" onClick={() => setAddOpen(true)}><Plus size={14} /> Add canteen</button>
        </div>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        <div className="table-surface">
          {canteensQ.isLoading ? (
            <Spinner />
          ) : (
            <table className="w-full">
              <thead className="table-head"><tr><Th>Code</Th><Th>Name</Th><Th>Location</Th><Th /></tr></thead>
              <tbody>
                {(canteensQ.data ?? []).map((c) => (
                  <tr key={c.id} className="table-row">
                    <Td className="tabular-nums">{c.code}</Td>
                    <Td className="font-medium">{c.name} {!c.isActive && <Badge tone="gray">inactive</Badge>}</Td>
                    <Td>{locQ.data?.find((l) => l.id === c.locationId)?.name ?? "—"}</Td>
                    <Td right><button className="btn-ghost" onClick={() => toggleM.mutate(c)}>{c.isActive ? "Deactivate" : "Activate"}</button></Td>
                  </tr>
                ))}
                {!canteensQ.data?.length && <tr><Td colSpan={4}><Empty>No canteens yet.</Empty></Td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">Meal windows</h2>
          <SearchSelect
            className="w-48"
            value={scope}
            onChange={(id) => {
              // Re-picking the same scope must not throw away unsaved window edits.
              if (!id || id === scope) return;
              setScope(id);
              setWinForm(null);
            }}
            allowClear={false}
            keepOrder
            options={[
              { id: "global", label: "Global default" },
              ...(canteensQ.data ?? []).map((c) => ({ id: c.id, label: c.name, sub: c.code })),
            ]}
          />
        </div>
        <div className="card p-4">
          <div className="space-y-2">
            {MEALS.map((m) => (
              <div key={m} className="flex items-center gap-2">
                <span className="w-24 text-[13px] capitalize">{m}</span>
                <TimeInput
                  className="input w-auto"
                  value={effective[m].startTime}
                  onChange={(e) => setWinForm({ ...effective, [m]: { ...effective[m], startTime: e.target.value } })}
                />
                <span className="text-gray-400">–</span>
                <TimeInput
                  className="input w-auto"
                  value={effective[m].endTime}
                  onChange={(e) => setWinForm({ ...effective, [m]: { ...effective[m], endTime: e.target.value } })}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[11px] text-gray-400">
              {scope === "global" ? "Applies wherever a canteen has no windows of its own." : "Overrides the global default for this canteen."}
            </span>
            <button className="btn-primary" disabled={!winForm || saveWindows.isPending} onClick={() => saveWindows.mutate()}>Save windows</button>
          </div>
        </div>
      </div>

      <Dialog open={addOpen} onOpenChange={(v) => !v && setAddOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add canteen</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Field label="Code" required><input className="input" maxLength={12} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
            <Field label="Name" required><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Location" required>
              <SearchSelect
                value={form.locationId || null}
                onChange={(id) => setForm({ ...form, locationId: id ?? "" })}
                placeholder="—"
                options={(locQ.data ?? []).map((l) => ({ id: l.id, label: l.name }))}
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setAddOpen(false)}>Cancel</button>
            <button className="btn-primary" disabled={createM.isPending || !form.code || !form.name || !form.locationId} onClick={() => createM.mutate()}>Add</button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── Eligibility ───────────────────────────────────────────────────────── */
function EligibilityTab({ term, criteria }: { term: string; criteria: Criteria }) {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const empQ = useEmployees();
  const eligQ = useQuery({ queryKey: ["canteen", "eligibility"], queryFn: () => api<Eligibility[]>("/api/canteen/eligibility") });

  const byId = useMemo(() => new Map((eligQ.data ?? []).map((e) => [e.employeeId, e])), [eligQ.data]);
  const rows = useMemo(
    () =>
      filterRows(
        (empQ.data ?? []).filter((e) => matchesTerm(term, [e.name, e.empCode, e.department])),
        ELIGIBILITY_SEARCH,
        criteria,
        (e, key) => {
          const el = byId.get(e.id);
          switch (key) {
            case "employee":
              return e.id;
            // Breakfast granted for a night shift counts: the plate is theirs either way.
            case "breakfast":
              return el?.breakfast || el?.breakfastAuto ? "yes" : "no";
            case "dinner":
              return el?.dinner ? "yes" : "no";
            case "payType":
              return e.payType;
          }
        },
      ),
    [empQ.data, term, criteria, byId],
  );
  const paged = usePaged(rows);

  const saveM = useMutation({
    mutationFn: ({ employeeId, breakfast, dinner }: { employeeId: string; breakfast: boolean; dinner: boolean }) =>
      api(`/api/canteen/eligibility/${employeeId}`, { method: "PUT", body: { breakfast, dinner } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["canteen", "eligibility"] }),
    onError: fail,
  });

  const counts = useMemo(() => {
    let b = 0, d = 0;
    for (const e of eligQ.data ?? []) { if (e.breakfast) b++; if (e.dinner) d++; }
    return { b, d };
  }, [eligQ.data]);

  return (
    <div>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="ml-auto text-[12px] tabular-nums text-gray-500">
          Lunch is everyone's; breakfast ×{counts.b}, dinner ×{counts.d}
        </span>
      </div>
      <div className="table-surface">
        {empQ.isLoading || eligQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head"><tr><Th>Employee</Th><Th>Department</Th><Th>Breakfast</Th><Th>Dinner</Th></tr></thead>
            <tbody>
              {paged.page.map((e) => {
                const el = byId.get(e.id);
                return (
                  <tr key={e.id} className="table-row">
                    <Td><span className="font-medium">{e.name}</span> <span className="text-[11px] text-gray-400">{e.empCode}</span></Td>
                    <Td>{e.department ?? "—"}</Td>
                    <Td>
                      <input
                        type="checkbox"
                        checked={el?.breakfast ?? false}
                        onChange={(ev) => saveM.mutate({ employeeId: e.id, breakfast: ev.target.checked, dinner: el?.dinner ?? false })}
                      />
                      {/* Granted by the system for a night shift, and taken back by it; not HR's to tick. */}
                      {el?.breakfastAuto && <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">night shift</span>}
                    </Td>
                    <Td>
                      <input
                        type="checkbox"
                        checked={el?.dinner ?? false}
                        onChange={(ev) => saveM.mutate({ employeeId: e.id, breakfast: el?.breakfast ?? false, dinner: ev.target.checked })}
                      />
                    </Td>
                  </tr>
                );
              })}
              {!paged.page.length && <tr><Td colSpan={4}><Empty>No employees.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>
    </div>
  );
}
