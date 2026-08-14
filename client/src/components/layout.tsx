import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Banknote,
  BookOpen,
  Boxes,
  ChevronDown,
  ChevronRight,
  Home,
  Landmark,
  LogOut,
  Package,
  PieChart,
  ScrollText,
  Settings,
  ShoppingCart,
} from "lucide-react";
import { useAuth } from "../auth";
import { TopBar } from "./topbar";
import { SearchProvider } from "./search-context";

interface NavChild {
  label: string;
  path: string;
}
interface NavItem {
  label: string;
  icon: typeof Home;
  path?: string;
  children?: NavChild[];
}

const NAV: NavItem[] = [
  { label: "Home", icon: Home, path: "/" },
  { label: "Items", icon: Package, path: "/items" },
  {
    label: "Inventory",
    icon: Boxes,
    children: [
      { label: "Stock on Hand", path: "/inventory/stock" },
      { label: "Adjustments", path: "/inventory/adjustments" },
    ],
  },
  { label: "Banking", icon: Landmark, path: "/banking" },
  {
    label: "Sales",
    icon: Banknote,
    children: [
      { label: "Customers", path: "/sales/customers" },
      { label: "Invoices", path: "/sales/invoices" },
      { label: "Payments Received", path: "/sales/payments" },
      { label: "Credit Notes", path: "/sales/credit-notes" },
    ],
  },
  {
    label: "Purchases",
    icon: ShoppingCart,
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
    icon: BookOpen,
    children: [
      { label: "Manual Journals", path: "/accountant/journals" },
      { label: "Bulk Update", path: "/accountant/bulk-update" },
      { label: "Chart of Accounts", path: "/accountant/accounts" },
      { label: "Fixed Assets", path: "/accountant/assets" },
      { label: "Budgets", path: "/accountant/budgets" },
      { label: "Transaction Locking", path: "/accountant/transaction-locking" },
    ],
  },
  { label: "Reports", icon: PieChart, path: "/reports" },
  { label: "Settings", icon: Settings, path: "/settings" },
];

const ADMIN_NAV: NavItem[] = [
  { label: "Activity Log", icon: ScrollText, path: "/activity-log" },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [openGroup, setOpenGroup] = useState<string | null>(() => {
    const active = NAV.find((n) => n.children?.some((c) => location.startsWith(c.path)));
    return active?.label ?? null;
  });

  const isGroupActive = (item: NavItem) =>
    item.children?.some((c) => location.startsWith(c.path)) ?? false;

  const isAdmin = user?.permissions["*"]?.includes("*") ?? false;
  const navItems = isAdmin ? [...NAV, ...ADMIN_NAV] : NAV;

  return (
    // The provider wraps both the top bar and the page, because the search box
    // lives in one and the list it searches lives in the other.
    <SearchProvider>
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-[218px] flex-col bg-sidebar text-gray-400 print:hidden">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-[15px] font-extrabold text-white shadow-md">
            E
          </span>
          <span className="text-[15px] font-bold tracking-tight text-white">Eggsy Books</span>
        </div>
        <nav className="flex-1 overflow-y-auto px-2.5 py-2 text-[13px]">
          {navItems.map((item) => {
            const Icon = item.icon;
            if (item.children) {
              const groupActive = isGroupActive(item);
              const open = openGroup === item.label;
              return (
                <div key={item.label} className="mb-0.5">
                  <button
                    onClick={() => setOpenGroup(open ? null : item.label)}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 font-medium transition-colors duration-150 ${
                      groupActive && !open
                        ? "bg-sidebar-hover text-white"
                        : "hover:bg-sidebar-hover hover:text-gray-200"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon size={16} strokeWidth={1.8} className={groupActive ? "text-brand-400" : ""} />
                      {item.label}
                    </span>
                    {open ? (
                      <ChevronDown size={13} className="opacity-50" />
                    ) : (
                      <ChevronRight size={13} className="opacity-50" />
                    )}
                  </button>
                  {open && (
                    <div className="mb-1 mt-0.5 space-y-0.5">
                      {item.children.map((c) => {
                        const active = location.startsWith(c.path);
                        return (
                          <Link
                            key={c.path}
                            href={c.path}
                            className={`block rounded-lg py-[7px] pl-[38px] pr-2.5 transition-colors duration-150 ${
                              active
                                ? "bg-brand-500 font-semibold text-white shadow-sm"
                                : "hover:bg-sidebar-hover hover:text-gray-200"
                            }`}
                          >
                            {c.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
            const active = item.path === "/" ? location === "/" : location.startsWith(item.path!);
            return (
              <Link
                key={item.label}
                href={item.path!}
                className={`mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 font-medium transition-colors duration-150 ${
                  active
                    ? "bg-brand-500 text-white shadow-sm"
                    : "hover:bg-sidebar-hover hover:text-gray-200"
                }`}
              >
                <Icon size={16} strokeWidth={1.8} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-brand-500 text-xs font-bold text-white">
              {user?.name?.[0]?.toUpperCase() ?? "U"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-white">{user?.name}</div>
              <div className="truncate text-[11px] text-gray-500">{user?.roleName}</div>
            </div>
            <button
              onClick={() => void logout()}
              className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-sidebar-hover hover:text-white"
              title="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
    </SearchProvider>
  );
}
