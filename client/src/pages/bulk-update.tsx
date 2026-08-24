import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";

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

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  isGroup: boolean;
  isActive: boolean;
}
interface Contact { id: string; displayName: string; type: string }

interface ResultRow {
  id: string;
  number: string;
  date: string;
  total: string;
  status: string;
  contactName: string | null;
  type: string;
}
interface SearchResult {
  account: { id: string; code: string; name: string; type: string };
  maxSelection: number;
  total: number;
  groups: Array<{ type: string; label: string; rows: ResultRow[] }>;
}

interface Filters {
  accountId: string;
  contactId: string;
  fromDate: string;
  toDate: string;
  minAmount: string;
  maxAmount: string;
}

const EMPTY_FILTERS: Filters = {
  accountId: "", contactId: "", fromDate: "", toDate: "", minAmount: "", maxAmount: "",
};

/** Strip blank fields — the API treats "absent" and "empty" differently. */
function toPayload(f: Filters) {
  const out: Record<string, string> = { accountId: f.accountId };
  for (const k of ["contactId", "fromDate", "toDate", "minAmount", "maxAmount"] as const) {
    if (f[k].trim()) out[k] = f[k].trim();
  }
  return out;
}

/** Accounts grouped under their subtype heading, the way Zoho's picker reads. */
function AccountSelect({
  accounts, value, onChange, placeholder,
}: { accounts: Account[]; value: string; onChange: (v: string) => void; placeholder: string }) {
  const grouped = useMemo(() => {
    const g = new Map<string, Account[]>();
    for (const a of accounts) {
      const key = a.subtype ?? a.type;
      const list = g.get(key) ?? [];
      list.push(a);
      g.set(key, list);
    }
    return [...g.entries()];
  }, [accounts]);

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
      <option value="">{placeholder}</option>
      {grouped.map(([key, list]) => (
        <optgroup key={key} label={SUBTYPE_LABEL[key] ?? key}>
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function FilterModal({
  initial, accounts, contacts, onCancel, onSearch,
}: {
  initial: Filters;
  accounts: Account[];
  contacts: Contact[];
  onCancel: () => void;
  onSearch: (f: Filters) => void;
}) {
  const [f, setF] = useState<Filters>(initial);
  const set = (patch: Partial<Filters>) => setF((prev) => ({ ...prev, ...patch }));
  const invalidRange = !!f.fromDate && !!f.toDate && f.toDate < f.fromDate;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-10">
      <div className="w-[560px] rounded-lg bg-white shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h3 className="text-[15px] font-medium">Filter Transactions</h3>
          <button onClick={onCancel} className="text-xl text-gray-400 hover:text-gray-700">×</button>
        </header>

        <div className="px-5 py-4">
          <p className="mb-4 text-[13px] text-gray-500">
            Select an account and enter your ranges to filter your transaction
          </p>

          <div className="mb-3 flex items-start gap-4">
            <label className="w-36 shrink-0 pt-1.5 text-[13px] text-[#e02b2b]">Account*</label>
            <div className="flex-1">
              <AccountSelect
                accounts={accounts}
                value={f.accountId}
                onChange={(v) => set({ accountId: v })}
                placeholder="Select an account"
              />
            </div>
          </div>

          <div className="mb-3 flex items-start gap-4">
            <label className="w-36 shrink-0 pt-1.5 text-[13px] text-gray-600">Contact</label>
            <div className="flex-1">
              <select value={f.contactId} onChange={(e) => set({ contactId: e.target.value })} className="input">
                <option value="">Select Contact</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mb-3 flex items-start gap-4">
            <label className="w-36 shrink-0 pt-1.5 text-[13px] text-gray-600">Date Range</label>
            <div className="flex flex-1 items-center gap-2">
              <input type="date" value={f.fromDate} onChange={(e) => set({ fromDate: e.target.value })} className="input" />
              <span className="text-gray-400">—</span>
              <input type="date" value={f.toDate} onChange={(e) => set({ toDate: e.target.value })} className="input" />
            </div>
          </div>

          <div className="flex items-start gap-4">
            <label className="w-36 shrink-0 pt-1.5 text-[13px] text-gray-600">Total Amount Range</label>
            <div className="flex flex-1 items-center gap-2">
              <input value={f.minAmount} onChange={(e) => set({ minAmount: e.target.value })} placeholder="0.00" className="input text-right tabular-nums" />
              <span className="text-gray-400">—</span>
              <input value={f.maxAmount} onChange={(e) => set({ maxAmount: e.target.value })} placeholder="0.00" className="input text-right tabular-nums" />
            </div>
          </div>

          {invalidRange && <p className="mt-3 text-[13px] text-red-600">The end date is before the start date.</p>}
        </div>

        <footer className="flex items-center gap-3 border-t px-5 py-3">
          <button onClick={() => onSearch(f)} disabled={!f.accountId || invalidRange} className="btn-primary">
            Search
          </button>
          <button onClick={onCancel} className="text-[13px] text-gray-500 hover:underline">Cancel</button>
        </footer>
      </div>
    </div>
  );
}

export function BulkUpdatePage() {
  const qc = useQueryClient();
  const [filtering, setFiltering] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const { data: contacts } = useQuery({
    queryKey: ["contacts-all"],
    queryFn: () => api<Contact[]>("/api/contacts"),
  });
  const postable = useMemo(
    () => (accounts ?? []).filter((a) => a.isActive && !a.isGroup),
    [accounts],
  );

  /**
   * `keepNotice` is set when re-running the search straight after an update, so the
   * "n transactions moved" confirmation survives the refresh that follows it.
   */
  const search = async (f: Filters, keepNotice = false) => {
    setBusy(true);
    setError(null);
    if (!keepNotice) setDone(null);
    try {
      const res = await api<SearchResult>("/api/bulk-update/search", { method: "POST", body: toPayload(f) });
      setFilters(f);
      setResult(res);
      setSelected(new Set());
      setStatusFilter({});
      setTarget("");
      setFiltering(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  };

  /** Rows currently visible in a group, after its own status filter. */
  const visibleRows = (group: { type: string; rows: ResultRow[] }) => {
    const want = statusFilter[group.type];
    return want && want !== "all" ? group.rows.filter((r) => r.status === want) : group.rows;
  };

  const key = (r: ResultRow) => `${r.type}:${r.id}`;
  const max = result?.maxSelection ?? 50;
  const atLimit = selected.size >= max;

  const toggle = (r: ResultRow) =>
    setSelected((s) => {
      const next = new Set(s);
      const k = key(r);
      if (next.has(k)) next.delete(k);
      else if (next.size < max) next.add(k);
      return next;
    });

  const toggleGroup = (group: { type: string; rows: ResultRow[] }) => {
    const rows = visibleRows(group);
    const allOn = rows.every((r) => selected.has(key(r)));
    setSelected((s) => {
      const next = new Set(s);
      for (const r of rows) {
        if (allOn) next.delete(key(r));
        else if (next.size < max) next.add(key(r));
      }
      return next;
    });
  };

  const apply = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const documents = [...selected].map((k) => {
        const [type, id] = k.split(":");
        return { type: type!, id: id! };
      });
      const res = await api<{ updated: number }>("/api/bulk-update/apply", {
        method: "POST",
        body: { fromAccountId: result.account.id, toAccountId: target, documents },
      });
      const to = postable.find((a) => a.id === target);
      setDone(`${res.updated} transaction(s) moved to ${to?.code} · ${to?.name}.`);
      setConfirming(false);
      // Balances everywhere have shifted; drop cached reads.
      await qc.invalidateQueries();
      await search(filters, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk update failed");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  // ---------- Landing ----------
  if (!result) {
    return (
      <div className="flex h-full flex-col">
        <div className="mx-auto mt-16 max-w-2xl px-6 text-center">
          <h1 className="text-xl font-medium text-gray-800">Bulk Update Accounts in Transactions</h1>
          <p className="mt-2 text-[13px] text-gray-500">
            Filter transactions (Invoices, Credit Notes, Purchase Orders, Expenses, Bills, Vendor
            Credits) and bulk-update its accounts with a new account
          </p>
          <div className="mt-6 flex items-start gap-3 rounded border border-[#f2d9a0] bg-[#fdf6e3] px-4 py-3 text-left">
            <span className="mt-0.5 text-[#d69e2e]">!</span>
            <p className="text-[13px] text-gray-700">
              Bulk-updating accounts in transactions will cause significant changes to the financial
              data of your business. We recommend that you do this with the assistance of an accountant.
            </p>
          </div>
          <button onClick={() => setFiltering(true)} className="btn-primary mt-6">
            Filter and Bulk Update
          </button>
          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        </div>

        {filtering && (
          <FilterModal
            initial={filters}
            accounts={postable}
            contacts={contacts ?? []}
            onCancel={() => setFiltering(false)}
            onSearch={(f) => void search(f)}
          />
        )}
      </div>
    );
  }

  // ---------- Results ----------
  const filterChips = [
    `Account Name: ${result.account.code} · ${result.account.name}`,
    filters.contactId && `Contact: ${contacts?.find((c) => c.id === filters.contactId)?.displayName ?? "—"}`,
    (filters.fromDate || filters.toDate) &&
      `Date: ${filters.fromDate || "any"} to ${filters.toDate || "any"}`,
    (filters.minAmount || filters.maxAmount) &&
      `Amount: ${filters.minAmount || "any"} to ${filters.maxAmount || "any"}`,
  ].filter(Boolean) as string[];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-6 py-3">
        <h1 className="text-lg font-medium">Bulk Update Accounts in Transactions</h1>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="rounded border border-[#d9ecd9] bg-[#f2faf2] px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#4a7c4a]">Filtered based on</p>
          <ul className="mt-1 space-y-0.5">
            {filterChips.map((c) => (
              <li key={c} className="text-[13px] text-gray-700">• {c}</li>
            ))}
          </ul>
          <button
            onClick={() => setFiltering(true)}
            className="mt-2 text-[13px] font-medium text-brand-600 hover:underline"
          >
            Change Filter Criteria
          </button>
        </div>

        {done && <p className="mt-3 rounded bg-green-50 px-4 py-2 text-sm text-green-700">{done}</p>}
        {error && <p className="mt-3 rounded bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}

        <p className="mt-4 text-[13px] text-gray-700">
          Number of Transactions selected: <span className="font-medium">{selected.size}</span>{" "}
          <span className="text-gray-500">(Maximum {max})</span>
          {atLimit && <span className="ml-2 text-[#d69e2e]">Limit reached — deselect one to pick another.</span>}
        </p>

        {result.groups.length === 0 ? (
          <p className="mt-8 text-center text-sm text-gray-500">
            No transactions use this account with those filters.
          </p>
        ) : (
          result.groups.map((g) => {
            const rows = visibleRows(g);
            const statuses = [...new Set(g.rows.map((r) => r.status))];
            const allOn = rows.length > 0 && rows.every((r) => selected.has(key(r)));
            return (
              <section key={g.type} className="mt-5">
                <div className="flex items-center justify-between border-b border-[#ece3d5] pb-1.5">
                  <h2 className="text-[13px] font-semibold text-gray-800">
                    {g.label} ({g.rows.length})
                  </h2>
                  <label className="flex items-center gap-1.5 text-[12px] text-gray-600">
                    Status:
                    <select
                      value={statusFilter[g.type] ?? "all"}
                      onChange={(e) => setStatusFilter((s) => ({ ...s, [g.type]: e.target.value }))}
                      className="rounded border border-[#e3e3ec] px-1.5 py-0.5 text-[12px]"
                    >
                      <option value="all">All</option>
                      {statuses.map((s) => (
                        <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <table className="w-full text-[13px]">
                  <thead className="table-head">
                    <tr>
                      <th className="w-8 px-2 py-2">
                        <input type="checkbox" checked={allOn} onChange={() => toggleGroup(g)} className="accent-brand-500" />
                      </th>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Number</th>
                      <th className="px-3 py-2 text-left">Contact</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const on = selected.has(key(r));
                      return (
                        <tr key={key(r)} className="border-b border-[#ece3d5] hover:bg-gray-50">
                          <td className="px-2 py-1.5">
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={!on && atLimit}
                              onChange={() => toggle(r)}
                              className="accent-brand-500"
                            />
                          </td>
                          <td className="px-3 py-1.5">{formatDate(r.date)}</td>
                          <td className="px-3 py-1.5 font-medium text-brand-600">{r.number}</td>
                          <td className="px-3 py-1.5">{r.contactName ?? "—"}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(r.total)}</td>
                          <td className="px-3 py-1.5 capitalize text-gray-600">{r.status.replace(/_/g, " ")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            );
          })
        )}
      </div>

      <footer className="flex items-center gap-3 border-t bg-white px-6 py-3">
        <label className="text-[13px] text-gray-600">Move to</label>
        <div className="w-80">
          <AccountSelect
            accounts={postable.filter((a) => a.id !== result.account.id)}
            value={target}
            onChange={setTarget}
            placeholder="Select the new account"
          />
        </div>
        <button
          onClick={() => setConfirming(true)}
          disabled={busy || selected.size === 0 || !target}
          className="btn-primary"
        >
          Update
        </button>
        <button onClick={() => setResult(null)} className="text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>

      {filtering && (
        <FilterModal
          initial={filters}
          accounts={postable}
          contacts={contacts ?? []}
          onCancel={() => setFiltering(false)}
          onSearch={(f) => void search(f)}
        />
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-10">
          <div className="w-[480px] rounded-lg bg-white p-5 shadow-xl">
            <h3 className="text-[15px] font-medium">Move {selected.size} transaction(s)?</h3>
            <p className="mt-2 text-[13px] text-gray-600">
              Their postings will move from{" "}
              <span className="font-medium">{result.account.code} · {result.account.name}</span> to{" "}
              <span className="font-medium">
                {postable.find((a) => a.id === target)?.code} · {postable.find((a) => a.id === target)?.name}
              </span>
              . Each document's journal is reversed and re-posted, so the change is fully traceable —
              but it does restate your financial data.
            </p>
            <div className="mt-5 flex items-center gap-3">
              <button onClick={() => void apply()} disabled={busy} className="btn-primary">
                {busy ? "Updating…" : "Yes, update"}
              </button>
              <button onClick={() => setConfirming(false)} className="text-[13px] text-gray-500 hover:underline">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
