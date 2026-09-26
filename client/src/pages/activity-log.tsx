import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api } from "../api";
import { useAdvancedSearch, type SearchField } from "../components/advanced-search";
import { SortTh, useSortedRows } from "../components/sortable-table";

interface ActivityRow {
  id: string;
  userName: string;
  action: string;
  resource: string;
  ipAddress?: string;
  createdAt: string;
}

const TH_CELL = "border-b border-[#ece3d5] px-4 py-2.5";

/** What each column sorts on — the row's own field, never the rendered cell. */
const ACTIVITY_SORTS = {
  time: (r: ActivityRow) => r.createdAt,
  user: (r: ActivityRow) => r.userName,
  action: (r: ActivityRow) => r.action,
  resource: (r: ActivityRow) => r.resource,
  ip: (r: ActivityRow) => r.ipAddress,
};

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
  // Every user on file, departed ones too: the log outlives the accounts.
  const { data: users } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ id: string; name: string; username: string }[]>("/api/users"),
  });
  const fields = useMemo<SearchField[]>(
    () => [
      { key: "userId", label: "User", kind: "select", options: (users ?? []).map((u) => ({ value: u.id, label: u.name })) },
      {
        key: "action",
        label: "Action",
        kind: "select",
        options: [
          { value: "POST", label: "Created (POST)" },
          { value: "PATCH", label: "Edited (PATCH)" },
          { value: "PUT", label: "Replaced (PUT)" },
          { value: "DELETE", label: "Deleted (DELETE)" },
        ],
      },
      { key: "date", label: "Date Range", kind: "dateRange" },
      { key: "resource", label: "Resource", kind: "text" },
      { key: "ip", label: "IP Address", kind: "text" },
    ],
    [users],
  );
  // The log is capped at the latest 300, so the search is the server's.
  const adv = useAdvancedSearch("Activity Log", fields);
  const qs = new URLSearchParams(adv.criteria).toString();
  const { data: unsorted, error } = useQuery({
    queryKey: ["activity-log", qs],
    queryFn: () => api<ActivityRow[]>(`/api/activity-log${qs ? `?${qs}` : ""}`),
  });
  // Newest first until a header says otherwise. Time sorts on the raw
  // timestamp, not on the "26 Sep, 09:14" the cell shows.
  const { rows, sort, toggle } = useSortedRows(unsorted, ACTIVITY_SORTS);

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex items-center gap-2.5 px-5 py-3.5">
        <span className="chip bg-brand-50 text-brand-600">
          <ShieldCheck size={17} />
        </span>
        <div>
          <h1 className="text-lg font-semibold leading-tight">Activity Log</h1>
          </div>
        <div className="ml-auto">{adv.button}</div>
      </header>
      {adv.dialog}
      <div className="flex-1 overflow-auto border-t">
        {error ? (
          <div className="p-8 text-center text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </div>
        ) : !rows?.length ? (
          <div className="p-12 text-center text-sm text-gray-500">
            {adv.active ? "No activity matches the search." : "No activity recorded yet."}
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="table-head sticky top-0 z-10">
              <tr>
                <SortTh k="time" sort={sort} toggle={toggle} className={TH_CELL}>Time</SortTh>
                <SortTh k="user" sort={sort} toggle={toggle} className={TH_CELL}>User</SortTh>
                <SortTh k="action" sort={sort} toggle={toggle} className={TH_CELL}>Action</SortTh>
                <SortTh k="resource" sort={sort} toggle={toggle} className={TH_CELL}>Resource</SortTh>
                <SortTh k="ip" sort={sort} toggle={toggle} className={TH_CELL}>IP Address</SortTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-hover border-b border-[#ece3d5]">
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
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-yolk-400 to-yolk-600 text-[10px] font-bold text-white">
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
