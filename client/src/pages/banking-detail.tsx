import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";
import { StatusBadge } from "../components/list-page";

interface BankTxn {
  id: string;
  txnDate: string;
  direction: "debit" | "credit";
  amount: string;
  utr?: string;
  description?: string;
  counterparty?: string;
  matchStatus: string;
}
interface Account {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}
interface Journal {
  id: string;
  entryNumber: string;
  entryDate: string;
  narration: string;
}

const TABS = ["unmatched", "matched", "excluded"] as const;

export function BankingDetailPage({ bankAccountId }: { bankAccountId: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]>("unmatched");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [catAccount, setCatAccount] = useState("");
  const [catNarration, setCatNarration] = useState("");
  const [matchJe, setMatchJe] = useState("");
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: txns } = useQuery({
    queryKey: ["bank-txns", bankAccountId, tab],
    queryFn: () =>
      api<BankTxn[]>(`/api/banking/transactions?bankAccountId=${bankAccountId}&matchStatus=${tab}`),
  });
  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const { data: journals } = useQuery({
    queryKey: ["journals-recent"],
    queryFn: () => api<Journal[]>("/api/accounting/journals"),
  });

  const refresh = async () => {
    await qc.invalidateQueries();
    setExpanded(null);
    setCatAccount("");
    setCatNarration("");
    setMatchJe("");
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  /** CSV import: date,direction,amount,utr,description per line. */
  const runImport = () =>
    act(async () => {
      const transactions = importText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [txnDate, direction, amount, utr, ...desc] = line.split(",");
          return {
            txnDate: txnDate?.trim(),
            direction: direction?.trim() as "debit" | "credit",
            amount: Number(amount?.trim()).toFixed(2),
            utr: utr?.trim() || undefined,
            description: desc.join(",").trim() || undefined,
          };
        });
      const result = (await api("/api/banking/transactions/import", {
        method: "POST",
        body: { bankAccountId, transactions },
      })) as { inserted: number; skipped: number };
      setNotice(`Imported ${result.inserted} transactions, skipped ${result.skipped} duplicates.`);
      setImportText("");
      setShowImport(false);
    });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/banking")} className="text-gray-400 hover:text-gray-700">←</button>
          <h1 className="text-lg font-semibold">Bank Transactions</h1>
          <div className="flex gap-1 rounded-md bg-gray-100 p-0.5 text-[13px]">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded px-2.5 py-1 capitalize ${t === tab ? "bg-white font-medium shadow-sm" : "text-gray-600"}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => setShowImport((s) => !s)}
          className="btn-primary"
        >
          Import Statement
        </button>
      </header>

      {notice && <p className="border-b bg-green-50 px-6 py-2 text-sm text-green-700">{notice}</p>}
      {error && <p className="border-b bg-red-50 px-6 py-2 text-sm text-red-700">{error}</p>}

      {showImport && (
        <div className="border-b bg-gray-50 px-6 py-4">
          <p className="mb-2 text-xs text-gray-600">
            One transaction per line: <code>date(YYYY-MM-DD), debit|credit, amount, utr, description</code>.
            Re-importing the same rows is safe — duplicates are skipped.
          </p>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={5}
            placeholder="2026-08-01, credit, 10500.00, UTR123, NEFT from Sri Lakshmi Traders"
            className="mb-2 w-full rounded border px-3 py-2 font-mono text-xs focus:border-brand-500 focus:outline-none"
          />
          <button
            onClick={() => void runImport()}
            disabled={!importText.trim()}
            className="btn-primary"
          >
            Import
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!txns?.length ? (
          <div className="p-12 text-center text-sm text-gray-500">No {tab} transactions.</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="table-head sticky top-0">
              <tr>
                <th className="border-b px-4 py-2.5">Date</th>
                <th className="border-b px-4 py-2.5">Description</th>
                <th className="border-b px-4 py-2.5">UTR</th>
                <th className="border-b px-4 py-2.5 text-right">Withdrawal</th>
                <th className="border-b px-4 py-2.5 text-right">Deposit</th>
                <th className="border-b px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <>
                  <tr
                    key={t.id}
                    onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                    className="cursor-pointer border-b hover:bg-brand-50/40"
                  >
                    <td className="px-4 py-2.5">{formatDate(t.txnDate)}</td>
                    <td className="px-4 py-2.5">{t.description ?? t.counterparty ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-500">{t.utr ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {t.direction === "debit" ? formatMoney(t.amount) : ""}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {t.direction === "credit" ? formatMoney(t.amount) : ""}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={t.matchStatus} />
                    </td>
                  </tr>
                  {expanded === t.id && (
                    <tr key={`${t.id}-x`} className="border-b bg-gray-50">
                      <td colSpan={6} className="px-6 py-4">
                        {t.matchStatus === "unmatched" ? (
                          <div className="flex flex-wrap items-end gap-3">
                            <div className="w-72">
                              <label className="label">Categorize to account</label>
                              <select value={catAccount} onChange={(e) => setCatAccount(e.target.value)} className="input">
                                <option value="">Select account…</option>
                                {accounts?.filter((a) => a.isActive).map((a) => (
                                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                                ))}
                              </select>
                            </div>
                            <div className="w-72">
                              <label className="label">Narration</label>
                              <input value={catNarration} onChange={(e) => setCatNarration(e.target.value)} className="input" />
                            </div>
                            <button
                              onClick={() =>
                                void act(() =>
                                  api(`/api/banking/transactions/${t.id}/categorize`, {
                                    method: "POST",
                                    body: { accountId: catAccount, narration: catNarration || `Bank: ${t.description ?? t.utr ?? "transaction"}` },
                                  }),
                                )
                              }
                              disabled={!catAccount}
                              className="btn-primary"
                            >
                              Categorize
                            </button>
                            <span className="text-xs text-gray-400">or</span>
                            <div className="w-72">
                              <label className="label">Match to journal entry</label>
                              <select value={matchJe} onChange={(e) => setMatchJe(e.target.value)} className="input">
                                <option value="">Select entry…</option>
                                {journals?.map((j) => (
                                  <option key={j.id} value={j.id}>
                                    {j.entryNumber} · {j.narration.slice(0, 40)}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <button
                              onClick={() =>
                                void act(() =>
                                  api(`/api/banking/transactions/${t.id}/match`, {
                                    method: "POST",
                                    body: { journalEntryId: matchJe },
                                  }),
                                )
                              }
                              disabled={!matchJe}
                              className="btn-secondary"
                            >
                              Match
                            </button>
                            <button
                              onClick={() => void act(() => api(`/api/banking/transactions/${t.id}/exclude`, { method: "POST" }))}
                              className="ml-auto text-[13px] text-gray-500 hover:underline"
                            >
                              Exclude
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => void act(() => api(`/api/banking/transactions/${t.id}/unmatch`, { method: "POST" }))}
                            className="text-[13px] font-medium text-brand-600 hover:underline"
                          >
                            {t.matchStatus === "matched" ? "Unmatch" : "Restore"}
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function BankAccountNewPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", kind: "bank", bankName: "", accountNumber: "", ifsc: "", branch: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/banking/accounts", {
        method: "POST",
        body: {
          name: form.name,
          kind: form.kind,
          bankName: form.bankName || undefined,
          accountNumber: form.accountNumber || undefined,
          ifsc: form.ifsc || undefined,
          branch: form.branch || undefined,
        },
      });
      await qc.invalidateQueries();
      navigate("/banking");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";
  const label = "label";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Add Bank Account</h1>
        <button onClick={() => navigate("/banking")} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-xl grid-cols-2 gap-4">
          <div>
            <label className={label}>Account Name *</label>
            <input value={form.name} onChange={set("name")} className={inputCls} autoFocus />
          </div>
          <div>
            <label className={label}>Type</label>
            <select value={form.kind} onChange={set("kind")} className={inputCls}>
              <option value="bank">Bank</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
            </select>
          </div>
          <div>
            <label className={label}>Bank Name</label>
            <input value={form.bankName} onChange={set("bankName")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Account Number</label>
            <input value={form.accountNumber} onChange={set("accountNumber")} className={inputCls} />
          </div>
          <div>
            <label className={label}>IFSC</label>
            <input value={form.ifsc} onChange={set("ifsc")} maxLength={11} className={inputCls} />
          </div>
          <div>
            <label className={label}>Branch</label>
            <input value={form.branch} onChange={set("branch")} className={inputCls} />
          </div>
        </div>
        <p className="mt-3 max-w-xl text-xs text-gray-500">
          A ledger account is created automatically under Cash &amp; Bank for this account.
        </p>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !form.name.trim()}
          className="btn-primary"
        >
          Save
        </button>
        <button onClick={() => navigate("/banking")} className="ml-2 text-[13px] text-gray-500 hover:underline">Cancel</button>
      </footer>
    </div>
  );
}
