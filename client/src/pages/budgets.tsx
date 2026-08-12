import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";

interface Budget {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  period: string;
  includeBalanceSheet: boolean;
}
interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  parentId: string | null;
  isGroup: boolean;
  isActive: boolean;
}

const PERIOD_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-yearly",
  yearly: "Yearly",
};
const PERIOD_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

const monthYear = (d: Date) =>
  `${d.toLocaleDateString("en-IN", { month: "short" })} ${d.getFullYear()}`;

/** "2026-04-01" monthly → "Apr 2026"; wider slices name both ends, e.g. "Apr 2026 - Jun 2026". */
function periodLabel(start: string, period: string) {
  const from = new Date(`${start}T00:00:00`);
  const months = PERIOD_MONTHS[period] ?? 1;
  if (months === 1) return monthYear(from);
  const to = new Date(from);
  to.setMonth(to.getMonth() + months - 1);
  return `${monthYear(from)} - ${monthYear(to)}`;
}

// ============================ List ============================

export function BudgetsPage() {
  const [, navigate] = useLocation();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["budgets"],
    queryFn: () => api<Budget[]>("/api/budgets"),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between bg-white px-5 py-3">
        <h1 className="text-lg font-semibold">Budgets</h1>
        <button onClick={() => navigate("/accountant/budgets/new")} className="btn-primary">
          + New
        </button>
      </header>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : !rows?.length ? (
          <div className="mx-auto mt-20 max-w-xl px-6 text-center">
            <h2 className="text-xl font-medium text-gray-800">
              Budget your business finance. Stay on top of your expenses.
            </h2>
            <p className="mt-3 text-[13px] text-gray-500">
              Create budgets for the various activities of your business, compare them with the
              actuals, and see how your business is performing.
            </p>
            <button onClick={() => navigate("/accountant/budgets/new")} className="btn-primary mt-6 uppercase">
              Create Budget
            </button>
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="table-head sticky top-0 z-10">
              <tr>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">Name</th>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">Period</th>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">From</th>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">To</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => navigate(`/accountant/budgets/${b.id}`)}
                  className="cursor-pointer bg-white transition-colors hover:bg-gray-50"
                >
                  <td className="border-b border-[#ebeaf2] px-4 py-2.5 font-medium text-brand-600">{b.name}</td>
                  <td className="border-b border-[#ebeaf2] px-4 py-2.5 text-gray-700">
                    {PERIOD_LABEL[b.period] ?? b.period}
                  </td>
                  <td className="border-b border-[#ebeaf2] px-4 py-2.5">{formatDate(b.startDate)}</td>
                  <td className="border-b border-[#ebeaf2] px-4 py-2.5">{formatDate(b.endDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================ Create ============================

/**
 * The five fiscal years Zoho offers: two back, the current one, two forward.
 * `fyStart` is the org's "MM-DD" fiscal year start, so an April start yields
 * "Apr 2026 - Mar 2027".
 */
function fiscalYearOptions(fyStart: string) {
  const [fyMonth = 4, fyDay = 1] = fyStart.split("-").map(Number);
  const now = new Date();
  // Before the fiscal start month, we're still inside the year that began last calendar year.
  const base = now.getMonth() + 1 >= fyMonth ? now.getFullYear() : now.getFullYear() - 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return [-2, -1, 0, 1, 2].map((offset) => {
    const y = base + offset;
    const start = new Date(y, fyMonth - 1, fyDay);
    const end = new Date(y + 1, fyMonth - 1, fyDay);
    end.setDate(end.getDate() - 1);
    return {
      value: `${y}`,
      label: `${monthYear(start)} - ${monthYear(end)}`,
      startDate: `${y}-${pad(fyMonth)}-${pad(fyDay)}`,
      endDate: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
      isCurrent: offset === 0,
    };
  });
}

/** Left-label / right-field row, matching Zoho's form rhythm. */
function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-4">
      <label className={`w-40 shrink-0 pt-1.5 text-[13px] ${required ? "text-[#e02b2b]" : "text-gray-600"}`}>
        {label}
        {required && <span className="ml-0.5">*</span>}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const ACCOUNT_SECTIONS: Array<{ type: string; label: string }> = [
  { type: "income", label: "Income Accounts" },
  { type: "expense", label: "Expense Accounts" },
  { type: "asset", label: "Asset Accounts" },
  { type: "liability", label: "Liability Accounts" },
  { type: "equity", label: "Equity Accounts" },
];

export function BudgetNewPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [includeBalanceSheet, setIncludeBalanceSheet] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const { data: org } = useQuery({
    queryKey: ["org-profile"],
    queryFn: () => api<{ fiscalYearStart?: string }>("/api/settings/org"),
  });

  const fyOptions = useMemo(() => fiscalYearOptions(org?.fiscalYearStart ?? "04-01"), [org]);
  const [fyValue, setFyValue] = useState<string | null>(null);
  const fy = fyOptions.find((o) => o.value === fyValue) ?? fyOptions.find((o) => o.isCurrent)!;

  const byId = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);
  const pickedInType = (type: string) =>
    [...picked].map((id) => byId.get(id)).filter((a): a is Account => !!a && a.type === type);

  /** Replace just this type's selection; other types keep theirs. */
  const applySelection = (type: string, ids: Set<string>) =>
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => byId.get(id)?.type !== type));
      for (const id of ids) next.add(id);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = (await api("/api/budgets", {
        method: "POST",
        body: {
          name,
          startDate: fy.startDate,
          endDate: fy.endDate,
          period,
          includeBalanceSheet,
          accountIds: [...picked],
        },
      })) as { id: string };
      await qc.invalidateQueries({ queryKey: ["budgets"] });
      navigate(`/accountant/budgets/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create budget");
    } finally {
      setBusy(false);
    }
  };

  const accountRow = (type: string, label: string) => {
    const chosen = pickedInType(type);
    return (
      <Field key={type} label={label}>
        <div className="border-b border-[#e3e3ec] pb-1.5">
          {chosen.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {chosen.map((a) => (
                <span key={a.id} className="rounded bg-[#eef0f5] px-2 py-0.5 text-[12px] text-gray-700">
                  {a.name}
                </span>
              ))}
            </div>
          )}
          <button
            onClick={() => setConfiguring(type)}
            className="text-[13px] font-medium text-brand-600 hover:underline"
          >
            {chosen.length > 0 ? "Add or Remove Accounts" : "Add Accounts"}
          </button>
        </div>
      </Field>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-medium">New Budget</h1>
        <button onClick={() => navigate("/accountant/budgets")} className="text-xl text-gray-400 hover:text-gray-700">
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-2xl">
          <Field label="Name" required>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" autoFocus />
          </Field>
          <Field label="Fiscal Year" required>
            <select value={fy.value} onChange={(e) => setFyValue(e.target.value)} className="input">
              {fyOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Budget Period" required>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} className="input">
              {Object.entries(PERIOD_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>

          <h2 className="mb-4 mt-7 border-t pt-5 text-[11px] font-medium uppercase tracking-wide text-[#6c718a]">
            Income and Expense Accounts
          </h2>
          {accountRow("income", "Income Accounts")}
          {accountRow("expense", "Expense Accounts")}

          {includeBalanceSheet ? (
            <>
              <h2 className="mb-4 mt-7 text-[11px] font-medium uppercase tracking-wide text-[#6c718a]">
                Asset, Liability, and Equity Accounts
              </h2>
              {ACCOUNT_SECTIONS.slice(2).map((s) => accountRow(s.type, s.label))}
            </>
          ) : (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-gray-700">
              <input
                type="checkbox"
                checked={includeBalanceSheet}
                onChange={(e) => setIncludeBalanceSheet(e.target.checked)}
                className="accent-brand-500"
              />
              Include Asset, Liability, and Equity Accounts in Budget
            </label>
          )}

          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        </div>
      </div>

      <footer className="flex items-center gap-3 border-t bg-white px-6 py-3">
        <button onClick={() => void save()} disabled={busy || !name.trim() || picked.size === 0} className="btn-primary">
          Create Budget
        </button>
        <button onClick={() => navigate("/accountant/budgets")} className="text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>

      {configuring && (
        <ConfigureAccountsModal
          accounts={(accounts ?? []).filter((a) => a.type === configuring && a.isActive)}
          initial={new Set(pickedInType(configuring).map((a) => a.id))}
          onCancel={() => setConfiguring(null)}
          onUpdate={(ids) => {
            applySelection(configuring, ids);
            setConfiguring(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Zoho's account picker: a searchable tree with the group headings shown for
 * context but not selectable — only postable leaves can carry a budget figure.
 */
function ConfigureAccountsModal({
  accounts,
  initial,
  onCancel,
  onUpdate,
}: {
  accounts: Account[];
  initial: Set<string>;
  onCancel: () => void;
  onUpdate: (ids: Set<string>) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  const [search, setSearch] = useState("");

  const term = search.trim().toLowerCase();
  const matches = (a: Account) =>
    !term || a.name.toLowerCase().includes(term) || a.code.toLowerCase().includes(term);

  // Keep a parent visible whenever any of its children match the search.
  const visible = useMemo(() => {
    if (!term) return new Set(accounts.map((a) => a.id));
    const keep = new Set<string>();
    for (const a of accounts) {
      if (!matches(a)) continue;
      keep.add(a.id);
      let p = a.parentId;
      while (p) {
        keep.add(p);
        p = accounts.find((x) => x.id === p)?.parentId ?? null;
      }
    }
    return keep;
  }, [accounts, term]);

  const childrenOf = (parentId: string | null) =>
    accounts
      .filter((a) => (a.parentId ?? null) === parentId && visible.has(a.id))
      .sort((a, b) => a.code.localeCompare(b.code));

  const leaves = accounts.filter((a) => !a.isGroup);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (a: Account, depth: number): ReactNode => (
    <div key={a.id}>
      {a.isGroup ? (
        <div
          className="px-3 py-1.5 text-[13px] font-medium text-gray-700"
          style={{ paddingLeft: 12 + depth * 18 }}
        >
          {a.name}
        </div>
      ) : (
        <label
          className="flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-[13px] hover:bg-gray-50"
          style={{ paddingLeft: 12 + depth * 18 }}
        >
          <input
            type="checkbox"
            checked={selected.has(a.id)}
            onChange={() => toggle(a.id)}
            className="accent-brand-500"
          />
          <span className="tabular-nums text-gray-400">{a.code}</span>
          <span>{a.name}</span>
        </label>
      )}
      {childrenOf(a.id).map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-8">
      <div className="flex max-h-full w-[560px] flex-col rounded-lg bg-white shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h3 className="text-[15px] font-medium">Configure Accounts</h3>
          <button onClick={onCancel} className="text-xl text-gray-400 hover:text-gray-700">
            ×
          </button>
        </header>

        <div className="flex items-center justify-between px-5 pt-4">
          <span className="text-[13px] text-[#e02b2b]">Select Accounts*</span>
          <button
            onClick={() =>
              setSelected((s) =>
                s.size === leaves.length ? new Set() : new Set(leaves.map((a) => a.id)),
              )
            }
            className="text-[13px] font-medium text-brand-600 hover:underline"
          >
            {selected.size === leaves.length ? "Deselect All" : "Select All"}
          </button>
        </div>

        <div className="px-5 pt-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="input"
          />
        </div>

        <div className="mx-5 mt-3 min-h-[220px] flex-1 overflow-y-auto rounded border">
          {childrenOf(null).length === 0 ? (
            <p className="p-4 text-[13px] text-gray-500">No matching accounts.</p>
          ) : (
            childrenOf(null).map((a) => renderNode(a, 0))
          )}
        </div>

        <footer className="flex items-center gap-3 px-5 py-4">
          <button onClick={() => onUpdate(selected)} className="btn-primary">
            Update
          </button>
          <button onClick={onCancel} className="text-[13px] text-gray-500 hover:underline">
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

// ============================ Detail: entry + actuals ============================

interface ActualCell {
  periodStart: string;
  budget: string;
  actual: string;
  variance: string;
  variancePercent: number | null;
}
interface ActualRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  cells: ActualCell[];
  totalBudget: string;
  totalActual: string;
  totalVariance: string;
}

const TYPE_LABEL: Record<string, string> = {
  income: "Income",
  expense: "Expense",
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
};
const TYPE_ORDER = ["income", "expense", "asset", "liability", "equity"];

/**
 * Split rows into P&L-report order. Income and expense must never share a subtotal —
 * adding revenue to cost produces a number that means nothing.
 */
function groupByType<T>(rows: T[], typeOf: (row: T) => string): Array<[string, T[]]> {
  const g = new Map<string, T[]>();
  for (const r of rows) {
    const t = typeOf(r);
    const list = g.get(t) ?? [];
    list.push(r);
    g.set(t, list);
  }
  return [...g.entries()].sort(
    (a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]),
  );
}

/** Over-earning is good, over-spending is bad — so favourability depends on the account. */
function varianceTone(accountType: string, variance: number) {
  if (variance === 0) return "";
  const good = accountType === "income" || accountType === "equity" ? variance > 0 : variance < 0;
  return good ? "text-green-600" : "text-red-600";
}

function Signed({ value, tone }: { value: number; tone: string }) {
  return (
    <span className={`font-medium tabular-nums ${tone}`}>
      {value > 0 ? "+" : value < 0 ? "−" : ""}
      {formatMoney(Math.abs(value))}
    </span>
  );
}

/** Zoho's Budget vs Actuals layout: a Budget/Actual/Variance trio per period, then a Total trio. */
function ActualsGrid({ data, period }: { data: { periods: string[]; rows: ActualRow[] }; period: string }) {
  const { periods, rows } = data;
  const sections = groupByType(rows, (r) => r.accountType);

  /** Sum one measure across a set of rows, either for a period or for the whole budget. */
  const sum = (
    set: ActualRow[],
    measure: "budget" | "actual" | "variance",
    periodStart: string | null,
  ) =>
    set.reduce((s, r) => {
      if (periodStart === null) {
        const key = measure === "budget" ? "totalBudget" : measure === "actual" ? "totalActual" : "totalVariance";
        return s + Number(r[key]);
      }
      const c = r.cells.find((x) => x.periodStart === periodStart) ?? EMPTY_CELL;
      return s + Number(c[measure]);
    }, 0);

  /**
   * A subtotal / net row: same 3-column rhythm as the data rows. `toneType` decides
   * which direction of variance counts as favourable — a net line reads like income.
   */
  const summaryRow = (
    label: string,
    set: ActualRow[],
    key: string,
    toneType: string,
    netOf?: [ActualRow[], ActualRow[]],
  ) => {
    const value = (measure: "budget" | "actual" | "variance", p: string | null) =>
      netOf ? sum(netOf[0], measure, p) - sum(netOf[1], measure, p) : sum(set, measure, p);
    return (
      <tr key={key} className="font-semibold">
        <td className="sticky left-0 z-10 whitespace-nowrap border border-[#ebeaf2] bg-[#f9f9fb] px-3 py-2">{label}</td>
        {[...periods, null].flatMap((p) =>
          (["budget", "actual", "variance"] as const).map((measure) => (
            <td
              key={`${key}-${p ?? "total"}-${measure}`}
              className="border border-[#ebeaf2] bg-[#f9f9fb] px-3 py-2 text-right tabular-nums"
            >
              {measure === "variance" ? (
                <Signed value={value(measure, p)} tone={varianceTone(toneType, value(measure, p))} />
              ) : (
                formatMoney(value(measure, p))
              )}
            </td>
          )),
        )}
      </tr>
    );
  };

  const income = rows.filter((r) => r.accountType === "income");
  const expense = rows.filter((r) => r.accountType === "expense");

  return (
    <div className="overflow-x-auto">
      <table className="text-[13px]">
        <thead className="table-head">
          <tr>
            <th rowSpan={2} className="sticky left-0 z-10 border border-[#ebeaf2] bg-[#f9f9fb] px-3 py-2 text-left align-bottom">
              Account
            </th>
            {periods.map((p) => (
              <th key={p} colSpan={3} className="border border-[#ebeaf2] px-3 py-1.5 text-center">
                {periodLabel(p, period)}
              </th>
            ))}
            <th colSpan={3} className="border border-[#ebeaf2] px-3 py-1.5 text-center">
              Total
            </th>
          </tr>
          <tr>
            {[...periods, "total"].flatMap((p) =>
              ["Budget", "Actual", "Variance"].map((h) => (
                <th
                  key={`${p}-${h}`}
                  className="whitespace-nowrap border border-[#ebeaf2] px-3 py-1.5 text-right text-[11px] font-medium"
                >
                  {h}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {sections.flatMap(([type, set]) => [
            <tr key={`${type}-head`}>
              <td
                colSpan={periods.length * 3 + 4}
                className="border border-[#ebeaf2] bg-[#f4f4f8] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#6c718a]"
              >
                {TYPE_LABEL[type] ?? type}
              </td>
            </tr>,
            ...set.map((r) => (
            <tr key={r.accountId}>
              <td className="sticky left-0 z-10 whitespace-nowrap border border-[#ebeaf2] bg-white px-3 py-1.5">
                <span className="tabular-nums text-gray-500">{r.accountCode}</span> {r.accountName}
              </td>
              {periods.flatMap((p) => {
                const c = r.cells.find((x) => x.periodStart === p) ?? EMPTY_CELL;
                return [
                  <td key={`${p}-b`} className="border border-[#ebeaf2] px-3 py-1.5 text-right tabular-nums">
                    {formatMoney(c.budget)}
                  </td>,
                  <td key={`${p}-a`} className="border border-[#ebeaf2] px-3 py-1.5 text-right tabular-nums">
                    {formatMoney(c.actual)}
                  </td>,
                  <td key={`${p}-v`} className="border border-[#ebeaf2] px-3 py-1.5 text-right">
                    <Signed value={Number(c.variance)} tone={varianceTone(r.accountType, Number(c.variance))} />
                  </td>,
                ];
              })}
              <td className="border border-[#ebeaf2] bg-[#fbfbfd] px-3 py-1.5 text-right font-medium tabular-nums">
                {formatMoney(r.totalBudget)}
              </td>
              <td className="border border-[#ebeaf2] bg-[#fbfbfd] px-3 py-1.5 text-right font-medium tabular-nums">
                {formatMoney(r.totalActual)}
              </td>
              <td className="border border-[#ebeaf2] bg-[#fbfbfd] px-3 py-1.5 text-right">
                <Signed value={Number(r.totalVariance)} tone={varianceTone(r.accountType, Number(r.totalVariance))} />
              </td>
            </tr>
            )),
            summaryRow(`Total ${TYPE_LABEL[type] ?? type}`, set, `${type}-total`, type),
          ])}
          {income.length > 0 && expense.length > 0 &&
            summaryRow("Net Profit / (Loss)", [], "net", "income", [income, expense])}
        </tbody>
      </table>
    </div>
  );
}

const EMPTY_CELL: ActualCell = {
  periodStart: "",
  budget: "0",
  actual: "0",
  variance: "0",
  variancePercent: null,
};

export function BudgetDetailPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"entry" | "actuals">("entry");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["budget", id],
    queryFn: () =>
      api<{
        id: string; name: string; period: string; startDate: string; endDate: string;
        periods: string[];
        lines: Array<{ accountId: string; periodStart: string; amount: string; accountCode: string; accountName: string; accountType: string }>;
      }>(`/api/budgets/${id}`),
  });
  const { data: actuals } = useQuery({
    queryKey: ["budget-actuals", id],
    queryFn: () => api<{ periods: string[]; rows: ActualRow[] }>(`/api/budgets/${id}/actuals`),
    enabled: tab === "actuals",
  });

  // Seed the editable grid from what's stored.
  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const l of data.lines) next[`${l.accountId}:${l.periodStart}`] = String(Number(l.amount));
    setDraft(next);
  }, [data]);

  const accountsInBudget = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, { accountId: string; accountCode: string; accountName: string; accountType: string }>();
    for (const l of data.lines) {
      if (!seen.has(l.accountId)) {
        seen.set(l.accountId, {
          accountId: l.accountId,
          accountCode: l.accountCode,
          accountName: l.accountName,
          accountType: l.accountType,
        });
      }
    }
    return [...seen.values()];
  }, [data]);

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setNotice(null);
    try {
      const lines = Object.entries(draft).map(([key, amount]) => {
        const [accountId, periodStart] = key.split(":");
        return { accountId: accountId!, periodStart: periodStart!, amount: (Number(amount) || 0).toFixed(2) };
      });
      await api(`/api/budgets/${id}/lines`, { method: "PATCH", body: { lines } });
      await qc.invalidateQueries({ queryKey: ["budget", id] });
      await qc.invalidateQueries({ queryKey: ["budget-actuals", id] });
      setNotice("Budget saved.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <div className="p-8 text-sm text-gray-500">Loading…</div>;

  const cell = (accountId: string, periodStart: string) =>
    Number(draft[`${accountId}:${periodStart}`]) || 0;
  const columnTotal = (set: typeof accountsInBudget, periodStart: string) =>
    set.reduce((s, a) => s + cell(a.accountId, periodStart), 0);
  const entrySections = groupByType(accountsInBudget, (a) => a.accountType);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-6 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate("/accountant/budgets")} className="text-gray-400 hover:text-gray-700">
              ←
            </button>
            <h1 className="text-base font-semibold">{data.name}</h1>
            <span className="text-[13px] text-gray-500">
              {PERIOD_LABEL[data.period] ?? data.period} · {formatDate(data.startDate)} to{" "}
              {formatDate(data.endDate)}
            </span>
          </div>
          {tab === "entry" && (
            <button onClick={() => void save()} disabled={saving} className="btn-primary">
              Save Budget
            </button>
          )}
        </div>
        <nav className="flex gap-5 text-[13px]">
          {(["entry", "actuals"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`border-b-2 pb-2 ${
                tab === t ? "border-brand-500 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {t === "entry" ? "Budget Figures" : "Budget vs Actuals"}
            </button>
          ))}
        </nav>
      </header>

      {notice && <p className="border-b bg-green-50 px-6 py-2 text-sm text-green-700">{notice}</p>}

      <div className="flex-1 overflow-auto p-6">
        {tab === "entry" ? (
          <table className="text-[13px]">
            <thead className="table-head">
              <tr>
                <th className="sticky left-0 z-10 border border-[#ebeaf2] bg-[#f9f9fb] px-3 py-2 text-left">Account</th>
                {data.periods.map((p) => (
                  <th key={p} className="w-28 border border-[#ebeaf2] px-3 py-2 text-right">
                    {periodLabel(p, data.period)}
                  </th>
                ))}
                <th className="w-32 border border-[#ebeaf2] px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {entrySections.flatMap(([type, set]) => [
                <tr key={`${type}-head`}>
                  <td
                    colSpan={data.periods.length + 2}
                    className="border border-[#ebeaf2] bg-[#f4f4f8] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#6c718a]"
                  >
                    {TYPE_LABEL[type] ?? type}
                  </td>
                </tr>,
                ...set.map((a) => {
                const rowTotal = data.periods.reduce((s, p) => s + cell(a.accountId, p), 0);
                return (
                  <tr key={a.accountId}>
                    <td className="sticky left-0 z-10 whitespace-nowrap border border-[#ebeaf2] bg-white px-3 py-1.5">
                      <span className="tabular-nums text-gray-500">{a.accountCode}</span>{" "}
                      <span>{a.accountName}</span>
                    </td>
                    {data.periods.map((p) => (
                      <td key={p} className="border border-[#ebeaf2] p-1">
                        <input
                          value={draft[`${a.accountId}:${p}`] ?? ""}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [`${a.accountId}:${p}`]: e.target.value }))
                          }
                          placeholder="0"
                          className="input py-1 text-right tabular-nums"
                        />
                      </td>
                    ))}
                    <td className="border border-[#ebeaf2] px-3 py-1.5 text-right font-medium tabular-nums">
                      {formatMoney(rowTotal)}
                    </td>
                  </tr>
                );
                }),
                <tr key={`${type}-total`} className="font-semibold">
                  <td className="sticky left-0 z-10 whitespace-nowrap border border-[#ebeaf2] bg-[#f9f9fb] px-3 py-2">
                    Total {TYPE_LABEL[type] ?? type}
                  </td>
                  {data.periods.map((p) => (
                    <td key={p} className="border border-[#ebeaf2] bg-[#f9f9fb] px-3 py-2 text-right tabular-nums">
                      {formatMoney(columnTotal(set, p))}
                    </td>
                  ))}
                  <td className="border border-[#ebeaf2] bg-[#f9f9fb] px-3 py-2 text-right tabular-nums">
                    {formatMoney(data.periods.reduce((s, p) => s + columnTotal(set, p), 0))}
                  </td>
                </tr>,
              ])}
            </tbody>
          </table>
        ) : !actuals ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <ActualsGrid data={actuals} period={data.period} />
        )}
      </div>
    </div>
  );
}
