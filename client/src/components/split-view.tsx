import { type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, formatMoney } from "../api";
import { StatusBadge } from "./list-page";
import { shortDate, type DocRow } from "../pages/documents";

interface SplitViewProps {
  /** List endpoint for the left rail. */
  endpoint: string;
  /** Base route, e.g. "/sales/invoices". */
  basePath: string;
  title: string;
  newPath: string;
  activeId: string;
  dateKey: string;
  children: ReactNode;
}

/**
 * Books-style split view: when a record is open, the list collapses into a
 * compact left rail (name, number, amount, status) with the record on the
 * right.
 */
export function DocumentSplitView({
  endpoint,
  basePath,
  title,
  newPath,
  activeId,
  dateKey,
  children,
}: SplitViewProps) {
  const [, navigate] = useLocation();
  const { data: rows } = useQuery({
    queryKey: [endpoint, "rail"],
    queryFn: () => api<DocRow[]>(endpoint),
  });

  return (
    <div className="flex h-full">
      <aside className="hidden w-72 shrink-0 flex-col border-r bg-white lg:flex print:hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <button
            onClick={() => navigate(basePath)}
            className="flex items-center gap-1 text-[15px] font-semibold text-gray-800 hover:text-brand-700"
          >
            All {title} <span className="text-[10px] text-brand-500">▼</span>
          </button>
          <button
            onClick={() => navigate(newPath)}
            className="rounded-md bg-brand-500 px-2.5 py-1 text-[13px] font-medium text-white hover:bg-brand-600"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {rows?.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`${basePath}/${r.id}`)}
              className={`block w-full border-b border-gray-100 px-4 py-3 text-left ${
                r.id === activeId ? "border-l-2 border-l-brand-500 bg-brand-50" : "hover:bg-gray-50"
              }`}
            >
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-gray-800">
                  {r.contactName ?? r.number}
                </span>
                <span className="shrink-0 text-[13px] font-medium tabular-nums">
                  {formatMoney((r.total ?? r.amount) as string)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
                <span className="truncate">
                  <span className="text-brand-600">{r.number}</span>
                  {" · "}
                  {shortDate(r[dateKey] as string)}
                </span>
                <StatusBadge status={r.status} />
              </div>
            </button>
          ))}
          {!rows?.length && (
            <p className="p-4 text-[13px] text-gray-400">No records.</p>
          )}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
