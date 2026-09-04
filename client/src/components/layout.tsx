import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { LogoMark } from "./logo";
import { ChangePasswordModal } from "./change-password";
import {
  Banknote,
  BookOpen,
  Boxes,
  ChevronDown,
  ChevronRight,
  Home,
  Landmark,
  KeyRound,
  LogOut,
  PieChart,
  ScrollText,
  Settings,
  ShoppingCart,
  Users,
  Wheat,
  Bird,
  Menu,
  MoreHorizontal,
  X,
} from "lucide-react";
import { useAuth } from "../auth";
import { TopBar } from "./topbar";
import { SearchProvider } from "./search-context";

interface NavChild {
  label: string;
  path: string;
  /** [module, action] permission required to see this entry. */
  perm?: [string, string];
  /**
   * Any ONE of these is enough, for an entry several jobs share.
   *
   * The mill's overview is useful to a weighbridge operator and to a mill
   * manager, who hold no permission in common; gating it on either one alone
   * would hide the module's front door from half the people who work in it.
   */
  anyPerm?: Array<[string, string]>;
  /**
   * Open the module here.
   *
   * Without it a module opens on whichever page sorts first, which is how
   * Purchases opened on Vendors when the useful page is Bills, and Inventory
   * on Items when it is Stock on Hand.
   */
  home?: boolean;
}
interface NavItem {
  label: string;
  icon: typeof Home;
  path?: string;
  /**
   * [module, action] needed to see this entry at all.
   *
   * A group does not need one: it disappears when every child it holds has
   * been filtered away, which is the same answer arrived at from the children.
   */
  perm?: [string, string];
  children?: NavChild[];
}

