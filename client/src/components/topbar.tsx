import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
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
    ],
  },
];

export function TopBar() {
  const [, navigate] = useLocation();
  const { user, logout } = useAuth();
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
    <div className="flex h-12 items-center justify-between border-b bg-white px-4 print:hidden">
      <div className="flex items-center gap-3">
        <span className="text-[13px] font-medium text-gray-700">
          {org?.name || "Eggsy Books"}
        </span>
      </div>
      <div className="flex items-center gap-3" ref={ref}>
        <div className="relative">
          <button
            onClick={() => setOpen((o) => !o)}
            className="grid h-8 w-8 place-items-center rounded-md bg-brand-500 text-lg font-semibold text-white hover:bg-brand-600"
            title="Quick create"
          >
            +
          </button>
          {open && (
            <div className="absolute right-0 top-10 z-20 flex w-[430px] gap-2 rounded-lg border bg-white p-4 shadow-lg">
              {QUICK_CREATE.map((g) => (
                <div key={g.group} className="flex-1">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {g.group}
                  </div>
                  {g.items.map((it) => (
                    <button
                      key={it.path}
                      onClick={() => {
                        setOpen(false);
                        navigate(it.path);
                      }}
                      className="block w-full rounded px-2 py-1 text-left text-[13px] hover:bg-brand-50 hover:text-brand-700"
                    >
                      + {it.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 text-[13px] text-gray-600">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-gray-200 text-xs font-semibold text-gray-700">
            {user?.name?.[0]?.toUpperCase() ?? "U"}
          </span>
          <button onClick={() => void logout()} className="text-gray-400 hover:text-gray-700" title="Sign out">
            ⎋
          </button>
        </div>
      </div>
    </div>
  );
}
