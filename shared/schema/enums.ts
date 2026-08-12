import { pgEnum } from "drizzle-orm/pg-core";

export const accountType = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);

/**
 * Zoho's granular account classification. `accountType` above stays the broad
 * bucket the posting engine reasons about; this decides how an account is
 * grouped and ordered on the Balance Sheet and P&L.
 */
export const accountSubtype = pgEnum("account_subtype", [
  // Assets
  "other_current_asset",
  "cash",
  "bank",
  "accounts_receivable",
  "stock",
  "fixed_asset",
  "other_asset",
  // Liabilities
  "other_current_liability",
  "accounts_payable",
  "credit_card",
  "non_current_liability",
  "other_liability",
  // Equity
  "equity",
  // Income
  "income",
  "other_income",
  // Expense
  "expense",
  "cost_of_goods_sold",
  "other_expense",
]);

export const journalStatus = pgEnum("journal_status", [
  "draft",
  "posted",
  "reversed",
]);

export const journalSourceType = pgEnum("journal_source_type", [
  "manual",
  "invoice",
  "customer_payment",
  "credit_note",
  "bill",
  "vendor_payment",
  "vendor_credit",
  "expense",
  "inventory_adjustment",
  "opening_balance",
  "depreciation",
  "banking",
]);

export const contactType = pgEnum("contact_type", ["customer", "vendor"]);

export const gstTreatment = pgEnum("gst_treatment", [
  "registered_business",
  "registered_composition",
  "unregistered_business",
  "consumer",
  "overseas",
  "special_economic_zone",
]);

export const itemType = pgEnum("item_type", ["goods", "service"]);

export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "sent",
  "partially_paid",
  "paid",
  "void",
]);

export const billStatus = pgEnum("bill_status", [
  "draft",
  "open",
  "partially_paid",
  "paid",
  "void",
]);

export const purchaseOrderStatus = pgEnum("purchase_order_status", [
  "draft",
  "issued",
  "partially_billed",
  "billed",
  "closed",
  "cancelled",
]);

export const creditNoteStatus = pgEnum("credit_note_status", [
  "draft",
  "open",
  "closed",
  "void",
]);

/** The kinds of place the business runs. Farms and the mill drive production;
    offices and warehouses exist for costing and stock location only. */
export const locationType = pgEnum("location_type", [
  "farm",
  "feed_mill",
  "warehouse",
  "office",
]);

export const assetStatus = pgEnum("asset_status", [
  "active",
  "fully_depreciated",
  "disposed",
]);

export const depreciationMethod = pgEnum("depreciation_method", [
  "straight_line",
  "written_down_value",
]);

export const paymentMode = pgEnum("payment_mode", [
  "cash",
  "bank_transfer",
  "upi",
  "cheque",
  "card",
]);

export const bankTxnDirection = pgEnum("bank_txn_direction", [
  "debit",
  "credit",
]);

export const bankTxnMatchStatus = pgEnum("bank_txn_match_status", [
  "unmatched",
  "matched",
  "excluded",
]);
