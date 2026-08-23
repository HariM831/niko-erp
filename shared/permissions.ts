/**
 * The permission vocabulary shared by the RBAC gate, the role editor, and
 * validation. A role's `permissions` is a { module: actions[] } map; "*" as
 * either a module or an action grants everything.
 *
 * Adding an operational module (farms, feed mill, office, payroll) is a
 * one-line edit here — the role editor renders whatever this lists, so no UI
 * change is needed.
 */

export interface PermissionAction {
  key: string;
  label: string;
}

export interface PermissionModule {
  key: string;
  label: string;
  description: string;
  /**
   * Actions this module supports, defaulting to the standard four.
   *
   * An operational module often has nothing to do with create/edit/delete. The
   * six office stations are each a separate job done by a separate person,
   * and a weighbridge operator must not be able to settle a bill — so the
   * module names its own verbs and the role editor renders those instead.
   */
  actions?: PermissionAction[];
}

export const PERMISSION_ACTIONS: PermissionAction[] = [
  { key: "view", label: "View" },
  { key: "create", label: "Create" },
  { key: "edit", label: "Edit" },
  { key: "delete", label: "Delete" },
];

export const PERMISSION_MODULES: PermissionModule[] = [
  {
    key: "sales",
    label: "Sales",
    description: "Customers, invoices, payments received, credit notes",
  },
  {
    key: "purchases",
    label: "Purchases",
    description: "Vendors, bills, purchase orders, expenses, payments made",
  },
  {
    key: "items",
    label: "Items & Inventory",
    description: "Item catalogue, stock on hand, inventory adjustments",
  },
  {
    key: "banking",
    label: "Banking",
    description: "Bank accounts, statement import, reconciliation",
  },
  {
    key: "accounting",
    label: "Accountant",
    description: "Chart of accounts, manual journals, fixed assets, budgets, locking",
  },
  {
    key: "farms",
    label: "Farms",
    description: "Houses, flocks, daily records, feed, weighings, health",
    actions: [
      { key: "view", label: "View" },
      { key: "record", label: "Record a day" },
      { key: "flocks", label: "Place, transfer and deplete flocks" },
      { key: "health", label: "Vaccinations and medication" },
      { key: "manage", label: "Houses, breeds and standards" },
    ],
  },
  {
    key: "office",
    label: "Office",
    description: "Goods receipts: gate in, weighment, QC, settlement",
    actions: [
      { key: "view", label: "View" },
      { key: "gate_in", label: "Gate In" },
      { key: "weighbridge", label: "Weighbridge" },
      { key: "quality_control", label: "QC" },
      { key: "unloading", label: "Unloading" },
      { key: "settle", label: "Settle" },
      // Not a role name. "Needs a supervisor" has to be a concrete check, or it
      // degrades into whoever happens to be holding the tablet.
      { key: "override", label: "Override" },
      // Deliberately not folded into "settle". Settling applies the rules to
      // one truck; this writes the rules that will apply to every truck. The
      // clerk who does the first should not silently be able to do the second.
      { key: "manage_rules", label: "Manage deduction rules" },
    ],
  },
  {
    key: "feed_mill",
    label: "Feed Mill",
    description: "Nutrient profiles, feed standards, formulas, production and feed transfers",
    actions: [
      { key: "view", label: "View" },
      // Naming what a material is made of is a nutritionist's job, and a
      // least-cost mix is only as good as the analysis behind it.
      { key: "nutrients", label: "Edit nutrient profiles" },
      { key: "formulate", label: "Run the formulator" },
      // Writing a recipe is not the same as running one. The floor produces to
      // a formula; changing the formula is a different authority.
      { key: "manage_formulas", label: "Write formulas" },
      { key: "produce", label: "Issue and complete production" },
      { key: "transfer", label: "Transfer feed to a shed" },
    ],
  },
  {
    key: "payroll",
    label: "Payroll",
    description: "Employees, attendance, leave, pay inputs, salary runs, devices and canteen",
    actions: [
      { key: "view", label: "View" },
      { key: "employees", label: "Manage employees" },
      // Marking a day and approving a leave are the same authority: deciding
      // what a person is paid for.
      { key: "attendance", label: "Attendance and leave" },
      { key: "pay_inputs", label: "Bonuses, overtime, advances, claims" },
      // Running payroll moves money into the ledger; nobody else's verb.
      { key: "run", label: "Run and confirm payroll" },
      { key: "gate", label: "Gate kiosk and face enrolment" },
      { key: "canteen", label: "Canteen" },
      { key: "devices", label: "Pair and revoke devices" },
      { key: "settings", label: "Shifts, holidays, rates, departments" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    description: "Profit & loss, balance sheet, cash flow, ageing",
  },
  {
    key: "settings",
    label: "Settings",
    description: "Organisation profile, taxes, number series, users and roles",
  },
];

const BY_KEY = new Map(PERMISSION_MODULES.map((m) => [m.key, m]));

/**
 * The actions a given module understands.
 *
 * Resolved per module, never from one global list: a module that names its own
 * verbs would otherwise have them silently stripped on save, and a wildcard
 * would expand to four actions the module does not have.
 */
export function actionsFor(module: string): PermissionAction[] {
  return BY_KEY.get(module)?.actions ?? PERMISSION_ACTIONS;
}

/** True when this module uses verbs of its own rather than the standard four. */
export function hasCustomActions(module: string): boolean {
  return BY_KEY.get(module)?.actions !== undefined;
}

/** Does this permission map grant everything? */
export function isAdminMap(permissions: Record<string, string[]>): boolean {
  return permissions["*"]?.includes("*") ?? false;
}

/**
 * Drop anything not in the catalogue so a stored map can never grant a module
 * that no longer exists, or an action that module never had. The admin wildcard
 * is preserved as-is.
 */
export function sanitisePermissions(
  input: Record<string, string[]>,
): Record<string, string[]> {
  if (isAdminMap(input)) return { "*": ["*"] };
  const out: Record<string, string[]> = {};
  for (const [module, actions] of Object.entries(input)) {
    if (!BY_KEY.has(module)) continue;
    const allowed = new Set(actionsFor(module).map((a) => a.key));
    const kept = [...new Set(actions)].filter((a) => a === "*" || allowed.has(a));
    if (kept.length) out[module] = kept.includes("*") ? ["*"] : kept;
  }
  return out;
}

/** Actions a role actually holds on a module, expanding the wildcards. */
export function effectiveActions(
  permissions: Record<string, string[]>,
  module: string,
): string[] {
  const all = () => actionsFor(module).map((a) => a.key);
  if (isAdminMap(permissions)) return all();
  const actions = permissions[module];
  if (!actions) return [];
  if (actions.includes("*")) return all();
  return actions;
}
