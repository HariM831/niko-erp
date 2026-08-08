import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api } from "../api";

interface ActivityRow {
  id: string;
  userName: string;
  action: string;
  resource: string;
  ipAddress?: string;
  createdAt: string;
}

const ACTION_STYLES: Record<string, string> = {
  POST: "bg-green-50 text-green-700",
  PATCH: "bg-amber-50 text-amber-700",
  PUT: "bg-amber-50 text-amber-700",
  DELETE: "bg-red-50 text-red-700",
};

/** Turn "/api/sales/invoices/uuid/send" into "sales · invoices · send". */
function humanResource(path: string): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return path
    .replace(/^\/api\//, "")
    .split("/")
    .filter((seg) => seg && !uuidRe.test(seg))
    .join(" · ");
}

export function ActivityLogPage() {
  const { data: rows, error } = useQuery({
    queryKey: ["activity-log"],
    queryFn: () => api<ActivityRow[]>("/api/activity-log"),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2.5 bg-white px-5 py-3.5">
        <span className="chip bg-brand-50 text-brand-600">
          <ShieldCheck size={17} />
        </span>
        <div>
          <h1 className="text-lg font-semibold leading-tight">Activity Log</h1>
          <p className="text-xs text-gray-400">Every change made in the organisation, newest first</p>
        </div>
      </header>
      <div className="flex-1 overflow-auto border-t">
        {error ? (
          <div className="p-8 text-center text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </div>
        ) : !rows?.length ? (
          <div className="p-12 text-center text-sm text-gray-500">No activity recorded yet.</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="table-head sticky top-0 z-10">
              <tr>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">Time</th>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">User</th>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">Action</th>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">Resource</th>
                <th className="border-b border-[#ebeaf2] px-4 py-2.5">IP Address</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-hover border-b border-[#ebeaf2]">
                  <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-gray-600">
                    {new Date(r.createdAt).toLocaleString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-brand-500 text-[10px] font-bold text-white">
                        {r.userName[0]?.toUpperCase()}
                      </span>
                      <span className="font-medium">{r.userName}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${ACTION_STYLES[r.action] ?? "bg-gray-100 text-gray-600"}`}
                    >
                      {r.action}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 capitalize text-gray-700">{humanResource(r.resource)}</td>
                  <td className="px-4 py-2.5 text-gray-400">{r.ipAddress ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
