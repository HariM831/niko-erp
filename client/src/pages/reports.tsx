import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, formatMoney } from "../api";

type ReportKey =
  | "pnl"
  | "balance-sheet"
  | "cash-flow"
  | "ar-aging"
  | "ap-aging"
  | "tag-summary"
  | "gst-summary";

const REPORTS: Array<{ key: ReportKey; label: string; group: string }> = [
  { key: "pnl", label: "Profit and Loss", group: "Business Overview" },
  { key: "balance-sheet", label: "Balance Sheet", group: "Business Overview" },
  { key: "cash-flow", label: "Cash Flow Statement", group: "Business Overview" },
  { key: "ar-aging", label: "AR Aging Summary", group: "Receivables" },
  { key: "ap-aging", label: "AP Aging Summary", group: "Payables" },
  { key: "tag-summary", label: "Tag Summary", group: "Reporting Tags" },
  { key: "gst-summary", label: "GST Summary (GSTR-3B)", group: "Taxes" },
];

interface TagOption {
  id: string;
  name: string;
  isActive: boolean;
}
interface ReportingTag {
  id: string;
  name: string;
  isActive: boolean;
  options: TagOption[];
}

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
  /** P&L narrowed to one tag option — a per-vehicle or per-shed view. */
  const [tagOptionId, setTagOptionId] = useState("");
  /** Tag Summary narrowed to a single dimension. */
  const [tagId, setTagId] = useState("");

  const { data: allTags } = useQuery({
    queryKey: ["reporting-tags"],
    queryFn: () => api<ReportingTag[]>("/api/reporting-tags"),
  });
  const tags = (allTags ?? [])
    .filter((t) => t.isActive)
    .map((t) => ({ ...t, options: t.options.filter((o) => o.isActive) }))
    .filter((t) => t.options.length > 0);

  const usesRange =
    active === "pnl" || active === "cash-flow" || active === "gst-summary" || active === "tag-summary";

  let params = usesRange ? `?from=${from}&to=${to}` : `?asOf=${to}`;
  if (active === "pnl" && tagOptionId) params += `&tagOptionId=${tagOptionId}`;
  if (active === "tag-summary" && tagId) params += `&tagId=${tagId}`;

  const { data, isLoading, error } = useQuery({
    queryKey: ["report", active, from, to, tagOptionId, tagId],
    queryFn: () => api<Record<string, unknown>>(`/api/reports/${active}${params}`),
  });

  const scopedOption = tags.flatMap((t) => t.options).find((o) => o.id === tagOptionId);

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

          {active === "pnl" && tags.length > 0 && (
            <select
              value={tagOptionId}
              onChange={(e) => setTagOptionId(e.target.value)}
              className="input w-auto py-1"
            >
              <option value="">Whole business</option>
              {tags.map((t) => (
                <optgroup key={t.id} label={t.name}>
                  {t.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}

          {active === "tag-summary" && tags.length > 1 && (
            <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="input w-auto py-1">
              <option value="">All tags</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {active === "pnl" && scopedOption && (
          <p className="mb-3 text-[13px] text-gray-600">
            Showing only amounts tagged{" "}
            <span className="font-medium text-gray-800">{scopedOption.name}</span>. Untagged income
            and costs are excluded, so this will not add up to the whole business.
          </p>
        )}
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
          <p className="text-[13px] text-gray-500">
            Nothing tagged in this period. Tag a journal line, an expense or a bill line and it
            will appear here.
          </p>
        );
      }
      const groups = [...new Set(rows.map((r) => r.tagName))];
      return (
        <>
          {groups.map((g) => {
            const groupRows = rows.filter((r) => r.tagName === g);
            const totalNet = groupRows.reduce((s, r) => s + Number(r.net), 0);
            return (
              <div key={g} className="mb-6">
                <h3 className="mb-2 border-b pb-1 text-sm font-semibold uppercase tracking-wide text-gray-600">
                  {g}
                </h3>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[#ebeaf2] text-left text-xs uppercase text-gray-500">
                      <th className="py-2">Option</th>
                      <th className="py-2 text-right">Income</th>
                      <th className="py-2 text-right">Expense</th>
                      <th className="py-2 text-right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map((r) => (
                      <tr key={r.optionName} className="border-b border-[#ebeaf2]">
                        <td className="py-1.5">
                          {r.optionName}
                          <span className="ml-2 text-[11px] text-gray-400">
                            {r.lineCount} line{r.lineCount === 1 ? "" : "s"}
                          </span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{formatMoney(r.income)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatMoney(r.expense)}</td>
                        <td
                          className={`py-1.5 text-right font-medium tabular-nums ${
                            Number(r.net) < 0 ? "text-red-700" : "text-green-700"
                          }`}
                        >
                          {formatMoney(r.net)}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="py-1.5">Total {g}</td>
                      <td />
                      <td />
                      <td className="py-1.5 text-right tabular-nums">{formatMoney(totalNet)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })}
          <p className="text-[12px] text-gray-500">
            Only tagged amounts appear here. A cost with no tag is still in the P&amp;L but belongs
            to no option, so these totals are not expected to reconcile to it.
          </p>
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
