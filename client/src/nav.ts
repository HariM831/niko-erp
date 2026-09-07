/**
 * The sidebar, as data.
 *
 * Its own module rather than a const inside the layout, so that
 * `scripts/check-pages.ts` can read it without dragging in a React tree and
 * the logo PNG behind it. A menu that cannot be inspected by a check is a menu
 * that drifts from `shared/pages.ts`, and then the role editor starts
 * describing screens that are not where it says they are.
 */
import {
  Banknote,
  BookOpen,
  Boxes,
  Home,
  Landmark,
  PieChart,
  ScrollText,
  Settings,
  ShoppingCart,
  Users,
  Wheat,
  Bird,
} from "lucide-react";

export interface NavChild {
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
export interface NavItem {
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

export const NAV: NavItem[] = [
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
          ["office", "receipts"],
          ["feed_mill", "view"],
          ["feed_mill", "formulas"],
          ["feed_mill", "produce"],
        ],
      },
      { label: "Gate In", path: "/office/gate", perm: ["office", "gate_in"] },
      /* Weigh In, QC, Weigh Out and Feed Transfer — four tabs on one page,
         because a truck walks them in a single visit. */
      { label: "Weighment", path: "/office/unloading", perm: ["office", "weighbridge"] },
      { label: "Settlement", path: "/office/settlement", perm: ["office", "settle"] },
      { label: "Goods Receipts", path: "/office/receipts", perm: ["office", "receipts"] },
      { label: "Formulas", path: "/feed-mill/formulas", perm: ["feed_mill", "formulas"] },
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
      /* What each shed's controller is set to, in niko's words, and what
         changed on the panel. Reads everything; writes come in a later stage. */
      { label: "Controls", path: "/farms/controls", perm: ["farms", "view"] },
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
