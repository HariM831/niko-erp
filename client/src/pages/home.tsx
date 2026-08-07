import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, ReceiptText, Wallet } from "lucide-react";
import { useLocation } from "wouter";
import { api, formatMoney } from "../api";
import { useAuth } from "../auth";

interface Aging {
  totals: Record<string, string>;
  grandTotal: string;
}

/** Receivables/Payables card: unpaid total with a current-vs-overdue split bar. */
function AgingCard({
  title,
  subtitle,
  data,
  newPath,
}: {
  title: string;
  subtitle: string;
  data?: Aging;
  newPath: string;
}) {
  const [, navigate] = useLocation();
  const current = Number(data?.totals["current"] ?? 0);
  const overdue =
    Number(data?.grandTotal ?? 0) - current;
  const total = current + overdue;
  const currentPct = total > 0 ? (current / total) * 100 : 0;

  const isReceivable = title.includes("Receivables");
  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className={`chip ${isReceivable ? "bg-brand-50 text-brand-600" : "bg-orange-50 text-orange-500"}`}>
            {isReceivable ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}
          </span>
          <h2 className="text-[15px] font-bold">{title}</h2>
        </div>
        <button
          onClick={() => navigate(newPath)}
          className="text-[13px] font-semibold text-brand-600 hover:underline"
        >
          + New
        </button>
      </div>
      <div className="px-5 py-4">
        <div className="text-[13px] text-gray-500">{subtitle}</div>
        <div className="mb-3 text-2xl font-semibold tabular-nums">{formatMoney(total)}</div>
        <div className="mb-3 flex h-2.5 w-full overflow-hidden rounded bg-gray-100">
          {total > 0 && (
            <>
              <div className="bg-brand-500" style={{ width: `${currentPct}%` }} />
              <div className="bg-orange-500" style={{ width: `${100 - currentPct}%` }} />
            </>
          )}
        </div>
        <div className="flex items-center gap-6 text-[13px]">
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-brand-500" />
            Current : <strong className="tabular-nums">{formatMoney(current)}</strong>
          </span>
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-orange-500" />
            Overdue : <strong className="tabular-nums">{formatMoney(overdue)}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}

function fiscalYearStart(): string {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

export function HomePage() {
  const { user } = useAuth();
  const today = new Date().toISOString().slice(0, 10);

  const { data: ar } = useQuery({
    queryKey: ["ar-aging"],
    queryFn: () => api<Aging>("/api/reports/ar-aging"),
  });
  const { data: ap } = useQuery({
    queryKey: ["ap-aging"],
    queryFn: () => api<Aging>("/api/reports/ap-aging"),
  });
  const { data: cash } = useQuery({
    queryKey: ["cash-flow-home"],
    queryFn: () =>
      api<{ opening: string; totalInflows: string; totalOutflows: string; closing: string }>(
        `/api/reports/cash-flow?from=${fiscalYearStart()}&to=${today}`,
      ),
  });
  const { data: pnl } = useQuery({
    queryKey: ["pnl-home"],
    queryFn: () =>
      api<{ totalIncome: string; totalExpenses: string; netProfit: string }>(
        `/api/reports/pnl?from=${fiscalYearStart()}&to=${today}`,
      ),
  });
  const { data: org } = useQuery({
    queryKey: ["org"],
    queryFn: () => api<{ name: string } | null>("/api/settings/org"),
  });

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="border-b border-gray-200 bg-gradient-to-r from-white via-white to-brand-50 px-7 py-5">
        <h1 className="text-[22px] font-bold tracking-tight">
          Hello, {user?.name?.split(" ")[0] ?? "there"} 👋
        </h1>
        <div className="mt-0.5 text-[13px] text-gray-500">
          {org?.name || "Set up your organisation in Settings"}
        </div>
      </div>

      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <AgingCard
          title="Total Receivables"
          subtitle="Total Unpaid Invoices"
          data={ar}
          newPath="/sales/invoices/new"
        />
        <AgingCard
          title="Total Payables"
          subtitle="Total Unpaid Bills"
          data={ap}
          newPath="/purchases/bills/new"
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <div className="flex items-center gap-2.5 border-b border-gray-100 px-5 py-3.5">
              <span className="chip bg-emerald-50 text-emerald-600"><Wallet size={17} /></span>
              <div>
              <h2 className="text-[15px] font-bold">Cash Flow</h2>
              <div className="text-xs text-gray-400">This Fiscal Year</div>
              </div>
            </div>
            <div className="space-y-3 px-5 py-4 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-gray-500">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-gray-300" />
                  Opening Cash
                </span>
                <span className="font-semibold tabular-nums">{formatMoney(cash?.opening ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-green-500" />
                  Incoming
                </span>
                <span className="font-semibold tabular-nums">
                  {formatMoney(cash?.totalInflows ?? 0)} ( + )
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-red-500" />
                  Outgoing
                </span>
                <span className="font-semibold tabular-nums">
                  {formatMoney(cash?.totalOutflows ?? 0)} ( − )
                </span>
              </div>
              <div className="flex items-center justify-between border-t pt-3">
                <span className="text-gray-500">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-brand-500" />
                  Closing Cash
                </span>
                <span className="font-semibold tabular-nums">
                  {formatMoney(cash?.closing ?? 0)} ( = )
                </span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-2.5 border-b border-gray-100 px-5 py-3.5">
              <span className="chip bg-violet-50 text-violet-600"><ReceiptText size={17} /></span>
              <div>
              <h2 className="text-[15px] font-bold">Income and Expense</h2>
              <div className="text-xs text-gray-400">This Fiscal Year</div>
              </div>
            </div>
            <div className="space-y-4 px-5 py-4 text-[13px]">
              <div>
                <div className="text-gray-500">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-green-500" />
                  Total Income
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatMoney(pnl?.totalIncome ?? 0)}
                </div>
              </div>
              <div>
                <div className="text-gray-500">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-red-400" />
                  Total Expenses
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatMoney(pnl?.totalExpenses ?? 0)}
                </div>
              </div>
              <div className="border-t pt-3">
                <div className="text-gray-500">Net Profit / Loss</div>
                <div
                  className={`text-lg font-semibold tabular-nums ${
                    Number(pnl?.netProfit ?? 0) >= 0 ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {formatMoney(pnl?.netProfit ?? 0)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
