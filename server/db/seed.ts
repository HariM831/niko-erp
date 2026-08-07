import { scryptSync, randomBytes } from "node:crypto";
import { db, pool } from "./index";
import {
  accounts,
  documentSeries,
  roles,
  taxes,
  users,
  type accountType,
} from "@shared/schema";

type AcctType = (typeof accountType.enumValues)[number];

// code, name, type, systemKey?, parentCode?
const COA: Array<[string, string, AcctType, string?, string?]> = [
  ["1000", "Assets", "asset"],
  ["1100", "Cash & Bank", "asset", "cash_bank", "1000"],
  ["1110", "Petty Cash", "asset", "petty_cash", "1000"],
  ["1200", "Accounts Receivable", "asset", "ar", "1000"],
  ["1300", "Inventory", "asset", "inventory", "1000"],
  ["1520", "Input GST Credit", "asset", "input_gst", "1000"],
  ["1530", "TDS Receivable", "asset", "tds_receivable", "1000"],
  ["1540", "Prepaid Expenses", "asset", undefined, "1000"],
  ["1600", "Fixed Assets", "asset", undefined, "1000"],
  ["1610", "Land & Buildings", "asset", undefined, "1600"],
  ["1620", "Plant & Equipment", "asset", undefined, "1600"],
  ["1630", "Vehicles", "asset", undefined, "1600"],
  ["1690", "Accumulated Depreciation", "asset", "accum_depreciation", "1600"],
  ["2000", "Liabilities", "liability"],
  ["2100", "Accounts Payable", "liability", "ap", "2000"],
  ["2110", "CGST Payable", "liability", "cgst_payable", "2000"],
  ["2120", "SGST Payable", "liability", "sgst_payable", "2000"],
  ["2130", "IGST Payable", "liability", "igst_payable", "2000"],
  ["2140", "TDS Payable", "liability", "tds_payable", "2000"],
  ["2170", "Customer Advances", "liability", "customer_advances", "2000"],
  ["2180", "Vendor Advances Applied", "liability", "vendor_advances", "2000"],
  ["3000", "Equity", "equity"],
  ["3100", "Owner's Capital", "equity", "owners_capital", "3000"],
  ["3200", "Retained Earnings", "equity", "retained_earnings", "3000"],
  ["3900", "Opening Balance Adjustments", "equity", "opening_balance_adj", "3000"],
  ["4000", "Sales Revenue", "income", "sales"],
  ["4100", "Other Operating Income", "income"],
  ["5000", "Cost of Goods Sold", "expense", "cogs"],
  ["6000", "Salaries & Wages", "expense"],
  ["6100", "Electricity", "expense"],
  ["6110", "Fuel & Transport", "expense"],
  ["6120", "Repairs & Maintenance", "expense"],
  ["6130", "Depreciation Expense", "expense", "depreciation_expense"],
  ["6140", "Office & Admin", "expense"],
  ["6200", "Bank Charges", "expense", "bank_charges"],
  ["6300", "Miscellaneous Expense", "expense"],
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
  for (const [code, name, type, systemKey] of COA) {
    const [row] = await tx
      .insert(accounts)
      .values({ code, name, type, systemKey })
      .onConflictDoUpdate({
        target: accounts.code,
        set: { name, type, systemKey },
      })
      .returning({ id: accounts.id });
    idByCode.set(code, row!.id);
  }
  for (const [code, , , , parentCode] of COA) {
    if (!parentCode) continue;
    const { eq } = await import("drizzle-orm");
    await tx
      .update(accounts)
      .set({ parentId: idByCode.get(parentCode) })
      .where(eq(accounts.code, code));
  }

  for (const [entity, prefix] of SERIES) {
    await tx
      .insert(documentSeries)
      .values({ entity, prefix })
      .onConflictDoNothing({ target: documentSeries.entity });
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
