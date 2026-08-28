import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Landmark, Wallet } from "lucide-react";
import { api, formatMoney } from "../api";

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

/** Zoho-style Banking Overview: summary tiles + an Active Accounts register list. */
export function BankingOverviewPage() {
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ["banking-summary"],
    queryFn: () => api<Summary>("/api/banking/summary"),
  });

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-3.5">
        <h1 className="text-lg font-semibold">Banking Overview</h1>
        <div className="flex items-center gap-2">
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

        <h2 className="mb-2 text-sm font-semibold text-gray-700">Active Accounts</h2>
        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
          ) : !data?.accounts.length ? (
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
                  <th className="border-b border-[#ece3d5] px-4 py-2.5 text-right">Amount in Zoho Books</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => (
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
    </div>
  );
}
