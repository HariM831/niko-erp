/**
 * The one list of screens a role can be granted.
 *
 * The sidebar and the role editor each used to describe the app's pages in
 * their own words — the sidebar in paths and permission tuples, the editor in
 * abstract verbs like "Run the formulator". Nothing connected them, so the
 * only way to know what a tick actually revealed was to tick it and look.
 *
 * This is that connection. The sidebar builds itself from these entries and
 * the role editor names them, so a page cannot appear in a menu and be
 * invisible in the editor, or the reverse.
 *
 * It is a map of what is REVEALED, not of what is enforced. Authority still
 * lives on the server, one `requirePermission` per route. A page listed here
 * says "holding this right puts this screen in the menu" — never "holding it
 * is the only way to reach this data".
 */

/** A screen in the sidebar, and the right that reveals it. */
export interface AppPage {
  /** Stable id. Never a path — those move. */
  key: string;
  /** Exactly what the menu calls it. */
  label: string;
  path: string;
  /** The menu heading it sits under. */
  group: string;
  module: string;
  /**
   * The action that reveals it.
   *
   * `view` here means the page rides its module's read floor and is not
   * separately grantable — the editor says so rather than offering a tick
   * that silently reveals six other screens too.
   */
  action: string;
  /**
   * An overview that opens on whatever the holder may see. Revealed by any
   * one of these, so it needs no right of its own.
   */
  anyOf?: Array<[string, string]>;
  /** Sits behind a page rather than in the menu. */
  hidden?: boolean;
}

