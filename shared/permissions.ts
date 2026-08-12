/**
 * The permission vocabulary shared by the RBAC gate, the role editor, and
 * validation. A role's `permissions` is a { module: actions[] } map; "*" as
 * either a module or an action grants everything.
 *
 * Adding an operational module (farms, feed mill, procurement, payroll) is a
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
  /** Actions this module supports, defaulting to the standard four. */
  actions?: string[];
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

const MODULE_KEYS = new Set(PERMISSION_MODULES.map((m) => m.key));
const ACTION_KEYS = new Set(PERMISSION_ACTIONS.map((a) => a.key));

/** Does this permission map grant everything? */
export function isAdminMap(permissions: Record<string, string[]>): boolean {
  return permissions["*"]?.includes("*") ?? false;
}

/**
 * Drop anything not in the catalogue so a stored map can never grant a module
 * that no longer exists. The admin wildcard is preserved as-is.
 */
export function sanitisePermissions(
  input: Record<string, string[]>,
): Record<string, string[]> {
  if (isAdminMap(input)) return { "*": ["*"] };
  const out: Record<string, string[]> = {};
  for (const [module, actions] of Object.entries(input)) {
    if (!MODULE_KEYS.has(module)) continue;
    const kept = [...new Set(actions)].filter((a) => a === "*" || ACTION_KEYS.has(a));
    if (kept.length) out[module] = kept.includes("*") ? ["*"] : kept;
  }
  return out;
}

/** Actions a role actually holds on a module, expanding the wildcards. */
export function effectiveActions(
  permissions: Record<string, string[]>,
  module: string,
): string[] {
  if (isAdminMap(permissions)) return PERMISSION_ACTIONS.map((a) => a.key);
  const actions = permissions[module];
  if (!actions) return [];
  if (actions.includes("*")) return PERMISSION_ACTIONS.map((a) => a.key);
  return actions;
}
