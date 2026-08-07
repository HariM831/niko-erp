import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "../auth";

interface NavChild {
  label: string;
  path: string;
}
interface NavItem {
  label: string;
  icon: string;
  path?: string;
  children?: NavChild[];
}

/** Zoho Books-style module tree: Home, Items, Banking, Sales, Purchases, Accountant, Reports. */
const NAV: NavItem[] = [
  { label: "Home", icon: "⌂", path: "/" },
  { label: "Items", icon: "▤", path: "/items" },
  { label: "Banking", icon: "🏦", path: "/banking" },
  {
    label: "Sales",
    icon: "₹",
    children: [
      { label: "Customers", path: "/sales/customers" },
      { label: "Estimates", path: "/sales/estimates" },
      { label: "Sales Orders", path: "/sales/sales-orders" },
      { label: "Invoices", path: "/sales/invoices" },
      { label: "Payments Received", path: "/sales/payments" },
      { label: "Credit Notes", path: "/sales/credit-notes" },
    ],
  },
  {
    label: "Purchases",
    icon: "🛒",
    children: [
      { label: "Vendors", path: "/purchases/vendors" },
      { label: "Expenses", path: "/purchases/expenses" },
      { label: "Purchase Orders", path: "/purchases/orders" },
      { label: "Bills", path: "/purchases/bills" },
      { label: "Payments Made", path: "/purchases/payments" },
      { label: "Vendor Credits", path: "/purchases/vendor-credits" },
    ],
  },
  {
    label: "Accountant",
    icon: "☰",
    children: [
      { label: "Manual Journals", path: "/accountant/journals" },
      { label: "Chart of Accounts", path: "/accountant/accounts" },
    ],
  },
  { label: "Reports", icon: "▦", path: "/reports" },
  { label: "Settings", icon: "⚙", path: "/settings" },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [openGroup, setOpenGroup] = useState<string | null>(() => {
    const active = NAV.find((n) => n.children?.some((c) => location.startsWith(c.path)));
    return active?.label ?? null;
  });

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 flex-col bg-sidebar text-gray-300">
        <div className="flex h-14 items-center gap-2 border-b border-white/10 px-4">
          <span className="grid h-8 w-8 place-items-center rounded bg-brand-500 font-bold text-white">
            E
          </span>
          <span className="text-[15px] font-semibold text-white">Eggsy Books</span>
        </div>
        <nav className="flex-1 overflow-y-auto py-2 text-[13px]">
          {NAV.map((item) =>
            item.children ? (
              <div key={item.label}>
                <button
                  onClick={() => setOpenGroup(openGroup === item.label ? null : item.label)}
                  className="flex w-full items-center justify-between px-4 py-2 hover:bg-sidebar-hover"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="w-4 text-center opacity-70">{item.icon}</span>
                    {item.label}
                  </span>
                  <span className="text-[10px] opacity-60">
                    {openGroup === item.label ? "▾" : "▸"}
                  </span>
                </button>
                {openGroup === item.label &&
                  item.children.map((c) => (
                    <Link
                      key={c.path}
                      href={c.path}
                      className={`block py-1.5 pl-[42px] pr-4 hover:bg-sidebar-hover ${
                        location.startsWith(c.path)
                          ? "border-l-2 border-brand-500 bg-sidebar-hover text-white"
                          : ""
                      }`}
                    >
                      {c.label}
                    </Link>
                  ))}
              </div>
            ) : (
              <Link
                key={item.label}
                href={item.path!}
                className={`flex items-center gap-2.5 px-4 py-2 hover:bg-sidebar-hover ${
                  location === item.path ? "border-l-2 border-brand-500 bg-sidebar-hover text-white" : ""
                }`}
              >
                <span className="w-4 text-center opacity-70">{item.icon}</span>
                {item.label}
              </Link>
            ),
          )}
        </nav>
        <div className="border-t border-white/10 p-3 text-xs">
          <div className="mb-1 font-medium text-white">{user?.name}</div>
          <div className="mb-2 opacity-60">{user?.roleName}</div>
          <button onClick={() => void logout()} className="text-brand-100 hover:underline">
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
