import { type ReactNode, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

export interface ListView {
  label: string;
  /** Extra query params for this saved view, e.g. { status: "draft" }. */
  params: Record<string, string>;
}

interface ListPageProps<T> {
  title: string;
  endpoint: string;
  columns: Column<T>[];
  views?: ListView[];
  searchPlaceholder?: string;
  newLabel?: string;
  /** Route for the create form; renders the "+ New" button when set. */
  newPath?: string;
  onNew?: () => void;
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string;
}

/**
 * Zoho Books-style list view: saved-filter tabs across the top, search,
 * a "+ New" primary action, and a full-width data table.
 */
export function ListPage<T>({
  title,
  endpoint,
  columns,
  views,
  searchPlaceholder,
  newLabel,
  newPath,
  onNew,
  onRowClick,
  rowKey,
}: ListPageProps<T>) {
  const [, navigate] = useLocation();
  const [activeView, setActiveView] = useState(0);
  const [search, setSearch] = useState("");
  const handleNew = onNew ?? (newPath ? () => navigate(newPath) : undefined);

  const params = new URLSearchParams(views?.[activeView]?.params ?? {});
  if (search) params.set("search", search);
  const qs = params.toString();
  const url = qs ? `${endpoint}?${qs}` : endpoint;

  const { data, isLoading, error } = useQuery({
    queryKey: [endpoint, views?.[activeView]?.label ?? "all", search],
    queryFn: () => api<T[]>(url),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{title}</h1>
          {views && (
            <div className="flex gap-1 rounded-md bg-gray-100 p-0.5 text-[13px]">
              {views.map((v, i) => (
                <button
                  key={v.label}
                  onClick={() => setActiveView(i)}
                  className={`rounded px-2.5 py-1 ${
                    i === activeView ? "bg-white font-medium shadow-sm" : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {searchPlaceholder && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-56 rounded-md border px-3 py-1.5 text-[13px] focus:border-brand-500 focus:outline-none"
            />
          )}
          {handleNew && (
            <button
              onClick={handleNew}
              className="rounded-md bg-brand-500 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-brand-600"
            >
              + {newLabel ?? "New"}
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </div>
        ) : !data?.length ? (
          <div className="p-12 text-center text-sm text-gray-500">
            No records yet.
            {handleNew && (
              <button onClick={handleNew} className="ml-1 text-brand-600 hover:underline">
                Create the first one
              </button>
            )}
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={`border-b px-4 py-2.5 font-medium ${c.align === "right" ? "text-right" : ""}`}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={() => onRowClick?.(row)}
                  className={`border-b hover:bg-brand-50/40 ${onRowClick ? "cursor-pointer" : ""}`}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-4 py-2.5 ${c.align === "right" ? "text-right tabular-nums" : ""}`}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  sent: "bg-blue-50 text-blue-700",
  open: "bg-blue-50 text-blue-700",
  confirmed: "bg-blue-50 text-blue-700",
  issued: "bg-blue-50 text-blue-700",
  accepted: "bg-green-50 text-green-700",
  paid: "bg-green-50 text-green-700",
  closed: "bg-green-50 text-green-700",
  billed: "bg-green-50 text-green-700",
  partially_paid: "bg-amber-50 text-amber-700",
  partially_billed: "bg-amber-50 text-amber-700",
  declined: "bg-red-50 text-red-700",
  void: "bg-red-50 text-red-700",
  cancelled: "bg-red-50 text-red-700",
  reversed: "bg-red-50 text-red-700",
  expired: "bg-gray-100 text-gray-500",
  invoiced: "bg-green-50 text-green-700",
  posted: "bg-green-50 text-green-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
        STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
