import { useQuery } from "@tanstack/react-query";
import { api, formatMoney } from "../api";

interface Aging {
  totals: Record<string, string>;
  grandTotal: string;
}

function AgingCard({ title, data }: { title: string; data?: Aging }) {
  const buckets = ["current", "1-15", "16-30", "31-45", "45+"];
  return (
    <div className="rounded-lg border bg-white p-5">
      <div className="mb-1 text-sm font-medium text-gray-600">{title}</div>
      <div className="mb-4 text-2xl font-semibold tabular-nums">
        {formatMoney(data?.grandTotal ?? 0)}
      </div>
      <div className="grid grid-cols-5 gap-2 text-center text-xs">
        {buckets.map((b) => (
          <div key={b}>
            <div className="mb-1 text-gray-500">{b === "current" ? "Current" : `${b} days`}</div>
            <div className="font-medium tabular-nums">{formatMoney(data?.totals[b] ?? 0)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HomePage() {
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
    queryFn: () => api<{ closing: string }>("/api/reports/cash-flow"),
  });

  return (
    <div className="p-6">
      <h1 className="mb-5 text-lg font-semibold">Dashboard</h1>
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AgingCard title="Total Receivables" data={ar} />
        <AgingCard title="Total Payables" data={ap} />
      </div>
      <div className="rounded-lg border bg-white p-5 lg:w-1/2">
        <div className="mb-1 text-sm font-medium text-gray-600">Cash & Bank</div>
        <div className="text-2xl font-semibold tabular-nums">{formatMoney(cash?.closing ?? 0)}</div>
      </div>
    </div>
  );
}
