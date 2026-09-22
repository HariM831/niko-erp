import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { filterRows, useAdvancedSearch, type SearchField } from "../components/advanced-search";

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  isGroup: boolean;
  parentId: string | null;
  systemKey: string | null;
  isActive: boolean;
}

/** Zoho's wording for each granular classification. */
const SUBTYPE_LABEL: Record<string, string> = {
  other_current_asset: "Other Current Asset",
  cash: "Cash",
  bank: "Bank",
  accounts_receivable: "Accounts Receivable",
  stock: "Stock",
  fixed_asset: "Fixed Asset",
  other_asset: "Other Asset",
  other_current_liability: "Other Current Liability",
  accounts_payable: "Accounts Payable",
  credit_card: "Credit Card",
  non_current_liability: "Non Current Liability",
  other_liability: "Other Liability",
  equity: "Equity",
  income: "Income",
  other_income: "Other Income",
  expense: "Expense",
  cost_of_goods_sold: "Cost Of Goods Sold",
  other_expense: "Other Expense",
};

type View = "active" | "inactive" | "all";

/**
 * Zoho's chart search asks only for name and code. Type and status are added
 * because the chart is read by them — "which bank accounts are there",
 * "what did we retire" — and both are columns on the list already.
 */
const ACCOUNT_SEARCH: SearchField[] = [
  { key: "name", label: "Account Name", kind: "text" },
  { key: "code", label: "Account Code", kind: "text" },
  {
    key: "subtype",
    label: "Account Type",
    kind: "select",
    options: Object.entries(SUBTYPE_LABEL).map(([value, label]) => ({ value, label })),
  },
  {
    key: "status",
    label: "Status",
    kind: "select",
    options: [
      { value: "active", label: "Active" },
      { value: "inactive", label: "Inactive" },
    ],
  },
];

const accountValue = (a: Account, key: string) => {
  switch (key) {
    case "name":
      return a.name;
    case "code":
      return a.code;
    case "subtype":
      return a.subtype;
    case "status":
      return a.isActive ? "active" : "inactive";
  }
  return undefined;
};

/**
 * Chart of accounts as a tree. Children are nested under their parent and the
 * whole branch keeps its shape when filtering, so an inactive child never makes
 * its parent disappear.
 */
export function ChartOfAccountsPage() {
  const [, navigate] = useLocation();
  const [view, setView] = useState<View>("active");
  const [viewsOpen, setViewsOpen] = useState(false);
  const adv = useAdvancedSearch("Chart of Accounts", ACCOUNT_SEARCH);

  const { data: accounts, isLoading } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });

  const { rows, byId } = useMemo(() => {
    const all = accounts ?? [];
    const byId = new Map(all.map((a) => [a.id, a]));
    const childrenOf = new Map<string | null, Account[]>();
    for (const a of all) {
      const key = a.parentId ?? null;
      const list = childrenOf.get(key) ?? [];
      list.push(a);
      childrenOf.set(key, list);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.code.localeCompare(b.code));

    // A search reaches the whole chart, the way Zoho's results replace the
    // view: Status is one of its fields, and asking for inactive accounts
    // inside the Active view would answer nothing.
    const hits = adv.active
      ? new Set(filterRows(all, ACCOUNT_SEARCH, adv.criteria, accountValue).map((a) => a.id))
      : null;
    const visible = (a: Account) =>
      hits ? hits.has(a.id) : view === "all" || (view === "active" ? a.isActive : !a.isActive);

    // Keep a branch if the account itself matches or any descendant does.
    const matches = (a: Account): boolean =>
      visible(a) || (childrenOf.get(a.id) ?? []).some(matches);

    const rows: Array<Account & { depth: number }> = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const a of childrenOf.get(parentId) ?? []) {
        if (!matches(a)) continue;
        rows.push({ ...a, depth });
        walk(a.id, depth + 1);
      }
    };
    walk(null, 0);
    return { rows, byId };
  }, [accounts, view, adv.active, adv.criteria]);

  const viewLabel = adv.active
    ? "Search Results"
    : view === "active" ? "Active Accounts" : view === "inactive" ? "Inactive Accounts" : "All Accounts";

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <div className="relative">
          <button
            onClick={() => setViewsOpen((o) => !o)}
            onBlur={() => setTimeout(() => setViewsOpen(false), 150)}
            className="flex items-center gap-1.5 text-lg font-semibold text-gray-800"
          >
            {viewLabel}
            <span className="text-xs text-brand-500">▼</span>
          </button>
          {viewsOpen && (
            <div className="absolute left-0 top-9 z-20 w-48 rounded-lg border bg-white py-1 shadow-lg">
              {(["active", "inactive", "all"] as View[]).map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    // Picking a view leaves the search, as it does in Zoho.
                    setView(v);
                    adv.setCriteria({});
                    setViewsOpen(false);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-[13px] capitalize hover:bg-brand-50 ${
                    v === view ? "bg-brand-50 font-medium text-brand-700" : ""
                  }`}
                >
                  {v} Accounts
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {adv.button}
          <button onClick={() => navigate("/accountant/accounts/new")} className="btn-primary">
            + New Account
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : (
          <table className="data-table w-full border-separate border-spacing-0 text-[13px]">
            <thead className="table-head sticky top-0 z-10">
              <tr>
                <th className="col-fill border-b border-[#ece3d5] px-4 py-2.5">Account Name</th>
                <th className="border-b border-[#ece3d5] px-4 py-2.5">Account Code</th>
                <th className="col-portrait-hide border-b border-[#ece3d5] px-4 py-2.5">Account Type</th>
                <th className="col-portrait-hide border-b border-[#ece3d5] px-4 py-2.5">Parent Account Name</th>
                <th className="col-portrait-hide border-b border-[#ece3d5] px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {adv.active && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-gray-500">
                    No accounts match this search.
                  </td>
                </tr>
              )}
              {rows.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => navigate(`/accountant/accounts/${a.id}`)}
                  className="cursor-pointer bg-white transition-colors hover:bg-gray-50"
                >
                  <td className="col-fill border-b border-[#ece3d5] px-4 py-2.5"><span style={{ paddingLeft: `${a.depth * 18}px` }} className="inline-block">
                      <span className={a.isGroup ? "font-semibold text-gray-800" : "text-brand-600"}>
                        {a.name}
                      </span>
                      {a.isGroup && (
                        <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                          Heading
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="border-b border-[#ece3d5] px-4 py-2.5 tabular-nums text-gray-600">{a.code}</td>
                  <td className="col-portrait-hide border-b border-[#ece3d5] px-4 py-2.5 text-gray-700">{a.subtype ? SUBTYPE_LABEL[a.subtype] ?? a.subtype : "—"}
                  </td>
                  <td className="col-portrait-hide border-b border-[#ece3d5] px-4 py-2.5 text-gray-600">
                    {a.parentId ? byId.get(a.parentId)?.name ?? "—" : "—"}
                  </td>
                  <td className="col-portrait-hide border-b border-[#ece3d5] px-4 py-2.5">
                    <span className={a.isActive ? "text-green-600" : "text-gray-400"}>
                      {a.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adv.dialog}
    </div>
  );
}
