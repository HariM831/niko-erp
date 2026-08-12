import { scryptSync, randomBytes } from "node:crypto";
import { db, pool } from "./index";
import {
  accounts,
  documentSeries,
  numberSeries,
  roles,
  taxes,
  users,
  type accountSubtype,
  type accountType,
} from "@shared/schema";

type AcctType = (typeof accountType.enumValues)[number];
type AcctSubtype = (typeof accountSubtype.enumValues)[number];

/**
 * Amino's real chart of accounts, taken from the P&L and Balance Sheet head
 * structure. Group rows (Share Capital, Farm Expenses - Nabil, ...) are posting-
 * disabled headers that exist to give reports their sub-totals; leaf rows are
 * what transactions actually hit.
 *
 * code, name, type, subtype, systemKey?, parentCode?, isGroup?
 */
const COA: Array<[string, string, AcctType, AcctSubtype, string?, string?, boolean?]> = [
  // ---------------- Assets: non-current ----------------
  ["1000", "Non Current Assets", "asset", "fixed_asset", undefined, undefined, true],
  ["1010", "Property, Plant & Equipment", "asset", "fixed_asset", undefined, "1000", true],
  ["1011", "Land & Land Development", "asset", "fixed_asset", undefined, "1010"],
  ["1012", "Buildings (Office & Staff)", "asset", "fixed_asset", undefined, "1010"],
  ["1013", "Poultry Sheds", "asset", "fixed_asset", undefined, "1010"],
  ["1014", "Poultry Cages & Equipment", "asset", "fixed_asset", undefined, "1010"],
  ["1015", "Feed Mill Equipment", "asset", "fixed_asset", undefined, "1010"],
  ["1016", "Composting Equipment", "asset", "fixed_asset", undefined, "1010"],
  ["1017", "Computer Equipment", "asset", "fixed_asset", undefined, "1010"],
  ["1018", "Office Equipment", "asset", "fixed_asset", undefined, "1010"],
  ["1019", "Furniture & Fixtures", "asset", "fixed_asset", undefined, "1010"],
  ["1020", "Vehicles, Trucks & Tractors", "asset", "fixed_asset", undefined, "1010"],
  ["1021", "Electrical Installation", "asset", "fixed_asset", undefined, "1010"],
  ["1090", "Accumulated Depreciation", "asset", "fixed_asset", "accum_depreciation", "1000"],

  ["1100", "Financial Assets", "asset", "other_asset", undefined, "1000", true],
  ["1110", "Investments", "asset", "other_asset", undefined, "1100", true],
  ["1111", "Investment in Nandammuri Poultries LLP", "asset", "other_asset", undefined, "1110"],
  ["1112", "Investment in Luit Valley Farms LLP", "asset", "other_asset", undefined, "1110"],
  ["1120", "Security Deposit", "asset", "other_asset", undefined, "1100", true],
  ["1121", "Bhargav Nath (Feed Plant Land - Security Deposit)", "asset", "other_asset", undefined, "1120"],
  ["1122", "APDCL (Nabil - Security Deposit)", "asset", "other_asset", undefined, "1120"],
  ["1123", "APDCL (Dhekiajuli - Security Deposit)", "asset", "other_asset", undefined, "1120"],
  ["1124", "Panbari Tea Company (Poultry Farm Land - Security Deposit)", "asset", "other_asset", undefined, "1120"],
  ["1125", "Bidyut Kanti Sinha (Thelamara Office - Security Deposit)", "asset", "other_asset", undefined, "1120"],
  ["1130", "Fixed Deposit", "asset", "other_asset", undefined, "1100", true],
  ["1131", "SBI Fixed Deposit - 44841686255 (Bird Mortality Fund)", "asset", "other_asset", undefined, "1130"],
  ["1132", "SBI Fixed Deposit - 44994456974 (SBI DSCR)", "asset", "other_asset", undefined, "1130"],
  ["1133", "SBI Fixed Deposit - 44026813421 (EPCG Bank Guarantee)", "asset", "other_asset", undefined, "1130"],

  // ---------------- Assets: current ----------------
  ["1200", "Current Assets", "asset", "other_current_asset", undefined, undefined, true],
  ["1210", "Cash & Cash Equivalents", "asset", "cash", "cash_bank", "1200", true],
  ["1211", "Cash", "asset", "cash", undefined, "1210", true],
  ["1212", "Cash-in-Hand", "asset", "cash", undefined, "1211"],
  ["1213", "Petty Cash (Indusind - 156900222881)", "asset", "cash", "petty_cash", "1211"],
  ["1215", "Bank", "asset", "bank", undefined, "1210", true],
  ["1216", "SBI - 43311518227 (Current Account)", "asset", "bank", undefined, "1215"],
  ["1217", "SBI - 44656290967 (CC Account)", "asset", "bank", undefined, "1215"],

  ["1230", "Inventories", "asset", "stock", "inventory", "1200", true],
  ["1231", "Bird Stock", "asset", "stock", undefined, "1230"],
  ["1232", "Feed Stock", "asset", "stock", undefined, "1230"],

  ["1250", "Accounts Receivable", "asset", "accounts_receivable", "ar", "1200"],

  ["1270", "Other Current Assets", "asset", "other_current_asset", undefined, "1200", true],
  ["1271", "Prepaid Expenses", "asset", "other_current_asset", undefined, "1270"],
  ["1272", "TDS Receivable", "asset", "other_current_asset", "tds_receivable", "1270"],
  ["1273", "Input GST Credit", "asset", "other_current_asset", "input_gst", "1270"],

  // ---------------- Liabilities ----------------
  ["2000", "Non Current Liabilities", "liability", "non_current_liability", undefined, undefined, true],
  ["2010", "Long Term Borrowings", "liability", "non_current_liability", undefined, "2000", true],
  ["2011", "SBI Term Loan - 43766492854", "liability", "non_current_liability", undefined, "2010"],

  ["2100", "Current Liabilities", "liability", "other_current_liability", undefined, undefined, true],
  ["2110", "Accounts Payable", "liability", "accounts_payable", "ap", "2100"],
  ["2120", "Other Current Liabilities", "liability", "other_current_liability", undefined, "2100", true],
  ["2121", "TDS Payable", "liability", "other_current_liability", "tds_payable", "2120"],
  ["2122", "ESI Payable", "liability", "other_current_liability", undefined, "2120"],
  ["2123", "PF Payable", "liability", "other_current_liability", undefined, "2120"],
  ["2124", "Unsecured Loans", "liability", "other_current_liability", undefined, "2120"],
  ["2125", "Expenses Payable (Salaries and others)", "liability", "other_current_liability", undefined, "2120"],
  ["2126", "CGST Payable", "liability", "other_current_liability", "cgst_payable", "2120"],
  ["2127", "SGST Payable", "liability", "other_current_liability", "sgst_payable", "2120"],
  ["2128", "IGST Payable", "liability", "other_current_liability", "igst_payable", "2120"],
  ["2129", "Customer Advances", "liability", "other_current_liability", "customer_advances", "2120"],
  ["2130", "Vendor Advances Applied", "liability", "other_current_liability", "vendor_advances", "2120"],

  // ---------------- Equity ----------------
  ["3000", "Equity", "equity", "equity", undefined, undefined, true],
  ["3010", "Share Capital", "equity", "equity", "owners_capital", "3000", true],
  ["3011", "Hari Krishna Mulpuri (Share Capital)", "equity", "equity", undefined, "3010"],
  ["3012", "Shilpa Nandamuri (Share Capital)", "equity", "equity", undefined, "3010"],
  ["3013", "Gogineni Venkateswara Rao (Share Capital)", "equity", "equity", undefined, "3010"],
  ["3014", "Rohan Saraf (Share Capital)", "equity", "equity", undefined, "3010"],
  ["3020", "Share Application Money", "equity", "equity", undefined, "3000", true],
  ["3021", "Hari Krishna Mulpuri (Share Application Money)", "equity", "equity", undefined, "3020"],
  ["3022", "Shilpa Nandamuri (Share Application Money)", "equity", "equity", undefined, "3020"],
  ["3023", "Gogineni Venkateswara Rao (Share Application Money)", "equity", "equity", undefined, "3020"],
  ["3024", "Rohan Saraf (Share Application Money)", "equity", "equity", undefined, "3020"],
  ["3030", "Retained Earnings", "equity", "equity", "retained_earnings", "3000"],
  ["3040", "Current Year Earnings", "equity", "equity", undefined, "3000"],
  ["3090", "Opening Balance Adjustments", "equity", "equity", "opening_balance_adj", "3000"],

  // ---------------- Revenue ----------------
  // Postable, not a pure header: the invoice engine credits this via systemKey
  // "sales" when a line has no more specific revenue account. Zoho's own "Sales"
  // account behaves the same way.
  ["4000", "Revenue", "income", "income", "sales"],
  ["4001", "Eggs", "income", "income", undefined, "4000"],
  ["4002", "Feed", "income", "income", undefined, "4000"],
  ["4003", "Chicks", "income", "income", undefined, "4000"],
  ["4004", "Manure", "income", "income", undefined, "4000"],
  ["4005", "Gunny Bags / Scrap", "income", "income", undefined, "4000"],

  ["4100", "Other Income", "income", "other_income", undefined, undefined, true],
  ["4101", "Interest on FD", "income", "other_income", undefined, "4100"],
  ["4102", "Interest Income (Other)", "income", "other_income", undefined, "4100"],
  ["4103", "Any Other Income", "income", "other_income", undefined, "4100"],

  // ---------------- Cost of goods sold ----------------
  ["5000", "Cost of Goods Sold", "expense", "cost_of_goods_sold", "cogs"],
  ["5001", "Feed & Additives", "expense", "cost_of_goods_sold", undefined, "5000"],
  ["5002", "Vaccines & Medicines", "expense", "cost_of_goods_sold", undefined, "5000"],
  ["5003", "Chicks", "expense", "cost_of_goods_sold", undefined, "5000"],
  ["5004", "Packing Material", "expense", "cost_of_goods_sold", undefined, "5000"],
  ["5005", "Carriage Inwards", "expense", "cost_of_goods_sold", undefined, "5000"],
  ["5006", "Others (COGS)", "expense", "cost_of_goods_sold", undefined, "5000"],

  // ---------------- Operating expenses ----------------
  ["6000", "Farm Expenses - Nabil", "expense", "expense", undefined, undefined, true],
  ["6001", "Farm Expenses (Nabil)", "expense", "expense", undefined, "6000"],
  ["6002", "Power, Fuel & Electricity (Nabil)", "expense", "expense", undefined, "6000"],
  ["6003", "LPG Gas Cylinders (Nabil)", "expense", "expense", undefined, "6000"],
  ["6004", "Freight & Transportation Expenses (Nabil)", "expense", "expense", undefined, "6000"],
  ["6005", "Loading & Unloading Charges (Nabil)", "expense", "expense", undefined, "6000"],
  ["6006", "Repair & Maintenance (Nabil)", "expense", "expense", undefined, "6000"],
  ["6007", "Manure Management (Nabil)", "expense", "expense", undefined, "6000"],

  ["6100", "Farm Expenses - Panbari", "expense", "expense", undefined, undefined, true],
  ["6101", "Farm Expenses (Panbari)", "expense", "expense", undefined, "6100"],
  ["6102", "Power, Fuel & Electricity (Panbari)", "expense", "expense", undefined, "6100"],
  ["6103", "LPG Gas Cylinders (Panbari)", "expense", "expense", undefined, "6100"],
  ["6104", "Freight & Transportation Expenses (Panbari)", "expense", "expense", undefined, "6100"],
  ["6105", "Loading & Unloading Charges (Panbari)", "expense", "expense", undefined, "6100"],
  ["6106", "Repair & Maintenance (Panbari)", "expense", "expense", undefined, "6100"],
  ["6107", "Rental Expense (Panbari)", "expense", "expense", undefined, "6100"],
  ["6108", "Manure Management (Panbari)", "expense", "expense", undefined, "6100"],

  ["6200", "Feed Plant Expenses - Dhekiajuli", "expense", "expense", undefined, undefined, true],
  ["6201", "Feed Plant Expenses (Dhekiajuli)", "expense", "expense", undefined, "6200"],
  ["6202", "Power, Fuel & Electricity (Dhekiajuli)", "expense", "expense", undefined, "6200"],
  ["6203", "Freight & Transportation Expenses (Dhekiajuli)", "expense", "expense", undefined, "6200"],
  ["6204", "Loading & Unloading Charges (Dhekiajuli)", "expense", "expense", undefined, "6200"],
  ["6205", "Repair & Maintenance (Dhekiajuli)", "expense", "expense", undefined, "6200"],
  ["6206", "Rental Expense (Dhekiajuli)", "expense", "expense", undefined, "6200"],

  ["6300", "Administrative Expenses", "expense", "expense", undefined, undefined, true],
  ["6301", "Office Expenses (General)", "expense", "expense", undefined, "6300"],
  ["6302", "Office Expenses (Thelamara)", "expense", "expense", undefined, "6300"],
  ["6303", "Audit Fees", "expense", "expense", undefined, "6300"],
  ["6304", "Legal & Professional Expenses", "expense", "expense", undefined, "6300"],
  ["6305", "Software Expenses", "expense", "expense", undefined, "6300"],
  ["6306", "Puja, Donations & Contributions", "expense", "expense", undefined, "6300"],
  ["6307", "Government Fees", "expense", "expense", undefined, "6300"],
  ["6308", "Postage & Courier Expenses", "expense", "expense", undefined, "6300"],
  ["6309", "Travelling & Conveyance", "expense", "expense", undefined, "6300"],
  ["6310", "Vehicle Maintenance", "expense", "expense", undefined, "6300"],
  ["6311", "Insurance Expenses", "expense", "expense", undefined, "6300"],
  ["6312", "Interest on TDS", "expense", "expense", undefined, "6300"],
  ["6313", "Bank Charges & Commission", "expense", "expense", "bank_charges", "6300"],

  ["6400", "Selling & Distribution Expenses", "expense", "expense", undefined, undefined, true],
  ["6401", "Advertisement & Marketing", "expense", "expense", undefined, "6400"],
  ["6402", "Sales Promotion Expenses", "expense", "expense", undefined, "6400"],
  ["6403", "Others Expenses (S&D)", "expense", "expense", undefined, "6400"],

  ["6500", "Employee Benefits Expenses", "expense", "expense", undefined, undefined, true],
  ["6501", "Salary & Bonus", "expense", "expense", undefined, "6500"],
  ["6502", "Labour Wages", "expense", "expense", undefined, "6500"],
  ["6503", "Remuneration to Directors", "expense", "expense", undefined, "6500"],
  ["6504", "Contribution to Provident Fund", "expense", "expense", undefined, "6500"],
  ["6505", "Contribution to ESIC", "expense", "expense", undefined, "6500"],
  ["6506", "Staff & Director Welfare Expenses", "expense", "expense", undefined, "6500"],
  ["6507", "Medical Expenses", "expense", "expense", undefined, "6500"],

  ["6600", "Depreciation & Amortisation", "expense", "expense", "depreciation_expense"],

  ["7000", "Finance Cost", "expense", "other_expense", undefined, undefined, true],
  ["7001", "Interest on CC Account (44656290967)", "expense", "other_expense", undefined, "7000"],
  ["7002", "Interest on Term Loan (43766492854)", "expense", "other_expense", undefined, "7000"],
];

