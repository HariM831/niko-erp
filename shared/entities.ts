/**
 * The one list of things a document-shaped record can be.
 *
 * Attachments, comments, number series and custom fields each used to keep
 * their own copy of this, which is how "estimate" survived in three places
 * after the module was deleted. Everything references this instead.
 */

export interface EntityDef {
  key: string;
  /** Singular, as shown in settings and dialogs. */
  label: string;
  /** Plural, for list headings. */
  plural: string;
  /** Which permission module governs it. */
  module: string;
  /** Documents take a number from a series; master data does not. */
  numbered: boolean;
  /** Master data can be the target of a lookup field. */
  lookupTarget: boolean;
}

export const ENTITIES: EntityDef[] = [
  {
    key: "contact",
    label: "Customer / Vendor",
    plural: "Customers and Vendors",
    module: "sales",
    numbered: false,
    lookupTarget: true,
  },
  { key: "item", label: "Item", plural: "Items", module: "items", numbered: false, lookupTarget: true },
  {
    key: "location",
    label: "Location",
    plural: "Locations",
    module: "settings",
    numbered: false,
    lookupTarget: true,
  },
  {
    key: "account",
    label: "Account",
    plural: "Chart of Accounts",
    module: "accounting",
    numbered: false,
    lookupTarget: true,
  },
  { key: "invoice", label: "Invoice", plural: "Invoices", module: "sales", numbered: true, lookupTarget: false },
  {
    key: "credit_note",
    label: "Credit Note",
    plural: "Credit Notes",
    module: "sales",
    numbered: true,
    lookupTarget: false,
  },
  {
    key: "customer_payment",
    label: "Payment Received",
    plural: "Payments Received",
    module: "sales",
    numbered: true,
    lookupTarget: false,
  },
  { key: "bill", label: "Bill", plural: "Bills", module: "purchases", numbered: true, lookupTarget: false },
  {
    key: "purchase_order",
    label: "Purchase Order",
    plural: "Purchase Orders",
    module: "purchases",
    numbered: true,
    lookupTarget: false,
  },
  {
    key: "vendor_credit",
    label: "Vendor Credit",
    plural: "Vendor Credits",
    module: "purchases",
    numbered: true,
    lookupTarget: false,
  },
  {
    key: "vendor_payment",
    label: "Payment Made",
    plural: "Payments Made",
    module: "purchases",
    numbered: true,
    lookupTarget: false,
  },
  {
    key: "expense",
    label: "Expense",
    plural: "Expenses",
    module: "purchases",
    numbered: true,
    lookupTarget: false,
  },
  {
    key: "journal_entry",
    label: "Journal",
    plural: "Manual Journals",
    module: "accounting",
    numbered: true,
    lookupTarget: false,
  },
  {
    key: "fixed_asset",
    label: "Fixed Asset",
    plural: "Fixed Assets",
    module: "accounting",
    numbered: true,
    lookupTarget: false,
  },
  {
    key: "inventory_adjustment",
    label: "Inventory Adjustment",
    plural: "Inventory Adjustments",
    module: "items",
    numbered: true,
    lookupTarget: false,
  },
];

const BY_KEY = new Map(ENTITIES.map((e) => [e.key, e]));

export const entityDef = (key: string): EntityDef | undefined => BY_KEY.get(key);
export const isEntity = (key: string): boolean => BY_KEY.has(key);

/** Entities that carry attachments and comments. */
export const ATTACHABLE_ENTITIES = ENTITIES.filter(
  (e) => e.key !== "location" && e.key !== "account",
).map((e) => e.key);

/** Entities a number series must define numbering for. */
export const NUMBERED_ENTITIES = ENTITIES.filter((e) => e.numbered).map((e) => e.key);

/** Entities a lookup custom field may point at. */
export const LOOKUP_TARGETS = ENTITIES.filter((e) => e.lookupTarget).map((e) => e.key);

/**
 * Entities that may carry custom fields.
 *
 * Deliberately short. Offering them everywhere meant fifteen settings pages
 * for something used occasionally; these are the three places information
 * genuinely arrives that has nowhere else to go — a weighbridge slip on a
 * bill, a vehicle on an expense, a licence number on a contact. Adding another
 * is one entry here, and its settings page appears.
 */
export const CUSTOM_FIELD_ENTITIES = ["contact", "bill", "expense"];