const NAV: NavItem[] = [
  /**
   * Home reads across every module — farm, sales, purchases, people, feed
   * mill — so it follows the permission that means "may see the business as a
   * whole" rather than any one module's. A payroll clerk without it lands on
   * Payroll instead; see `landingPath` below.
   */
  { label: "Home", icon: Home, path: "/", perm: ["reports", "view"] },
  {
    // Items sits under Inventory: an item IS the thing stock is counted in, and
    // a group of its own for a single entry was a heading pretending to be a
    // module. Its paths stay at /items — a link to an item is quoted in a
    // hundred places and none of them get better for moving.
    label: "Inventory",
    icon: Boxes,
    children: [
      { label: "Items", path: "/items", perm: ["items", "view"] },
      { label: "Stock on Hand", path: "/inventory/stock", home: true, perm: ["items", "view"] },
      { label: "Adjustments", path: "/inventory/adjustments", perm: ["items", "view"] },
    ],
  },
  { label: "Banking", icon: Landmark, path: "/banking", perm: ["banking", "view"] },
  {
    label: "Sales",
    icon: Banknote,
    children: [
      /* The egg trade: the order book derives from agreements; the bay
         invoices what actually left. */
      { label: "Egg Calendar", path: "/sales/egg-calendar", perm: ["sales", "view"] },
      { label: "Loading Bay", path: "/sales/egg-loading", perm: ["sales", "view"] },
      { label: "Agreements", path: "/sales/egg-agreements", perm: ["sales", "view"] },
      { label: "Benchmark", path: "/sales/egg-benchmark", perm: ["sales", "view"] },
      { label: "Customers", path: "/sales/customers", perm: ["sales", "view"] },
      { label: "Invoices", path: "/sales/invoices", perm: ["sales", "view"] },
      { label: "Payments Received", path: "/sales/payments", perm: ["sales", "view"] },
      { label: "Credit Notes", path: "/sales/credit-notes", perm: ["sales", "view"] },
    ],
  },
  {
    label: "Purchases",
    icon: ShoppingCart,
    children: [
      { label: "Vendors", path: "/purchases/vendors", perm: ["purchases", "view"] },
      { label: "Expenses", path: "/purchases/expenses", perm: ["purchases", "view"] },
      { label: "Purchase Orders", path: "/purchases/orders", perm: ["purchases", "view"] },
      { label: "Bills", path: "/purchases/bills", home: true, perm: ["purchases", "view"] },
      { label: "Vendor Sheet", path: "/purchases/vendor-sheet", perm: ["purchases", "view"] },
      { label: "Payments Made", path: "/purchases/payments", perm: ["purchases", "view"] },
      { label: "Vendor Credits", path: "/purchases/vendor-credits", perm: ["purchases", "view"] },
    ],
  },
  {
    /**
     * One group, in the order the material moves.
     *
     * A lorry arrives, is weighed, is settled — and the same maize is then
     * formulated and milled. Splitting that into Office and Feed Mill made
     * somebody cross between two menus to follow one sack, and put the
     * weighbridge in a different module from the mill it feeds.
     *
     * The permission MODULES stay separate underneath: a gate operator has no
     * business issuing production, and one menu heading should not hand it to
     * them.
     */
    label: "Feed Mill",
    icon: Wheat,
    children: [
      {
        // First, so it is where the module opens: a mill hand wants the queues
        // before the job, the same way payroll opens on its overview.
        label: "Overview",
        path: "/feed-mill",
        home: true,
        anyPerm: [
          ["office", "view"],
          ["office", "gate_in"],
          ["office", "weighbridge"],
          ["office", "settle"],
          ["feed_mill", "view"],
          ["feed_mill", "produce"],
        ],
      },
      { label: "Gate In", path: "/office/gate", perm: ["office", "gate_in"] },
      /* Weigh In, QC, Weigh Out and Feed Transfer — four tabs on one page,
         because a truck walks them in a single visit. */
      { label: "Weighment", path: "/office/unloading", perm: ["office", "weighbridge"] },
      { label: "Settlement", path: "/office/settlement", perm: ["office", "settle"] },
      { label: "Goods Receipts", path: "/office/receipts", perm: ["office", "view"] },
      { label: "Formulas", path: "/feed-mill/formulas", perm: ["feed_mill", "view"] },
      { label: "Production", path: "/feed-mill/production", perm: ["feed_mill", "produce"] },
    ],
  },
  {
    /**
     * Farms is one entry, not a group: the board IS the module, and everything
     * else on it is reached from a house card or a flock. A menu of six farm
     * screens would mostly be links to things you get to by pointing at the
     * shed you were already looking at.
     */
    label: "Farms",
    icon: Bird,
    children: [
      { label: "Houses", path: "/farms", perm: ["farms", "view"] },
      /* A batch is not the shed's — it keeps one record across every shed it
         lives in, so it is made and listed on its own screen. Houses report
         what they happen to be holding. */
      { label: "Batches", path: "/farms/batches", perm: ["farms", "view"] },
      /* The packing room's day sheet: graded boxes per shed per size. Stock
         is one pool per size; the shed is a fact about the entry only. */
      { label: "Egg stock", path: "/farms/egg-stock", perm: ["farms", "view"] },
      /* The same core inventory, seen and handled at the farm gate. */
      { label: "Farm store", path: "/farms/store", perm: ["farms", "view"] },
      /* Field photos sent for a model's first opinion, with the flock record. */
      { label: "Dr niko", path: "/farms/dr-eggsy", perm: ["farms", "view"] },
    ],
  },
  {
    /**
     * People, in the order the day runs: who is here (Time, Gate), what they
     * are owed (Pay Inputs, Run, Wages), what they ate (Canteen), and the
     * hardware and masters behind it. Each entry carries its payroll action,
     * so a gate guard sees Gate and nothing else.
     */
    label: "Payroll",
    icon: Users,
    children: [
      { label: "Overview", path: "/payroll", perm: ["payroll", "view"] },
      { label: "Employees", path: "/payroll/employees", perm: ["payroll", "employees"] },
      { label: "Time", path: "/payroll/time", perm: ["payroll", "attendance"] },
      { label: "Gate", path: "/payroll/gate", perm: ["payroll", "gate"] },
      { label: "Pay Inputs", path: "/payroll/pay-inputs", perm: ["payroll", "pay_inputs"] },
      { label: "Run", path: "/payroll/run", perm: ["payroll", "run"] },
      { label: "Wages", path: "/payroll/wages", perm: ["payroll", "view"] },
      { label: "Canteen", path: "/payroll/canteen", perm: ["payroll", "canteen"] },
      { label: "Devices", path: "/payroll/devices", perm: ["payroll", "devices"] },
    ],
  },
  {
    label: "Accountant",
    icon: BookOpen,
    children: [
      /* Two of the sheds belong to Nandamuri and two to Luit, so feed, pullets
         and eggs are a trade between companies. Their ledger lives here, and
         they appear in no customer or vendor list anywhere else. */
      { label: "Group Companies", path: "/accountant/group-companies", perm: ["accounting", "view"] },
      { label: "Manual Journals", path: "/accountant/journals", perm: ["accounting", "view"] },
      { label: "Bulk Update", path: "/accountant/bulk-update", perm: ["accounting", "view"] },
      { label: "Chart of Accounts", path: "/accountant/accounts", home: true, perm: ["accounting", "view"] },
      { label: "Fixed Assets", path: "/accountant/assets", perm: ["accounting", "view"] },
      { label: "Budgets", path: "/accountant/budgets", perm: ["accounting", "view"] },
      { label: "Transaction Locking", path: "/accountant/transaction-locking", perm: ["accounting", "view"] },
    ],
  },
  { label: "Reports", icon: PieChart, path: "/reports", perm: ["reports", "view"] },
  { label: "Settings", icon: Settings, path: "/settings", perm: ["settings", "view"] },
];