export const APP_PAGES: AppPage[] = [
  { key: "home", label: "Home", path: "/", group: "Home", module: "reports", action: "view" },

  // ── Inventory ──
  { key: "items", label: "Items", path: "/items", group: "Inventory", module: "items", action: "view" },
  { key: "stock", label: "Stock on Hand", path: "/inventory/stock", group: "Inventory", module: "items", action: "view" },
  { key: "adjustments", label: "Adjustments", path: "/inventory/adjustments", group: "Inventory", module: "items", action: "view" },

  { key: "banking", label: "Banking", path: "/banking", group: "Banking", module: "banking", action: "view" },

  // ── Sales ──
  { key: "egg-calendar", label: "Egg Calendar", path: "/sales/egg-calendar", group: "Sales", module: "sales", action: "view" },
  { key: "egg-loading", label: "Loading Bay", path: "/sales/egg-loading", group: "Sales", module: "sales", action: "view" },
  { key: "egg-agreements", label: "Agreements", path: "/sales/egg-agreements", group: "Sales", module: "sales", action: "view" },
  { key: "egg-benchmark", label: "Benchmark", path: "/sales/egg-benchmark", group: "Sales", module: "sales", action: "view" },
  { key: "customers", label: "Customers", path: "/sales/customers", group: "Sales", module: "sales", action: "view" },
  { key: "invoices", label: "Invoices", path: "/sales/invoices", group: "Sales", module: "sales", action: "view" },
  { key: "payments-received", label: "Payments Received", path: "/sales/payments", group: "Sales", module: "sales", action: "view" },
  { key: "credit-notes", label: "Credit Notes", path: "/sales/credit-notes", group: "Sales", module: "sales", action: "view" },

  // ── Purchases ──
  { key: "vendors", label: "Vendors", path: "/purchases/vendors", group: "Purchases", module: "purchases", action: "view" },
  { key: "expenses", label: "Expenses", path: "/purchases/expenses", group: "Purchases", module: "purchases", action: "view" },
  { key: "purchase-orders", label: "Purchase Orders", path: "/purchases/orders", group: "Purchases", module: "purchases", action: "view" },
  { key: "bills", label: "Bills", path: "/purchases/bills", group: "Purchases", module: "purchases", action: "view" },
  { key: "vendor-sheet", label: "Vendor Sheet", path: "/purchases/vendor-sheet", group: "Purchases", module: "purchases", action: "view" },
  { key: "payments-made", label: "Payments Made", path: "/purchases/payments", group: "Purchases", module: "purchases", action: "view" },
  { key: "vendor-credits", label: "Vendor Credits", path: "/purchases/vendor-credits", group: "Purchases", module: "purchases", action: "view" },

  /*
   * ── Feed Mill ──
   *
   * One menu, two permission modules. A lorry is weighed and settled by the
   * office; the same maize is then formulated and milled. Following one sack
   * across two menus was worse than the split underneath is confusing, and a
   * gate operator still has no business issuing production.
   *
   * Every entry here carries a right of its own — this is the one group where
   * a page can be granted without dragging its neighbours in with it.
   */
  {
    key: "feed-mill-overview",
    label: "Overview",
    path: "/feed-mill",
    group: "Feed Mill",
    module: "office",
    action: "view",
    anyOf: [
      ["office", "view"],
      ["office", "gate_in"],
      ["office", "weighbridge"],
      ["office", "settle"],
      ["office", "receipts"],
      ["feed_mill", "view"],
      ["feed_mill", "formulas"],
      ["feed_mill", "produce"],
    ],
  },
  { key: "gate-in", label: "Gate In", path: "/office/gate", group: "Feed Mill", module: "office", action: "gate_in" },
  { key: "weighment", label: "Weighment", path: "/office/unloading", group: "Feed Mill", module: "office", action: "weighbridge" },
  { key: "settlement", label: "Settlement", path: "/office/settlement", group: "Feed Mill", module: "office", action: "settle" },
  { key: "goods-receipts", label: "Goods Receipts", path: "/office/receipts", group: "Feed Mill", module: "office", action: "receipts" },
  { key: "formulas", label: "Formulas", path: "/feed-mill/formulas", group: "Feed Mill", module: "feed_mill", action: "formulas" },
  { key: "production", label: "Production", path: "/feed-mill/production", group: "Feed Mill", module: "feed_mill", action: "produce" },
  {
    key: "weighbridge-indicator",
    label: "Weighbridge indicator",
    path: "/office/weighbridge/indicator",
    group: "Feed Mill",
    module: "office",
    action: "weighbridge",
    hidden: true,
  },

  // ── Farms ──
  { key: "houses", label: "Houses", path: "/farms", group: "Farms", module: "farms", action: "view" },
  { key: "batches", label: "Batches", path: "/farms/batches", group: "Farms", module: "farms", action: "view" },
  { key: "egg-stock", label: "Egg stock", path: "/farms/egg-stock", group: "Farms", module: "farms", action: "view" },
  { key: "farm-store", label: "Farm store", path: "/farms/store", group: "Farms", module: "farms", action: "view" },
  { key: "dr-eggsy", label: "Dr niko", path: "/farms/dr-eggsy", group: "Farms", module: "farms", action: "view" },
  { key: "controls", label: "Controls", path: "/farms/controls", group: "Farms", module: "farms", action: "view" },

  // ── Payroll ──
  { key: "payroll-overview", label: "Overview", path: "/payroll", group: "Payroll", module: "payroll", action: "view" },
  { key: "employees", label: "Employees", path: "/payroll/employees", group: "Payroll", module: "payroll", action: "employees" },
  { key: "time", label: "Time", path: "/payroll/time", group: "Payroll", module: "payroll", action: "attendance" },
  { key: "gate", label: "Gate", path: "/payroll/gate", group: "Payroll", module: "payroll", action: "gate" },
  { key: "pay-inputs", label: "Pay Inputs", path: "/payroll/pay-inputs", group: "Payroll", module: "payroll", action: "pay_inputs" },
  { key: "payroll-run", label: "Run", path: "/payroll/run", group: "Payroll", module: "payroll", action: "run" },
  { key: "wages", label: "Wages", path: "/payroll/wages", group: "Payroll", module: "payroll", action: "view" },
  { key: "canteen", label: "Canteen", path: "/payroll/canteen", group: "Payroll", module: "payroll", action: "canteen" },
  { key: "devices", label: "Devices", path: "/payroll/devices", group: "Payroll", module: "payroll", action: "devices" },

  // ── Accountant ──
  { key: "group-companies", label: "Group Companies", path: "/accountant/group-companies", group: "Accountant", module: "accounting", action: "view" },
  { key: "journals", label: "Manual Journals", path: "/accountant/journals", group: "Accountant", module: "accounting", action: "view" },
  { key: "bulk-update", label: "Bulk Update", path: "/accountant/bulk-update", group: "Accountant", module: "accounting", action: "view" },
  { key: "accounts", label: "Chart of Accounts", path: "/accountant/accounts", group: "Accountant", module: "accounting", action: "view" },
  { key: "assets", label: "Fixed Assets", path: "/accountant/assets", group: "Accountant", module: "accounting", action: "view" },
  { key: "budgets", label: "Budgets", path: "/accountant/budgets", group: "Accountant", module: "accounting", action: "view" },
  { key: "transaction-locking", label: "Transaction Locking", path: "/accountant/transaction-locking", group: "Accountant", module: "accounting", action: "view" },

  { key: "reports", label: "Reports", path: "/reports", group: "Reports", module: "reports", action: "view" },
  { key: "settings", label: "Settings", path: "/settings", group: "Settings", module: "settings", action: "view" },
];

/** Pages a module owns, in menu order. */
export function pagesForModule(module: string): AppPage[] {
  return APP_PAGES.filter((p) => p.module === module && !p.hidden);
}

/**
 * Pages an action reveals.
 *
 * Several pages to one action is the normal case outside Feed Mill and
 * Payroll — every Sales screen rides `sales.view` — and the editor has to say
 * so, because a tick that reveals eight screens while naming one is worse than
 * no label at all.
 */
export function pagesForAction(module: string, action: string): AppPage[] {
  return APP_PAGES.filter(
    (p) => p.module === module && p.action === action && !p.hidden && !p.anyOf,
  );
}

/**
 * Overviews, which open on whatever their holder may already see.
 *
 * Kept out of `pagesForAction` on purpose: listing one under a single action
 * would claim that action is what reveals it, when any right in the menu does.
 */
export function overviewPagesForModule(module: string): AppPage[] {
  return APP_PAGES.filter((p) => p.module === module && !!p.anyOf && !p.hidden);
}
