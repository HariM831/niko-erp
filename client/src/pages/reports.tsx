import { createContext, Fragment, useContext, useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../api";

/**
 * Reports, laid out the way Zoho Books lays them out.
 *
 * The chrome is measured from the live product rather than approximated: report
 * amounts carry no currency symbol, ordinary account rows have no divider (only
 * "Total for" rows do), the header band is #f9f9fb on #615d82, and the report
 * itself is an 850px column centred on a full-width white card.
 */

interface ReportDef {
  key: string;
  label: string;
  category: string;
  /** Period reports take from/to; position reports take a single as-of date. */
  period: "range" | "asOf";
}

/**
 * Reports read off the general ledger, which are the ones that state a basis.
 * Zoho shows "Basis : Accrual" on these and not on the document-driven reports,
 * and it is right to: basis is a question about when a posting is recognised,
 * which a list of invoices is not answering.
 */
const LEDGER_BASED = new Set([
  "pnl",
  "pnl-horizontal",
  "balance-sheet",
  "balance-sheet-horizontal",
  "cash-flow",
  "expense-by-category",
  "tag-summary",
]);

const REPORTS: ReportDef[] = [
  { key: "pnl", label: "Profit and Loss", category: "Business Overview", period: "range" },
  {
    key: "pnl-horizontal",
    label: "Horizontal Profit and Loss",
    category: "Business Overview",
    period: "range",
  },
  { key: "cash-flow", label: "Cash Flow Statement", category: "Business Overview", period: "range" },
  { key: "balance-sheet", label: "Balance Sheet", category: "Business Overview", period: "asOf" },
  {
    key: "balance-sheet-horizontal",
    label: "Horizontal Balance Sheet",
    category: "Business Overview",
    period: "asOf",
  },
  {
    key: "tag-summary",
    label: "Profit and Loss by Reporting Tag",
    category: "Business Overview",
    period: "range",
  },
  { key: "sales-by-customer", label: "Sales by Customer", category: "Sales", period: "range" },
  { key: "sales-by-item", label: "Sales by Item", category: "Sales", period: "range" },
  { key: "ar-aging", label: "AR Aging Summary", category: "Receivables", period: "asOf" },
  { key: "ap-aging", label: "AP Aging Summary", category: "Payables", period: "asOf" },
  {
    key: "purchases-by-vendor",
    label: "Purchases by Vendor",
    category: "Purchases and Expenses",
    period: "range",
  },
  {
    key: "purchase-by-item",
    label: "Purchases by Item",
    category: "Purchases and Expenses",
    period: "range",
  },
  {
    key: "expense-by-category",
    label: "Expenses by Category",
    category: "Purchases and Expenses",
    period: "range",
  },
  { key: "gst-summary", label: "GSTR-3B Summary", category: "Taxes", period: "range" },
  // Keyed on a batch and its age rather than on a date range, so it has its own
  // page and its own chrome — see report-weekly-summary.tsx.
  {
    key: "weekly-management-summary",
    label: "Weekly Management Summary",
    category: "Farms",
    period: "range",
  },
];

const CATEGORIES = [...new Set(REPORTS.map((r) => r.category))];

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

/** Zoho prints report periods as dd/MM/yyyy, not the ISO the inputs use. */
const dmy = (iso: string) => iso.split("-").reverse().join("/");
const periodLabel = (def: ReportDef, r: { from: string; to: string }) =>
  def.period === "asOf" ? `As on ${dmy(r.to)}` : `From ${dmy(r.from)} To ${dmy(r.to)}`;

/** Report amounts are bare numbers — the currency is stated once, on the page. */
const num = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Zoho's date presets, resolved against today. */
const PRESETS: Record<string, () => { from: string; to: string }> = {
  Today: () => ({ from: today(), to: today() }),
  "This Month": () => ({ from: monthStart(), to: today() }),
  "This Quarter": () => {
    const d = new Date();
    const q = Math.floor(d.getMonth() / 3) * 3;
    return { from: new Date(d.getFullYear(), q, 1).toISOString().slice(0, 10), to: today() };
  },
  "This Year": () => {
    // Indian financial year: April to March.
    const d = new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return { from: `${y}-04-01`, to: today() };
  },
  "Previous Month": () => {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const last = new Date(d.getFullYear(), d.getMonth(), 0);
    return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
  },
  "Previous Year": () => {
    const d = new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() - 1 : d.getFullYear() - 2;
    return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
  },
  Custom: () => ({ from: monthStart(), to: today() }),
};

// ---------- Reports Center ----------

const VISITED_KEY = "niko.reports.lastVisited";

function readVisited(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(VISITED_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function markVisited(key: string) {
  const all = readVisited();
  all[key] = new Date().toISOString();
  localStorage.setItem(VISITED_KEY, JSON.stringify(all));
}

const visitedLabel = (iso: string | undefined) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${dmy(d.toISOString().slice(0, 10))} ${d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

export function ReportsPage() {
  const [, navigate] = useLocation();
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const visited = readVisited();

  const visible = REPORTS.filter(
    (r) =>
      (!category || r.category === category) &&
      (!search || r.label.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex shrink-0 gap-2 overflow-x-auto border-b bg-white p-2 lg:block lg:w-60 lg:overflow-x-visible lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-0 lg:py-4">
        <h2 className="mb-3 hidden px-5 text-[15px] font-semibold text-[#212529] lg:block">Reports Center</h2>
        <button
          onClick={() => setCategory(null)}
          className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[13px] lg:block lg:w-full lg:rounded-none lg:border-0 lg:px-5 lg:py-1.5 lg:text-left ${
            category === null
              ? "border-brand-300 bg-brand-50 font-medium text-brand-700"
              : "border-gray-200 text-gray-700 hover:bg-gray-50"
          }`}
        >
          All Reports
        </button>
        <div className="mb-1 mt-4 hidden px-5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 lg:block">
          Report Category
        </div>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[13px] lg:block lg:w-full lg:rounded-none lg:border-0 lg:px-5 lg:py-1.5 lg:text-left ${
              category === c
                ? "border-brand-300 bg-brand-50 font-medium text-brand-700"
                : "border-gray-200 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {c}
          </button>
        ))}
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto bg-white px-4 py-4 sm:px-8 sm:py-6">
        <div className="page-header -mx-4 mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:-mx-8 sm:px-8">
          <h1 className="whitespace-nowrap text-[18px] font-semibold text-[#212529]">
            {category ?? "All Reports"}{" "}
            <span className="ml-1 text-[13px] font-normal text-gray-400">{visible.length}</span>
          </h1>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reports"
            className="input w-64"
          />
        </div>

        {/*
          Grouped under category headings rather than carrying a category column.
          The value repeated down a column of its own said the same word a dozen
          times and cost the report name half the width; as a heading it is said
          once and the name gets the room.
        */}
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="col-fill s-th">Report Name</th>
              <th className="col-portrait-hide s-th w-44">Created By</th>
              <th className="col-portrait-hide s-th w-44">Last Visited</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.filter((c) => visible.some((r) => r.category === c)).map((c) => (
              <Fragment key={c}>
                <tr>
                  <td
                    colSpan={3}
                    className="border-b border-gray-100 bg-gray-50/70 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
                  >
                    {c}
                  </td>
                </tr>
                {visible
                  .filter((r) => r.category === c)
                  .map((r) => (
                    <tr key={r.key} className="s-row">
                      <td className="col-fill s-td">
                        <button
                          onClick={() => {
                            markVisited(r.key);
                            navigate(`/reports/${r.key}`);
                          }}
                          className="s-link"
                        >
                          {r.label}
                        </button>
                      </td>
                      <td className="col-portrait-hide s-td text-gray-500">System Generated</td>
                      <td className="col-portrait-hide s-td text-gray-500">{visitedLabel(visited[r.key])}</td>
                    </tr>
                  ))}
              </Fragment>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={3} className="px-5 py-10 text-center text-[13px] text-gray-500">
                  No report matches “{search}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- A single report ----------

/**
 * The applied period, so a drill-through link built deep inside a statement can
 * carry the period the reader is actually looking at.
 */
const PeriodContext = createContext<{ from: string; to: string }>({ from: "", to: "" });

/** Which item report a section prefers, when items are behind the account. */
export type Drill = "sales" | "purchases" | "ledger";

/**
 * Where clicking an account name goes.
 *
 * An item report only when items are genuinely behind the account. Most
 * operating costs never touch one — electricity is an expense claim,
 * depreciation is a journal — so those open the account ledger for the same
 * period instead of an item report with nothing in it.
 */
function useDrillHref(drill: Drill) {
  const period = useContext(PeriodContext);
  return (node: { accountId: string; hasItemLines: boolean }) => {
    const p = new URLSearchParams({ from: period.from, to: period.to });
    if (drill === "ledger" || !node.hasItemLines) {
      return `/accountant/accounts/${node.accountId}?${p}`;
    }
    p.set("range", "Custom");
    p.set("accountId", node.accountId);
    return `/reports/${drill === "sales" ? "sales-by-item" : "purchase-by-item"}?${p}`;
  };
}

export function ReportViewPage({ reportKey }: { reportKey: string }) {
  const def = REPORTS.find((r) => r.key === reportKey);
  const [, navigate] = useLocation();
  const search = useSearch();
  const [collapsed, setCollapsed] = useState(false);

  // Filters live in the URL, not in state: that is what makes a drill-through
  // able to hand the period to the next report, and a report link shareable.
  const params = new URLSearchParams(search);
  const accountId = params.get("accountId") ?? undefined;
  const preset =
    params.get("range") ?? (params.get("from") || params.get("to") ? "Custom" : "This Year");
  const fallback = (PRESETS[preset] ?? PRESETS["This Year"]!)();
  const applied = {
    from: params.get("from") ?? fallback.from,
    to: params.get("to") ?? fallback.to,
  };

  const [draft, setDraft] = useState(applied);
  useEffect(() => {
    setDraft({ from: applied.from, to: applied.to });
  }, [applied.from, applied.to]);

  const { data: org } = useQuery({
    queryKey: ["org"],
    queryFn: () => api<{ name: string } | null>("/api/settings/org"),
  });

  const query = new URLSearchParams(
    def?.period === "asOf" ? { asOf: applied.to } : { from: applied.from, to: applied.to },
  );
  if (accountId) query.set("accountId", accountId);
  const { data, isLoading, error } = useQuery({
    queryKey: ["report", reportKey, applied.from, applied.to, accountId ?? ""],
    queryFn: () => api<Record<string, unknown>>(`/api/reports/${reportKey}?${query}`),
    enabled: !!def,
  });

  if (!def) {
    return (
      <div className="p-8 text-[13px] text-gray-500">
        No such report.{" "}
        <Link href="/reports" className="text-[#e06d05] hover:underline">
          Back to the Reports Center
        </Link>
        .
      </div>
    );
  }

  const apply = (next: { range?: string; from?: string; to?: string; account?: string | null }) => {
    const range = next.range ?? preset;
    const p = new URLSearchParams({ range });
    if (range === "Custom") {
      p.set("from", next.from ?? applied.from);
      p.set("to", next.to ?? applied.to);
    }
    const account = next.account === null ? undefined : (next.account ?? accountId);
    if (account) p.set("accountId", account);
    navigate(`/reports/${reportKey}?${p}`);
  };

  const hasTree = ["pnl", "balance-sheet", "pnl-horizontal", "balance-sheet-horizontal"].includes(
    reportKey,
  );
  const filteredAccount = (data?.account ?? null) as { code: string; name: string } | null;

  return (
    <div className="flex h-full flex-col bg-[#f4f4f9]">
      <header className="page-header px-4 py-2.5 sm:px-6">
        <div className="text-[12px] font-medium text-[#4c526c]">{def.category}</div>
        <div className="flex items-baseline gap-2">
          <h1 className="text-[18px] font-semibold text-[#212529]">{def.label}</h1>
          <span className="text-gray-300">•</span>
          <span className="text-[13px] text-gray-600">{periodLabel(def, applied)}</span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-t bg-white px-6 py-2.5">
        <span className="mr-1 text-[13px] text-gray-500">Filters :</span>
        <label className="flex h-8 items-center gap-2 rounded-md border px-3 text-[13px]">
          <span className="text-gray-500">Date Range :</span>
          <select
            value={preset}
            onChange={(e) => apply({ range: e.target.value })}
            className="bg-transparent outline-none"
          >
            {Object.keys(PRESETS).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        {/* niko posts on accrual only, so the basis is stated rather than
            offered as a one-option dropdown. */}
        {LEDGER_BASED.has(reportKey) && (
          <span className="flex h-8 items-center gap-2 rounded-md border bg-gray-50 px-3 text-[13px] text-gray-500">
            Report Basis : <span className="text-gray-800">Accrual</span>
          </span>
        )}

        {filteredAccount && (
          <span className="flex h-8 items-center gap-2 rounded-md border border-brand-200 bg-brand-50 px-3 text-[13px] text-gray-500">
            Account :{" "}
            <span className="text-gray-800">
              {filteredAccount.code} · {filteredAccount.name}
            </span>
            <button
              onClick={() => apply({ account: null })}
              className="text-gray-400 hover:text-red-600"
              aria-label="Clear the account filter"
            >
              ×
            </button>
          </span>
        )}

        {preset === "Custom" && (
          <>
            <input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((r) => ({ ...r, from: e.target.value }))}
              className="input h-8 w-auto py-0"
            />
            <input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((r) => ({ ...r, to: e.target.value }))}
              className="input h-8 w-auto py-0"
            />
          </>
        )}

        <button onClick={() => apply({ range: "Custom", ...draft })} className="btn-primary">
          Run Report
        </button>
        <Link href="/reports" className="ml-auto text-[13px] text-[#e06d05] hover:underline">
          All reports
        </Link>
      </div>

      <div className="flex-1 overflow-auto p-2 sm:p-4">
        <div className="min-h-full bg-white">
          {hasTree && (
            <div className="flex items-center gap-2 border-b px-6 py-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-gray-700">
                <input
                  type="checkbox"
                  checked={collapsed}
                  onChange={(e) => setCollapsed(e.target.checked)}
                />
                Collapse Sub-Accounts
              </label>
            </div>
          )}

          <div className="px-3 py-5 sm:px-6 sm:py-8">
            <div className="mb-6 text-center">
              <div className="text-[13px] text-[#222536]">{org?.name}</div>
              <h2 className="mt-1 text-[18px] font-medium text-black">{def.label}</h2>
              <div className="mt-1 text-[13px] text-gray-500">{periodLabel(def, applied)}</div>
              {LEDGER_BASED.has(reportKey) && (
                <div className="text-[13px] text-gray-500">Basis : Accrual</div>
              )}
            </div>

            {isLoading ? (
              <p className="text-center text-[13px] text-gray-500">Loading…</p>
            ) : error ? (
              <p className="text-center text-[13px] text-red-600">
                {error instanceof Error ? error.message : "Failed to run this report."}
              </p>
            ) : data ? (
              <PeriodContext.Provider value={applied}>
                <ReportBody reportKey={reportKey} data={data} collapsed={collapsed} />
              </PeriodContext.Provider>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Shared pieces ----------

interface TreeNode {
  accountId: string;
  code: string;
  name: string;
  hasItemLines: boolean;
  depth: number;
  amount: string;
  total: string;
  children: TreeNode[];
}

interface Section {
  nodes: TreeNode[];
  total: string;
}

/** 850px centred, the width Zoho gives a financial statement. */
function Sheet({ children }: { children: React.ReactNode }) {
  /*
   * Scrolls sideways rather than cutting a column off. Hiding the account
   * code buys most reports enough room, but a wide one — sales by customer
   * carries six money columns — will still exceed a phone, and a figure you
   * cannot reach is worse than one you have to swipe to.
   */
  return (
    <div className="mx-auto max-w-[850px] overflow-x-auto">{children}</div>
  );
}

const HEAD_CELL = "bg-[#f9f9fb] px-2 py-2 text-[11px] font-semibold uppercase text-[#615d82]";

const Amount = ({ value, className = "" }: { value: string; className?: string }) => (
  <td className={`w-40 px-2 py-2 text-right tabular-nums ${className}`}>{num(value)}</td>
);

/** A "Total for X" / "Gross Profit" line: bold, with the only divider Zoho draws. */
const TotalRow = ({
  label,
  value,
  indent = 0,
}: {
  label: string;
  value: string;
  indent?: number;
}) => (
  <tr className="border-b-[0.7px] border-[#eee] font-bold">
    <td className="px-2 py-2 first:pl-5" style={{ paddingLeft: `${20 + indent}px` }}>
      {label}
    </td>
    {/*
      The account-code placeholder, and it must hide with that column.
      Left visible, this row alone kept three columns while every other row had
      dropped to two, so the total's own figure was pushed past the edge and
      "Total for Cost of Goods Sold" read 27,. The totals are the one part of a
      P&L you cannot afford to lose.
    */}
    <td className="col-portrait-hide" />
    <Amount value={value} />
  </tr>
);

/** One account and its children, indented, with a "Total for X" beneath any parent. */
function TreeRows({
  nodes,
  collapsed,
  drill,
  showCode = true,
}: {
  nodes: TreeNode[];
  collapsed: boolean;
  drill: Drill;
  /** The T-format drops account codes, as Zoho's horizontal statements do. */
  showCode?: boolean;
}) {
  const href = useDrillHref(drill);
  return (
    <>
      {nodes.map((n) => {
        const showChildren = !collapsed && n.children.length > 0;
        return (
          <Fragment key={n.accountId}>
            <tr>
              <td className="px-2 py-2" style={{ paddingLeft: `${20 + n.depth * 20}px` }}>
                <Link href={href(n)} className="font-medium text-[#e06d05] hover:underline">
                  {n.name}
                </Link>
              </td>
              <td className="col-portrait-hide w-28 px-2 py-2 text-gray-500">{showCode ? n.code : ""}</td>
              <Amount value={showChildren ? n.amount : n.total} />
            </tr>
            {showChildren && (
              <>
                <TreeRows
                  nodes={n.children}
                  collapsed={collapsed}
                  drill={drill}
                  showCode={showCode}
                />
                <TotalRow label={`Total for ${n.name}`} value={n.total} indent={n.depth * 20} />
              </>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * A statement section. Zoho keeps the heading and its total even when nothing
 * posted to it, so a reader can tell "nil" from "not reported".
 */
function SectionBlock({
  label,
  section,
  collapsed,
  drill,
}: {
  label: string;
  section: Section;
  collapsed: boolean;
  drill: Drill;
}) {
  return (
    <>
      <tr>
        <td className="px-2 pb-1 pt-4 pl-5 font-bold text-black">{label}</td>
        <td className="col-portrait-hide" />
        <td />
      </tr>
      <TreeRows nodes={section.nodes} collapsed={collapsed} drill={drill} />
      <TotalRow label={`Total for ${label}`} value={section.total} />
    </>
  );
}

/** Gross Profit, Operating Profit, Net Profit — same weight as a section total. */
const KeyLine = ({ label, value }: { label: string; value: string }) => (
  <tr className="border-b-[0.7px] border-[#eee] font-bold">
    <td className="px-2 py-2.5 pl-5">{label}</td>
    <td className="col-portrait-hide" />
    <Amount value={value} />
  </tr>
);

function StatementTable({ children }: { children: React.ReactNode }) {
  return (
    <Sheet>
      <table className="w-full text-[14px]">
        <thead>
          <tr>
            <th className={`${HEAD_CELL} pl-5 text-left`}>Account</th>
            <th className={`col-portrait-hide ${HEAD_CELL} w-28 text-left`}>Account Code</th>
            <th className={`${HEAD_CELL} w-40 text-right`}>Total</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </Sheet>
  );
}

// ---------- Report bodies ----------

function ReportBody({
  reportKey,
  data,
  collapsed,
}: {
  reportKey: string;
  data: Record<string, unknown>;
  collapsed: boolean;
}) {
  switch (reportKey) {
    case "pnl":
      return (
        <StatementTable>
          <SectionBlock
            label="Operating Income"
            section={data.operatingIncome as Section}
            collapsed={collapsed}
            drill="sales"
          />
          <SectionBlock
            label="Cost of Goods Sold"
            section={data.costOfGoodsSold as Section}
            collapsed={collapsed}
            drill="purchases"
          />
          <KeyLine label="Gross Profit" value={data.grossProfit as string} />
          <SectionBlock
            label="Operating Expense"
            section={data.operatingExpense as Section}
            collapsed={collapsed}
            drill="purchases"
          />
          <KeyLine label="Operating Profit" value={data.operatingProfit as string} />
          <SectionBlock
            label="Non Operating Income"
            section={data.otherIncome as Section}
            collapsed={collapsed}
            drill="sales"
          />
          <SectionBlock
            label="Non Operating Expense"
            section={data.otherExpense as Section}
            collapsed={collapsed}
            drill="purchases"
          />
          <KeyLine label="Net Profit/Loss" value={data.netProfit as string} />
        </StatementTable>
      );

    case "balance-sheet":
      return (
        <>
          <StatementTable>
            {/* Balance-sheet accounts are not item-driven, so their names go to
                the account ledger rather than an item report. */}
            <SectionBlock
              label="Assets"
              section={data.assets as Section}
              collapsed={collapsed}
              drill="ledger"
            />
            <KeyLine label="Total Assets" value={data.totalAssets as string} />
            <SectionBlock
              label="Liabilities"
              section={data.liabilities as Section}
              collapsed={collapsed}
              drill="ledger"
            />
            <SectionBlock
              label="Equity"
              section={data.equity as Section}
              collapsed={collapsed}
              drill="ledger"
            />
            <tr>
              <td className="px-2 py-2 pl-5">Current Year Earnings</td>
              <td className="col-portrait-hide" />
              <Amount value={data.netEarnings as string} />
            </tr>
            <KeyLine
              label="Total Liabilities & Equity"
              value={(
                Number(data.totalLiabilities as string) + Number(data.totalEquity as string)
              ).toFixed(2)}
            />
          </StatementTable>
          {!(data.balanced as boolean) && (
            <Sheet>
              <p className="pt-4 text-[13px] font-medium text-red-600">
                Assets do not equal liabilities plus equity. Something posted one-sided — check the
                journal before relying on this sheet.
              </p>
            </Sheet>
          )}
        </>
      );

    case "pnl-horizontal":
    case "balance-sheet-horizontal":
      return <HorizontalStatement reportKey={reportKey} data={data} collapsed={collapsed} />;

    case "sales-by-item":
    case "purchase-by-item":
      return <ItemTable data={data} />;

    case "sales-by-customer":
      return <SalesByCustomer data={data} />;

    case "purchases-by-vendor":
      return <PurchasesByVendor data={data} />;

    case "expense-by-category":
      return <ExpenseByCategory data={data} />;

    case "ar-aging":
    case "ap-aging":
      return <AgingSummary reportKey={reportKey} data={data} />;

    default:
      return <LegacyBody reportKey={reportKey} data={data} />;
  }
}

interface SideData {
  heading: string;
  sections: Array<Section & { label: string }>;
  earnings?: { label: string; amount: string } | null;
  balancing?: { label: string; amount: string } | null;
  total: string;
}

/**
 * The T-format: two columns that add to the same figure, with the balancing
 * profit or loss on the short side. Section headings and their totals are
 * uppercase here, as Zoho renders them.
 */
function HorizontalStatement({
  reportKey,
  data,
  collapsed,
}: {
  reportKey: string;
  data: Record<string, unknown>;
  collapsed: boolean;
}) {
  const isPnl = reportKey === "pnl-horizontal";
  const left: SideData = isPnl
    ? { heading: "Expense", ...(data.expense as Omit<SideData, "heading">) }
    : (data.left as SideData);
  const right: SideData = isPnl
    ? { heading: "Income", ...(data.income as Omit<SideData, "heading">) }
    : (data.right as SideData);

  const Side = ({ side, drill }: { side: SideData; drill: Drill }) => (
    <table className="w-full text-[14px]">
      <thead>
        <tr>
          <th className={`${HEAD_CELL} pl-5 text-left`}>{side.heading}</th>
          <th className={`col-portrait-hide ${HEAD_CELL} w-24 text-left`} />
          <th className={`${HEAD_CELL} w-36 text-right`} />
        </tr>
      </thead>
      <tbody>
        {side.sections.map((s) => (
          <Fragment key={s.label}>
            <tr>
              <td className="px-2 pb-1 pl-5 pt-4 text-[12px] font-bold uppercase tracking-wide text-black">
                {s.label}
              </td>
              <td className="col-portrait-hide" />
              <td />
            </tr>
            <TreeRows nodes={s.nodes} collapsed={collapsed} drill={drill} showCode={false} />
            <TotalRow label={`Total ${s.label}`.toUpperCase()} value={s.total} />
          </Fragment>
        ))}
        {side.earnings && (
          <tr>
            <td className="px-2 py-2 pl-5">{side.earnings.label}</td>
            <td className="col-portrait-hide" />
            <Amount value={side.earnings.amount} />
          </tr>
        )}
        {side.balancing && (
          <TotalRow label={side.balancing.label.toUpperCase()} value={side.balancing.amount} />
        )}
        <tr className="border-t-[0.7px] border-[#eee] font-bold">
          <td className="px-2 py-2.5 pl-5">Total</td>
          <td className="col-portrait-hide" />
          <Amount value={side.total} />
        </tr>
      </tbody>
    </table>
  );

  // items-start stops the shorter side's rows being stretched to match the
  // taller one — a grid item that is a <table> fills its track otherwise.
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <div className="border-b pb-6 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-6">
        <Side side={left} drill={isPnl ? "purchases" : "ledger"} />
      </div>
      <div>
        <Side side={right} drill={isPnl ? "sales" : "ledger"} />
      </div>
    </div>
  );
}

function ItemTable({ data }: { data: Record<string, unknown> }) {
  const rows = data.rows as Array<{
    itemId: string;
    name: string;
    unit: string;
    quantity: string;
    amount: string;
    averagePrice: string;
  }>;
  const account = (data.account ?? null) as { id: string; code: string; name: string } | null;

  if (!rows.length) {
    // Arriving here from a statement line that showed a figure is not a
    // contradiction: an amount booked without an item — a journal, an expense,
    // a bill line posted straight to the account — is in the ledger but has no
    // item to report. Say so, and offer the ledger, rather than showing a blank.
    return (
      <p className="text-center text-[13px] text-gray-500">
        {account ? (
          <>
            Nothing with an item posted to {account.code} · {account.name} in this period.
            <br />
            Amounts booked without an item still reach the ledger —{" "}
            <Link
              href={`/accountant/accounts/${account.id}`}
              className="text-[#e06d05] hover:underline"
            >
              open the account ledger
            </Link>{" "}
            to see them.
          </>
        ) : (
          "Nothing in this period."
        )}
      </p>
    );
  }
  return (
    <Sheet>
      <table className="w-full text-[14px]">
        <thead>
          <tr>
            <th className={`${HEAD_CELL} pl-5 text-left`}>Item Name</th>
            <th className={`${HEAD_CELL} w-32 text-right`}>Quantity</th>
            <th className={`${HEAD_CELL} w-36 text-right`}>Amount</th>
            <th className={`${HEAD_CELL} w-36 text-right`}>Average Price</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemId}>
              <td className="px-2 py-2 pl-5">
                <Link
                  href={`/items/${r.itemId}`}
                  className="font-medium text-[#e06d05] hover:underline"
                >
                  {r.name}
                </Link>
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {Number(r.quantity).toLocaleString("en-IN")} {r.unit}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{num(r.amount)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{num(r.averagePrice)}</td>
            </tr>
          ))}
          <tr className="border-t-[0.7px] border-[#eee] font-bold">
            <td className="px-2 py-2.5 pl-5">Total</td>
            <td className="px-2 py-2.5 text-right tabular-nums">
              {Number(data.totalQuantity as string).toLocaleString("en-IN")}
            </td>
            <td className="px-2 py-2.5 text-right tabular-nums">{num(data.totalAmount as string)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </Sheet>
  );
}

/**
 * Two money columns, as Zoho has them: the taxable value the P&L sees, and what
 * the customer was actually billed once tax and round-off are on.
 */
function SalesByCustomer({ data }: { data: Record<string, unknown> }) {
  const rows = data.rows as Array<{
    contactId: string;
    name: string;
    invoiceCount: number;
    sales: string;
    salesWithTax: string;
  }>;
  if (!rows.length) {
    return <p className="text-center text-[13px] text-gray-500">No sales in this period.</p>;
  }
  return (
    <Sheet>
      <table className="w-full text-[14px]">
        <thead>
          <tr>
            <th className={`${HEAD_CELL} pl-5 text-left`}>Name</th>
            <th className={`${HEAD_CELL} w-32 text-right`}>Invoice Count</th>
            <th className={`${HEAD_CELL} w-40 text-right`}>Sales</th>
            <th className={`${HEAD_CELL} w-40 text-right`}>Sales with Tax</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.contactId}>
              <td className="px-2 py-2 pl-5">
                <Link
                  href={`/sales/customers/${r.contactId}`}
                  className="font-medium text-[#e06d05] hover:underline"
                >
                  {r.name}
                </Link>
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{r.invoiceCount}</td>
              <td className="px-2 py-2 text-right tabular-nums">{num(r.sales)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{num(r.salesWithTax)}</td>
            </tr>
          ))}
          <tr className="border-t-[0.7px] border-[#eee] font-bold">
            <td className="px-2 py-2.5 pl-5">Total</td>
            <td className="px-2 py-2.5 text-right tabular-nums">{data.totalCount as number}</td>
            <td className="px-2 py-2.5 text-right tabular-nums">{num(data.totalSales as string)}</td>
            <td className="px-2 py-2.5 text-right tabular-nums">
              {num(data.totalSalesWithTax as string)}
            </td>
          </tr>
        </tbody>
      </table>
    </Sheet>
  );
}

/**
 * Bills, vendor credits and expense claims per vendor. Most of what niko
 * spends is claimed rather than billed, so a bills-only version of this report
 * would be missing the larger half of it.
 */
function PurchasesByVendor({ data }: { data: Record<string, unknown> }) {
  const rows = data.rows as Array<{
    contactId: string | null;
    name: string;
    expenseCount: number;
    billCount: number;
    vendorCreditCount: number;
    amount: string;
    amountWithTax: string;
  }>;
  if (!rows.length) {
    return <p className="text-center text-[13px] text-gray-500">No purchases in this period.</p>;
  }
  return (
    <Sheet>
      <table className="w-full text-[14px]">
        <thead>
          <tr>
            <th className={`${HEAD_CELL} pl-5 text-left`}>Vendor Name</th>
            <th className={`${HEAD_CELL} w-28 text-right`}>Expense Count</th>
            <th className={`${HEAD_CELL} w-24 text-right`}>Bill Count</th>
            <th className={`${HEAD_CELL} w-28 text-right`}>Vendor Credit Count</th>
            <th className={`${HEAD_CELL} w-36 text-right`}>Amount</th>
            <th className={`${HEAD_CELL} w-36 text-right`}>Amount with Tax</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.contactId ?? "others"}>
              <td className="px-2 py-2 pl-5">
                {r.contactId ? (
                  <Link
                    href={`/purchases/vendors/${r.contactId}`}
                    className="font-medium text-[#e06d05] hover:underline"
                  >
                    {r.name}
                  </Link>
                ) : (
                  // Claims with no vendor named. Counted rather than dropped, so
                  // the total still ties to what left the bank.
                  <span title="Expenses recorded without a vendor">Others</span>
                )}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{r.expenseCount}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.billCount}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.vendorCreditCount}</td>
              <td className="px-2 py-2 text-right tabular-nums">{num(r.amount)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{num(r.amountWithTax)}</td>
            </tr>
          ))}
          <tr className="border-t-[0.7px] border-[#eee] font-bold">
            <td className="px-2 py-2.5 pl-5">Total</td>
            <td className="px-2 py-2.5 text-right tabular-nums">
              {data.totalExpenseCount as number}
            </td>
            <td className="px-2 py-2.5 text-right tabular-nums">{data.totalBillCount as number}</td>
            <td className="px-2 py-2.5 text-right tabular-nums">
              {data.totalVendorCreditCount as number}
            </td>
            <td className="px-2 py-2.5 text-right tabular-nums">{num(data.totalAmount as string)}</td>
            <td className="px-2 py-2.5 text-right tabular-nums">
              {num(data.totalAmountWithTax as string)}
            </td>
          </tr>
        </tbody>
      </table>
    </Sheet>
  );
}

/**
 * Categories collapsed, expanding to their sub-accounts on click — the bit
 * Zoho's own Expenses by Category lacks.
 */
function ExpenseByCategory({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const href = useDrillHref("purchases");
  const categories = data.categories as Array<{
    accountId: string;
    code: string;
    name: string;
    total: string;
    percentOfTotal: string | null;
    children: Array<{
      accountId: string;
      code: string;
      name: string;
      total: string;
      hasItemLines: boolean;
    }>;
  }>;
  if (!categories.length) {
    return <p className="text-center text-[13px] text-gray-500">No expenses in this period.</p>;
  }

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Sheet>
      <table className="w-full text-[14px]">
        <thead>
          <tr>
            <th className={`${HEAD_CELL} pl-5 text-left`}>Category</th>
            <th className={`${HEAD_CELL} w-32 text-right`}>% of Total</th>
            <th className={`${HEAD_CELL} w-40 text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <Fragment key={c.accountId}>
              <tr className="hover:bg-[#fafafc]">
                <td className="px-2 py-2 pl-5">
                  <button
                    onClick={() => toggle(c.accountId)}
                    disabled={!c.children.length}
                    className="flex items-center gap-1.5 disabled:cursor-default"
                  >
                    {c.children.length > 0 ? (
                      open.has(c.accountId) ? (
                        <ChevronDown size={14} className="text-gray-400" />
                      ) : (
                        <ChevronRight size={14} className="text-gray-400" />
                      )
                    ) : (
                      <span className="w-3.5" />
                    )}
                    <span className="font-medium">{c.name}</span>
                    {c.children.length > 0 && (
                      <span className="text-[11px] text-gray-400">
                        {c.children.length} sub-account{c.children.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </button>
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-gray-500">
                  {c.percentOfTotal === null ? "—" : `${c.percentOfTotal}%`}
                </td>
                <td className="px-2 py-2 text-right font-medium tabular-nums">{num(c.total)}</td>
              </tr>
              {open.has(c.accountId) &&
                c.children.map((ch) => (
                  <tr key={ch.accountId} className="bg-[#fafafc]">
                    <td className="px-2 py-2 pl-11">
                      <Link href={href(ch)} className="font-medium text-[#e06d05] hover:underline">
                        {ch.name}
                      </Link>
                      <span className="ml-2 text-[11px] text-gray-400">{ch.code}</span>
                    </td>
                    <td />
                    <td className="px-2 py-2 text-right tabular-nums">{num(ch.total)}</td>
                  </tr>
                ))}
            </Fragment>
          ))}
          <tr className="border-t-[0.7px] border-[#eee] font-bold">
            <td className="px-2 py-2.5 pl-5">Total</td>
            <td />
            <td className="px-2 py-2.5 text-right tabular-nums">{num(data.total as string)}</td>
          </tr>
        </tbody>
      </table>
      {categories.some((c) => c.percentOfTotal === null) && (
        <p className="mt-4 text-[12px] text-gray-500">
          A share is only shown when the period's total expense is positive — a credit balance would
          otherwise print a percentage that reads as nonsense.
        </p>
      )}
    </Sheet>
  );
}

const BUCKETS = ["current", "1-15", "16-30", "31-45", "45+"] as const;
const BUCKET_LABEL: Record<string, string> = {
  current: "Current",
  "1-15": "1 – 15 Days",
  "16-30": "16 – 30 Days",
  "31-45": "31 – 45 Days",
  "45+": "Above 45 Days",
};

/**
 * Ageing the way Zoho shows it: one row per contact, one column per bucket.
 * The server hands back the open documents, so grouping happens here rather
 * than being a second query.
 */
function AgingSummary({ reportKey, data }: { reportKey: string; data: Record<string, unknown> }) {
  const isAr = reportKey === "ar-aging";
  const docs = (isAr ? data.invoices : data.bills) as Array<{
    customerId?: string;
    customerName?: string;
    vendorId?: string;
    vendorName?: string;
    balanceDue: string;
    bucket: string;
  }>;
  if (!docs?.length) {
    return <p className="text-center text-[13px] text-gray-500">Nothing outstanding on this date.</p>;
  }

  const byContact = new Map<
    string,
    { name: string; buckets: Record<string, number>; total: number }
  >();
  for (const d of docs) {
    const id = (isAr ? d.customerId : d.vendorId)!;
    const name = (isAr ? d.customerName : d.vendorName) ?? "—";
    const row = byContact.get(id) ?? { name, buckets: {}, total: 0 };
    row.buckets[d.bucket] = (row.buckets[d.bucket] ?? 0) + Number(d.balanceDue);
    row.total += Number(d.balanceDue);
    byContact.set(id, row);
  }
  const rows = [...byContact.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  const totals = data.totals as Record<string, string>;

  return (
    <Sheet>
      <table className="w-full text-[14px]">
        <thead>
          <tr>
            <th className={`${HEAD_CELL} pl-5 text-left`}>
              {isAr ? "Customer Name" : "Vendor Name"}
            </th>
            {BUCKETS.map((b) => (
              <th key={b} className={`${HEAD_CELL} text-right`}>
                {BUCKET_LABEL[b]}
              </th>
            ))}
            <th className={`${HEAD_CELL} text-right`}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, r]) => (
            <tr key={id}>
              <td className="px-2 py-2 pl-5">
                <Link
                  href={isAr ? `/sales/customers/${id}` : `/purchases/vendors/${id}`}
                  className="font-medium text-[#e06d05] hover:underline"
                >
                  {r.name}
                </Link>
              </td>
              {BUCKETS.map((b) => (
                <td key={b} className="px-2 py-2 text-right tabular-nums">
                  {r.buckets[b] ? num(r.buckets[b]!) : "-"}
                </td>
              ))}
              <td className="px-2 py-2 text-right font-medium tabular-nums">{num(r.total)}</td>
            </tr>
          ))}
          <tr className="border-t-[0.7px] border-[#eee] font-bold">
            <td className="px-2 py-2.5 pl-5">Total</td>
            {BUCKETS.map((b) => (
              <td key={b} className="px-2 py-2.5 text-right tabular-nums">
                {num(totals[b] ?? "0")}
              </td>
            ))}
            <td className="px-2 py-2.5 text-right tabular-nums">{num(data.grandTotal as string)}</td>
          </tr>
        </tbody>
      </table>
    </Sheet>
  );
}

/** Reports that are plain tables: cash flow, tag summary, GST. */
function LegacyBody({ reportKey, data }: { reportKey: string; data: Record<string, unknown> }) {
  type Rows = Array<{ code: string; name: string; amount: string }>;

  switch (reportKey) {
    case "cash-flow": {
      const block = (title: string, rows: Rows, total: string) => (
        <>
          <tr>
            <td className="px-2 pb-1 pl-5 pt-4 font-bold text-black">{title}</td>
            <td />
          </tr>
          {rows.map((r) => (
            <tr key={r.code + r.name}>
              <td className="px-2 py-2 pl-5">{r.name}</td>
              <td className="w-40 px-2 py-2 text-right tabular-nums">{num(r.amount)}</td>
            </tr>
          ))}
          <tr className="border-b-[0.7px] border-[#eee] font-bold">
            <td className="px-2 py-2 pl-5">Total {title}</td>
            <td className="px-2 py-2 text-right tabular-nums">{num(total)}</td>
          </tr>
        </>
      );
      return (
        <Sheet>
          <table className="w-full text-[14px]">
            <thead>
              <tr>
                <th className={`${HEAD_CELL} pl-5 text-left`}>Account</th>
                <th className={`${HEAD_CELL} w-40 text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b-[0.7px] border-[#eee] font-bold">
                <td className="px-2 py-2 pl-5">Opening Cash</td>
                <td className="px-2 py-2 text-right tabular-nums">{num(data.opening as string)}</td>
              </tr>
              {block("Inflows", data.inflows as Rows, data.totalInflows as string)}
              {block("Outflows", data.outflows as Rows, data.totalOutflows as string)}
              <tr className="border-b-[0.7px] border-[#eee] font-bold">
                <td className="px-2 py-2.5 pl-5">Closing Cash</td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {num(data.closing as string)}
                </td>
              </tr>
            </tbody>
          </table>
        </Sheet>
      );
    }

    case "tag-summary": {
      const rows = data.rows as Array<{
        tagName: string;
        optionName: string;
        income: string;
        expense: string;
        net: string;
        lineCount: number;
      }>;
      if (!rows.length) {
        return (
          <p className="text-center text-[13px] text-gray-500">
            Nothing tagged in this period. Tag a journal line, an expense or a bill line and it will
            appear here.
          </p>
        );
      }
      return (
        <Sheet>
          <table className="w-full text-[14px]">
            <thead>
              <tr>
                <th className={`${HEAD_CELL} pl-5 text-left`}>Tag Option</th>
                <th className={`${HEAD_CELL} w-36 text-right`}>Income</th>
                <th className={`${HEAD_CELL} w-36 text-right`}>Expense</th>
                <th className={`${HEAD_CELL} w-36 text-right`}>Net</th>
              </tr>
            </thead>
            <tbody>
              {[...new Set(rows.map((r) => r.tagName))].map((g) => {
                const groupRows = rows.filter((r) => r.tagName === g);
                const totalNet = groupRows.reduce((s, r) => s + Number(r.net), 0);
                return (
                  <Fragment key={g}>
                    <tr>
                      <td className="px-2 pb-1 pl-5 pt-4 font-bold text-black">{g}</td>
                      <td />
                      <td />
                      <td />
                    </tr>
                    {groupRows.map((r) => (
                      <tr key={r.optionName}>
                        <td className="px-2 py-2 pl-10">
                          {r.optionName}
                          <span className="ml-2 text-[11px] text-gray-400">
                            {r.lineCount} line{r.lineCount === 1 ? "" : "s"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{num(r.income)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{num(r.expense)}</td>
                        <td
                          className={`px-2 py-2 text-right font-medium tabular-nums ${
                            Number(r.net) < 0 ? "text-red-700" : ""
                          }`}
                        >
                          {num(r.net)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b-[0.7px] border-[#eee] font-bold">
                      <td className="px-2 py-2 pl-5">Total for {g}</td>
                      <td />
                      <td />
                      <td className="px-2 py-2 text-right tabular-nums">{num(totalNet)}</td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <p className="mt-4 text-[12px] text-gray-500">
            Only tagged amounts appear here. A cost with no tag is still in the P&amp;L but belongs
            to no option, so these totals are not expected to reconcile to it.
          </p>
        </Sheet>
      );
    }

    case "gst-summary": {
      const out = data.outwardSupplies as Record<string, string>;
      const inp = data.inputTaxCredit as Record<string, string>;
      const keys = ["taxableValue", "cgst", "sgst", "igst"];
      const row = (label: string, v: Record<string, string>) => (
        <tr>
          <td className="px-2 py-2 pl-5">{label}</td>
          {keys.map((k) => (
            <td key={k} className="px-2 py-2 text-right tabular-nums">
              {num(v[k] ?? "0")}
            </td>
          ))}
        </tr>
      );
      return (
        <Sheet>
          <table className="w-full text-[14px]">
            <thead>
              <tr>
                <th className={`${HEAD_CELL} pl-5 text-left`}>Section</th>
                <th className={`${HEAD_CELL} text-right`}>Taxable Value</th>
                <th className={`${HEAD_CELL} text-right`}>CGST</th>
                <th className={`${HEAD_CELL} text-right`}>SGST</th>
                <th className={`${HEAD_CELL} text-right`}>IGST</th>
              </tr>
            </thead>
            <tbody>
              {row("Outward supplies", out)}
              {row("Input tax credit", inp)}
              <tr className="border-t-[0.7px] border-[#eee] font-bold">
                <td className="px-2 py-2.5 pl-5">Net GST Payable</td>
                <td />
                <td />
                <td />
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {num(data.netPayable as string)}
                </td>
              </tr>
            </tbody>
          </table>
        </Sheet>
      );
    }

    default:
      return <p className="text-center text-[13px] text-gray-500">This report has no renderer yet.</p>;
  }
}