const SERIES: Array<[string, string]> = [
  ["journal_entry", "JE-"],
  ["invoice", "INV-"],
  ["estimate", "EST-"],
  ["sales_order", "SO-"],
  ["customer_payment", "PMT-"],
  ["credit_note", "CN-"],
  ["purchase_order", "PO-"],
  ["bill", "BILL-"],
  ["vendor_payment", "VPMT-"],
  ["vendor_credit", "VCN-"],
  ["expense", "EXP-"],
];

const TAXES: Array<[string, string]> = [
  ["GST 0%", "0"],
  ["GST 5%", "5"],
  ["GST 12%", "12"],
  ["GST 18%", "18"],
  ["GST 28%", "28"],
];

await db.transaction(async (tx) => {
  // Chart of accounts (two passes so parent ids resolve)
  const idByCode = new Map<string, string>();
  for (const [code, name, type, subtype, systemKey, , isGroup] of COA) {
    const [row] = await tx
      .insert(accounts)
      .values({ code, name, type, subtype, systemKey, isGroup: isGroup ?? false })
      .onConflictDoUpdate({
        target: accounts.code,
        set: { name, type, subtype, systemKey, isGroup: isGroup ?? false },
      })
      .returning({ id: accounts.id });
    idByCode.set(code, row!.id);
  }
  for (const [code, , , , , parentCode] of COA) {
    if (!parentCode) continue;
    const { eq } = await import("drizzle-orm");
    await tx
      .update(accounts)
      .set({ parentId: idByCode.get(parentCode) })
      .where(eq(accounts.code, code));
  }

  // Every organisation starts with one default series; more can be added in
  // Settings so each line of business gets its own numbering.
  const { eq: eqOp } = await import("drizzle-orm");
  await tx
    .insert(numberSeries)
    .values({ name: "Default Transaction Series", isDefault: true })
    .onConflictDoNothing({ target: numberSeries.name });
  const [defaultSeries] = await tx
    .select({ id: numberSeries.id })
    .from(numberSeries)
    .where(eqOp(numberSeries.isDefault, true))
    .limit(1);
  for (const [entity, prefix] of SERIES) {
    await tx
      .insert(documentSeries)
      .values({ seriesId: defaultSeries!.id, entity, prefix })
      .onConflictDoNothing({ target: [documentSeries.seriesId, documentSeries.entity] });
  }

  for (const [name, rate] of TAXES) {
    await tx.insert(taxes).values({ name, rate }).onConflictDoNothing();
  }

  const [adminRole] = await tx
    .insert(roles)
    .values({
      name: "Admin",
      description: "Full access",
      isSystem: true,
      permissions: { "*": ["*"] },
    })
    .onConflictDoUpdate({
      target: roles.name,
      set: { permissions: { "*": ["*"] } },
    })
    .returning({ id: roles.id });

  await tx
    .insert(roles)
    .values({
      name: "Accountant",
      description: "Books access without user management",
      isSystem: true,
      permissions: {
        sales: ["*"],
        purchases: ["*"],
        accounting: ["*"],
        banking: ["*"],
        items: ["*"],
        reports: ["*"],
      },
    })
    .onConflictDoNothing({ target: roles.name });

  const password = process.env.SEED_ADMIN_PASSWORD ?? "changeme";
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  await tx
    .insert(users)
    .values({
      username: "admin",
      name: "Administrator",
      roleId: adminRole!.id,
      passwordHash: `${salt}:${hash}`,
    })
    .onConflictDoNothing({ target: users.username });
});

console.log("Seeded chart of accounts, document series, taxes, roles, admin user.");
await pool.end();
