import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, formatMoney } from "../api";

type ReportKey = "pnl" | "balance-sheet" | "cash-flow" | "ar-aging" | "ap-aging" | "gst-summary";

const REPORTS: Array<{ key: ReportKey; label: string; group: string }> = [
  { key: "pnl", label: "Profit and Loss", group: "Business Overview" },
  { key: "balance-sheet", label: "Balance Sheet", group: "Business Overview" },
  { key: "cash-flow", label: "Cash Flow Statement", group: "Business Overview" },
  { key: "ar-aging", label: "AR Aging Summary", group: "Receivables" },
  { key: "ap-aging", label: "AP Aging Summary", group: "Payables" },
  { key: "gst-summary", label: "GST Summary (GSTR-3B)", group: "Taxes" },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function monthStart(): string {
  return `${today().slice(0, 8)}01`;
}

function Section({ title, rows, total }: { title: string; rows: Array<{ code: string; name: string; amount: string }>; total?: string }) {
  return (
    <div className="mb-6">
      <h3 className="mb-2 border-b pb-1 text-sm font-semibold uppercase tracking-wide text-gray-600">{title}</h3>
      <table className="w-full text-[13px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.code + r.name} className="border-b border-[#ebeaf2]">
              <td className="py-1.5">{r.name}</td>
              <td className="py-1.5 text-right tabular-nums">{formatMoney(r.amount)}</td>
            </tr>
          ))}
          {total !== undefined && (
            <tr className="font-semibold">
              <td className="py-1.5">Total {title}</td>
              <td className="py-1.5 text-right tabular-nums">{formatMoney(total)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsPage() {
  const [active, setActive] = useState<ReportKey>("pnl");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());

  const usesRange = active === "pnl" || active === "cash-flow" || active === "gst-summary";
  const params = usesRange ? `?from=${from}&to=${to}` : active === "balance-sheet" ? `?asOf=${to}` : `?asOf=${to}`;

  const { data, isLoading, error } = useQuery({
    queryKey: ["report", active, from, to],
    queryFn: () => api<Record<string, unknown>>(`/api/reports/${active}${params}`),
  });

  const groups = [...new Set(REPORTS.map((r) => r.group))];

  return (
    <div className="flex h-full">
      <aside className="w-60 overflow-y-auto border-r bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">Reports</h2>
        {groups.map((g) => (
          <div key={g} className="mb-4">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">{g}</div>
            {REPORTS.filter((r) => r.group === g).map((r) => (
              <button
                key={r.key}
                onClick={() => setActive(r.key)}
                className={`block w-full rounded px-2 py-1.5 text-left text-[13px] ${
                  active === r.key ? "bg-brand-50 font-medium text-brand-700" : "hover:bg-gray-50"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-4 flex items-center gap-3">
          <h1 className="text-lg font-semibold">{REPORTS.find((r) => r.key === active)?.label}</h1>
          {usesRange && (
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input w-auto py-1" />
          )}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input w-auto py-1" />
        </div>
        <div className="card max-w-3xl p-8">
          {isLoading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : error ? (
            <p className="text-sm text-red-600">{error instanceof Error ? error.message : "Failed"}</p>
          ) : data ? (
            <ReportBody report={active} data={data} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReportBody({ report, data }: { report: ReportKey; data: Record<string, unknown> }) {
  type Rows = Array<{ code: string; name: string; amount: string }>;
  switch (report) {
    case "pnl":
      return (
        <>
          <Section title="Income" rows={data.income as Rows} total={data.totalIncome as string} />
          <Section title="Expenses" rows={data.expenses as Rows} total={data.totalExpenses as string} />
          <div className="flex justify-between border-t-2 pt-3 text-base font-semibold">
            <span>Net Profit / (Loss)</span>
            <span className="tabular-nums">{formatMoney(data.netProfit as string)}</span>
          </div>
        </>
      );
    case "balance-sheet":
      return (
        <>
          <Section title="Assets" rows={data.assets as Rows} total={data.totalAssets as string} />
          <Section title="Liabilities" rows={data.liabilities as Rows} total={data.totalLiabilities as string} />
          <Section title="Equity" rows={data.equity as Rows} total={data.totalEquity as string} />
          {!(data.balanced as boolean) && (
            <p className="text-sm font-medium text-red-600">⚠ Sheet does not balance — investigate.</p>
          )}
        </>
      );
    case "cash-flow":
      return (
        <>
          <div className="mb-4 flex justify-between text-sm">
            <span>Opening Cash</span>
            <span className="tabular-nums font-medium">{formatMoney(data.opening as string)}</span>
          </div>
          <Section title="Inflows" rows={data.inflows as Rows} total={data.totalInflows as string} />
          <Section title="Outflows" rows={data.outflows as Rows} total={data.totalOutflows as string} />
          <div className="flex justify-between border-t-2 pt-3 text-base font-semibold">
            <span>Closing Cash</span>
            <span className="tabular-nums">{formatMoney(data.closing as string)}</span>
          </div>
        </>
      );
    case "ar-aging":
    case "ap-aging": {
      const totals = data.totals as Record<string, string>;
      return (
        <>
          <table className="mb-4 w-full text-sm">
            <thead>
              <tr className="border-b border-[#ebeaf2] text-left text-xs uppercase text-gray-500">
                {Object.keys(totals).map((k) => (
                  <th key={k} className="py-2 text-right first:text-left">{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {Object.values(totals).map((v, i) => (
                  <td key={i} className="py-2 text-right tabular-nums first:text-left">{formatMoney(v)}</td>
                ))}
              </tr>
            </tbody>
          </table>
          <div className="flex justify-between border-t pt-2 font-semibold">
            <span>Total Outstanding</span>
            <span className="tabular-nums">{formatMoney(data.grandTotal as string)}</span>
          </div>
        </>
      );
    }
    case "gst-summary": {
      const out = data.outwardSupplies as Record<string, string>;
      const inp = data.inputTaxCredit as Record<string, string>;
      const row = (label: string, v: Record<string, string>, keys: string[]) => (
        <tr className="border-b border-gray-100">
          <td className="py-1.5">{label}</td>
          {keys.map((k) => (
            <td key={k} className="py-1.5 text-right tabular-nums">{formatMoney(v[k])}</td>
          ))}
        </tr>
      );
      return (
        <>
          <table className="mb-4 w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#ebeaf2] text-left text-xs uppercase text-gray-500">
                <th className="py-2">Section</th>
                <th className="py-2 text-right">Taxable</th>
                <th className="py-2 text-right">CGST</th>
                <th className="py-2 text-right">SGST</th>
                <th className="py-2 text-right">IGST</th>
              </tr>
            </thead>
            <tbody>
              {row("Outward supplies", out, ["taxableValue", "cgst", "sgst", "igst"])}
              {row("Input tax credit", inp, ["taxableValue", "cgst", "sgst", "igst"])}
            </tbody>
          </table>
          <div className="flex justify-between border-t pt-2 font-semibold">
            <span>Net GST Payable</span>
            <span className="tabular-nums">{formatMoney(data.netPayable as string)}</span>
          </div>
        </>
      );
    }
  }
}
