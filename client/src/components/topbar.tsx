import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronDown, Plus, Search } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";

const QUICK_CREATE: Array<{ group: string; items: Array<{ label: string; path: string }> }> = [
  {
    group: "Sales",
    items: [
      { label: "Invoice", path: "/sales/invoices/new" },
      { label: "Estimate", path: "/sales/estimates/new" },
      { label: "Sales Order", path: "/sales/sales-orders/new" },
      { label: "Payment Received", path: "/sales/payments/new" },
      { label: "Credit Note", path: "/sales/credit-notes/new" },
      { label: "Customer", path: "/sales/customers/new" },
    ],
  },
  {
    group: "Purchases",
    items: [
      { label: "Bill", path: "/purchases/bills/new" },
      { label: "Purchase Order", path: "/purchases/orders/new" },
      { label: "Payment Made", path: "/purchases/payments/new" },
      { label: "Expense", path: "/purchases/expenses/new" },
      { label: "Vendor Credit", path: "/purchases/vendor-credits/new" },
      { label: "Vendor", path: "/purchases/vendors/new" },
    ],
  },
  {
    group: "Other",
    items: [
      { label: "Item", path: "/items/new" },
      { label: "Journal Entry", path: "/accountant/journals/new" },
      { label: "Bank Account", path: "/banking/new" },
    ],
  },
];

export function TopBar() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: org } = useQuery({
    queryKey: ["org"],
    queryFn: () => api<{ name: string } | null>("/api/settings/org"),
  });

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="flex h-[52px] items-center justify-between gap-4 border-b border-gray-200 bg-white pl-5 pr-4 print:hidden">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="relative w-full max-w-md">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            placeholder="Search in Customers ( / )"
            className="w-full rounded-lg border border-gray-200 bg-gray-50 py-[7px] pl-9 pr-3 text-[13px] transition-colors placeholder:text-gray-400 focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5" ref={ref}>
        <button className="btn-ghost hidden items-center gap-1 font-semibold text-gray-700 sm:flex">
          {org?.name || "Eggsy Books"}
          <ChevronDown size={13} className="text-gray-400" />
        </button>

        <div className="relative">
          <button
            onClick={() => setOpen((o) => !o)}
            className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-white shadow-sm transition-all duration-150 hover:bg-brand-600 hover:shadow-md"
            title="Quick create"
          >
            <Plus size={17} strokeWidth={2.5} />
          </button>
          {open && (
            <div className="absolute right-0 top-11 z-30 flex w-[460px] gap-1 rounded-xl border border-gray-100 bg-white p-4 shadow-xl">
              {QUICK_CREATE.map((g) => (
                <div key={g.group} className="flex-1">
                  <div className="mb-1.5 px-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">
                    {g.group}
                  </div>
                  {g.items.map((it) => (
                    <button
                      key={it.path}
                      onClick={() => {
                        setOpen(false);
                        navigate(it.path);
                      }}
                      className="flex w-full items-center gap-1.5 rounded-lg px-2 py-[7px] text-left text-[13px] text-gray-700 transition-colors hover:bg-brand-50 hover:text-brand-700"
                    >
                      <Plus size={12} className="text-brand-500" />
                      {it.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <button className="btn-ghost relative p-2" title="Notifications">
          <Bell size={16} />
        </button>

        <span className="ml-1 grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-brand-500 text-xs font-bold text-white">
          {user?.name?.[0]?.toUpperCase() ?? "U"}
        </span>
      </div>
    </div>
  );
}