const ADMIN_NAV: NavItem[] = [
  { label: "Activity Log", icon: ScrollText, path: "/activity-log" },
];

/** The most specific child of a group that the current URL sits under. */
function deepestChild(item: NavItem, location: string): string | null {
  return (item.children ?? []).reduce<string | null>(
    (best, c) =>
      location.startsWith(c.path) && (best == null || c.path.length > best.length) ? c.path : best,
    null,
  );
}

/**
 * The sidebar's contents, shared by the desktop rail and the mobile drawer.
 *
 * One copy, two placements — a second hand-maintained nav is a nav that drifts,
 * and a phone is where a missing entry is hardest to notice.
 */
function SidebarBody({
  navItems,
  location,
  openGroup,
  setOpenGroup,
  onNavigate,
  user,
  logout,
}: {
  navItems: NavItem[];
  location: string;
  openGroup: string | null;
  setOpenGroup: (v: string | null) => void;
  onNavigate: () => void;
  user: ReturnType<typeof useAuth>["user"];
  logout: () => Promise<void> | void;
}) {
  const isGroupActive = (item: NavItem) =>
    item.children?.some((c) => location.startsWith(c.path)) ?? false;

  // Lives here rather than in Settings: that section is behind the `settings`
  // permission, and everyone needs to be able to change their own password.
  const [pwOpen, setPwOpen] = useState(false);

  return (
    <>
      <div className="flex h-14 items-center px-4">
        {/* brand-500 rather than 600: the deeper step goes muddy on the rail's
            dark ground, in either accent. */}
        <LogoMark className="h-8" color="bg-brand-500" />
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
                    <Icon
                      size={16}
                      strokeWidth={1.8}
                      className={groupActive ? "text-brand-400" : ""}
                    />
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
                      // Longest match wins, so a child whose path is a prefix
                      // of a sibling's — "/items" beside "/items/quality-specs" —
                      // does not light up alongside it.
                      const active = c.path === deepestChild(item, location);
                      return (
                        <Link
                          key={c.path}
                          href={c.path}
                          onClick={onNavigate}
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
              onClick={onNavigate}
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
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-yolk-400 to-yolk-600 text-xs font-bold text-white">
            {user?.name?.[0]?.toUpperCase() ?? "U"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-white">{user?.name}</div>
            <div className="truncate text-[11px] text-gray-500">{user?.roleName}</div>
          </div>
          <button
            onClick={() => setPwOpen(true)}
            className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-sidebar-hover hover:text-white"
            title="Change password"
          >
            <KeyRound size={15} />
          </button>
          <button
            onClick={() => void logout()}
            className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-sidebar-hover hover:text-white"
            title="Sign out"
          >
            <LogOut size={15} />
          </button>
          {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
        </div>
      </div>
    </>
  );
}

/** A panel that slides up from the bottom of the screen. Phone-shaped. */
function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 lg:hidden" onClick={onClose}>
      <div className="fixed inset-0 bg-black/40" />
      <div
        className="safe-area-inset-bottom absolute bottom-0 left-0 right-0 max-h-[70vh] overflow-y-auto rounded-t-2xl bg-white p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { user, logout, can } = useAuth();
  const [openGroup, setOpenGroup] = useState<string | null>(() => {
    const active = NAV.find((n) => n.children?.some((c) => location.startsWith(c.path)));
    return active?.label ?? null;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const isGroupActive = (item: NavItem) =>
    item.children?.some((c) => location.startsWith(c.path)) ?? false;

  const isAdmin = user?.permissions["*"]?.includes("*") ?? false;
  const canSeeHome = isAdmin || can("reports", "view");
  // Permission-gated entries drop out per user; a group with nothing left
  // to show disappears entirely rather than sitting as an empty heading.
  const gated = NAV.map((item) =>
    item.children
      ? {
          ...item,
          children: item.children.filter(
            (c) =>
              (!c.perm || can(c.perm[0], c.perm[1])) &&
              (!c.anyPerm || c.anyPerm.some(([m, a]) => can(m, a))),
          ),
        }
      : item,
  )
    // A page the user cannot open has no business in the sidebar: every entry
    // led somewhere that refused them, which reads as a broken app rather than
    // as a boundary.
    .filter((item) => !item.perm || can(item.perm[0], item.perm[1]))
    .filter((item) => !item.children || item.children.length > 0);
  const navItems = isAdmin ? [...gated, ...ADMIN_NAV] : gated;

  /**
   * Where "/" should send someone who cannot see Home.
   *
   * The first entry they are allowed into, which for a payroll clerk is
   * Payroll Overview and for a farm hand is Houses. Null when the sidebar is
   * empty, which means a user with a role that grants nothing — a real state,
   * and one worth saying out loud rather than looping on a redirect.
   */
  const firstGroup = navItems.find((i) => i.children?.length);
  const landing =
    navItems.find((i) => i.path) ??
    firstGroup?.children?.find((c) => c.home) ??
    firstGroup?.children?.[0];
  const landingPath = landing?.path ?? null;
  useEffect(() => {
    if (location === "/" && !canSeeHome && landingPath && landingPath !== "/") {
      navigate(landingPath, { replace: true });
    }
  }, [location, canSeeHome, landingPath, navigate]);

  /**
   * The bottom bar carries the pages of the section you are IN, not the whole
   * app. On a phone the useful question is "where else in this module", and a
   * flat list of every module would sit Reports next to Gate In.
   */
  const activeGroup = navItems.find((i) => i.children && isGroupActive(i));
  const barItems = activeGroup
    ? activeGroup.children!.map((c) => ({
        label: c.label,
        path: c.path,
        icon: activeGroup.icon,
      }))
    : navItems.filter((i) => i.path).map((i) => ({ label: i.label, path: i.path!, icon: i.icon }));
  const bottomPages = barItems.slice(0, 4);
  const morePages = barItems.slice(4);

  const leaf = navItems.find(
    (i) => i.path && (i.path === "/" ? location === "/" : location.startsWith(i.path)),
  );
  const title = activeGroup?.label ?? leaf?.label ?? "niko";

  return (
    // The provider wraps both the top bar and the page, because the search box
    // lives in one and the list it searches lives in the other.
    <SearchProvider>
      <div className="flex h-screen overflow-hidden">
        {/* Desktop rail */}
        <aside className="hidden w-[218px] flex-col bg-sidebar text-gray-400 print:hidden lg:flex">
          <SidebarBody
            navItems={navItems}
            location={location}
            openGroup={openGroup}
            setOpenGroup={setOpenGroup}
            onNavigate={() => {}}
            user={user}
            logout={logout}
          />
        </aside>

        {/* Mobile drawer — the same rail, slid in over the page */}
        {drawerOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="fixed inset-0 bg-black/50" onClick={() => setDrawerOpen(false)} />
            <aside className="absolute left-0 top-0 flex h-full w-[264px] flex-col bg-sidebar text-gray-400 shadow-2xl">
              <SidebarBody
                navItems={navItems}
                location={location}
                openGroup={openGroup}
                setOpenGroup={setOpenGroup}
                onNavigate={() => setDrawerOpen(false)}
                user={user}
                logout={logout}
              />
            </aside>
          </div>
        )}

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Mobile top bar — hamburger and where you are */}
          <header className="flex h-14 items-center gap-2 border-b border-gray-200 bg-white px-3 lg:hidden">
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
            >
              <Menu size={20} />
            </button>
            <span className="flex-1 truncate text-[15px] font-semibold text-gray-900">{title}</span>
          </header>

          {/* The desktop bar carries search and the org switcher. On a phone it
              would take a third of the screen, so it stays behind lg. */}
          <div className="hidden lg:block">
            <TopBar />
          </div>

          {/* pb-24 clears the bottom bar. Without it the last row of every
              screen sits under the nav and cannot be tapped. */}
          <main className="flex-1 overflow-y-auto pb-24 lg:pb-0">{children}</main>
        </div>

        {/* Mobile bottom bar */}
        <nav className="safe-area-inset-bottom fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white print:hidden lg:hidden">
          <div className="flex h-16 items-center justify-around px-1">
            {bottomPages.map((page) => {
              const active = location.startsWith(page.path);
              const Icon = page.icon;
              return (
                <Link key={page.path} href={page.path}>
                  <div
                    className={`relative flex h-full min-w-[56px] flex-1 cursor-pointer flex-col items-center justify-center px-1 transition-colors ${
                      active ? "text-brand-600" : "text-gray-500"
                    }`}
                  >
                    <span
                      className={`absolute top-1 h-[3px] w-8 rounded-full transition-colors ${
                        active ? "bg-brand-600" : "bg-transparent"
                      }`}
                    />
                    <Icon size={20} className="mb-0.5" />
                    <span
                      className={`max-w-full truncate text-[11px] ${active ? "font-bold" : "font-medium"}`}
                    >
                      {page.label}
                    </span>
                  </div>
                </Link>
              );
            })}

            {morePages.length > 0 && (
              <button
                onClick={() => setMoreOpen(true)}
                className={`relative flex h-full min-w-[56px] flex-1 flex-col items-center justify-center px-1 transition-colors ${
                  morePages.some((p) => location.startsWith(p.path))
                    ? "text-brand-600"
                    : "text-gray-500"
                }`}
              >
                <span
                  className={`absolute top-1 h-[3px] w-8 rounded-full transition-colors ${
                    morePages.some((p) => location.startsWith(p.path))
                      ? "bg-brand-600"
                      : "bg-transparent"
                  }`}
                />
                <MoreHorizontal size={20} className="mb-0.5" />
                <span className="text-[11px] font-medium">More</span>
              </button>
            )}
          </div>
        </nav>

        {moreOpen && (
          <BottomSheet title="More" onClose={() => setMoreOpen(false)}>
            <div className="space-y-1">
              {morePages.map((page) => {
                const Icon = page.icon;
                return (
                  <Link key={page.path} href={page.path} onClick={() => setMoreOpen(false)}>
                    <div className="flex items-center gap-3 rounded-lg px-3 py-3 text-[14px] text-gray-800 hover:bg-gray-50">
                      <Icon size={18} className="text-gray-500" />
                      {page.label}
                    </div>
                  </Link>
                );
              })}
            </div>
          </BottomSheet>
        )}
      </div>
    </SearchProvider>
  );
}
