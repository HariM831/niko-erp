import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { Landmark, TrendingUp, Wallet } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { api, formatMoney } from "../api";
import { useLocalSearch } from "../components/search-context";
import { matchesTerm } from "../lib/utils";
import { filterRows, useAdvancedSearch, type SearchField } from "../components/advanced-search";

interface AccountSummary {
  id: string;
  name: string;
  kind: string;
  bankName?: string;
  accountNumber?: string;
  amountInBooks: string;
  uncategorized: number;
}
interface Summary {
  cashInHand: string;
  bankBalance: string;
  accounts: AccountSummary[];
}

/**
 * The overview's own search: which account, what kind, how much is in it. The
 * list is small and already on the page, so it is filtered here.
 */
const ACCOUNTS_SEARCH: SearchField[] = [
  { key: "name", label: "Account Name", kind: "text" },
  {
    key: "kind",
    label: "Account Type",
    kind: "select",
    options: [
      { value: "bank", label: "Bank" },
      { value: "cash", label: "Cash" },
      { value: "card", label: "Card" },
    ],
  },
  { key: "balance", label: "Amount in Books", kind: "numberRange" },
];

/** Zoho-style Banking Overview: summary tiles + an Active Accounts register list. */
export function BankingOverviewPage() {
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ["banking-summary"],
    queryFn: () => api<Summary>("/api/banking/summary"),
  });
  const term = useLocalSearch("Banking", "banking:accounts");
  const adv = useAdvancedSearch("Banking", ACCOUNTS_SEARCH);
  const accounts = filterRows(
    (data?.accounts ?? []).filter((a) => matchesTerm(term, [a.name, a.bankName, a.accountNumber])),
    ACCOUNTS_SEARCH,
    adv.criteria,
    (a, key) =>
      key === "name" ? [a.name, a.bankName, a.accountNumber] : key === "kind" ? a.kind : key === "balance" ? a.amountInBooks : undefined,
  );

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-3.5">
        <h1 className="text-lg font-semibold">Banking Overview</h1>
        <div className="flex items-center gap-2">
          {adv.button}
          <button onClick={() => navigate("/banking/new")} className="btn-primary">
            + Add Bank or Cash Account
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <div className="card mb-6 grid grid-cols-1 divide-y divide-gray-100 p-0 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="flex items-center gap-3 p-5">
            <span className="chip bg-amber-50 text-amber-600">
              <Wallet size={18} />
            </span>
            <div>
              <div className="text-[13px] text-gray-500">Cash in Hand</div>
              <div className="text-[clamp(1rem,4.6vw,1.25rem)] font-bold tabular-nums">{formatMoney(data?.cashInHand ?? 0)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 p-5">
            <span className="chip bg-brand-50 text-brand-600">
              <Landmark size={18} />
            </span>
            <div>
              <div className="text-[13px] text-gray-500">Bank Balance</div>
              <div className="text-[clamp(1rem,4.6vw,1.25rem)] font-bold tabular-nums">{formatMoney(data?.bankBalance ?? 0)}</div>
            </div>
          </div>
        </div>

        <BalanceChart />

        <h2 className="mb-2 text-sm font-semibold text-gray-700">Active Accounts</h2>
        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
          ) : !accounts.length && adv.active ? (
            <div className="p-10 text-center text-sm text-gray-500">No accounts match the search.</div>
          ) : !accounts.length && term.trim() ? (
            <div className="p-10 text-center text-sm text-gray-500">No accounts match “{term.trim()}”.</div>
          ) : !accounts.length ? (
            <div className="p-10 text-center text-sm text-gray-500">
              No bank or cash accounts yet.{" "}
              <button onClick={() => navigate("/banking/new")} className="text-brand-600 hover:underline">
                Add one
              </button>
            </div>
          ) : (
            <table className="data-table w-full text-[13px]">
              <thead className="table-head">
                <tr>
                  <th className="border-b border-[#ece3d5] px-4 py-2.5">Account Details</th>
                  <th className="col-portrait-hide border-b border-[#ece3d5] px-4 py-2.5 text-right">Uncategorized</th>
                  <th className="border-b border-[#ece3d5] px-4 py-2.5 text-right">Amount in Books</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => navigate(`/banking/${a.id}`)}
                    className="cursor-pointer bg-white transition-colors hover:bg-gray-50"
                  >
                    <td className="border-b border-[#ece3d5] px-4 py-3">
                      <span className="flex items-center gap-2.5">
                        <span className="chip h-8 w-8 bg-gray-100 text-gray-500">
                          {a.kind === "cash" ? <Wallet size={14} /> : <Landmark size={14} />}
                        </span>
                        <span>
                          <div className="font-medium text-brand-600">{a.name}</div>
                          <div className="text-xs text-gray-500">
                            {a.bankName ?? a.kind} {a.accountNumber ? `•••${a.accountNumber.slice(-4)}` : ""}
                          </div>
                        </span>
                      </span>
                    </td>
                    <td className="col-portrait-hide border-b border-[#ece3d5] px-4 py-3 text-right">
                      {a.uncategorized > 0 ? (
                        <span className="font-semibold text-amber-600">{a.uncategorized}</span>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                    <td
                      className={`border-b border-[#ece3d5] px-4 py-3 text-right font-medium tabular-nums ${
                        Number(a.amountInBooks) < 0 ? "text-red-600" : ""
                      }`}
                    >
                      {formatMoney(a.amountInBooks)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {adv.dialog}
    </div>
  );
}

/**
 * recharts 3 types the Tooltip's formatters more tightly than this chart
 * needs; widened once, as the shed-conditions charts do.
 */
const Tooltip = RechartsTooltip as unknown as (props: Record<string, unknown>) => ReactElement;

/**
 * Zoho's Show Chart: cash in hand and bank balance at the close of each of
 * the last 30 days, two thin lines, folded away until asked for. Read off
 * books.zoho.in's Banking Overview, 24 Sep 2026 — its axis is in millions
 * too, so this one is.
 */
function BalanceChart() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["banking-summary-chart"],
    queryFn: () => api<{ days: Array<{ day: string; cashInHand: number; bankBalance: number }> }>("/api/banking/summary/chart"),
    enabled: open,
  });
  const rows = (data?.days ?? []).map((d) => ({
    ...d,
    label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }),
  }));
  const millions = (v: number) => (v === 0 ? "0" : `${+(v / 1e6).toFixed(1)} M`);
  return (
    <div className="mb-6">
      <button type="button" onClick={() => setOpen((o) => !o)} className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-[#1c5bd9] hover:underline">
        <TrendingUp size={15} /> {open ? "Hide Chart" : "Show Chart"}
      </button>
      {open && (
        <div className="card px-3 pb-2 pt-3">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
          ) : (
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={1} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={millions} width={48} />
                  <Tooltip formatter={(v: number, n: string) => [formatMoney(v), n]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} itemSorter={null} formatter={(v: string) => <span className="text-gray-600">{v}</span>} />
                  <Line dataKey="cashInHand" name="Cash In Hand" stroke="var(--color-muted-foreground)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line dataKey="bankBalance" name="Bank Balance" stroke="var(--color-success)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
