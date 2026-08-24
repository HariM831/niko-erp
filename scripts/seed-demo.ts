/**
 * Populates realistic demo data across every module by driving the real
 * HTTP API (not raw SQL) — so every document goes through actual
 * validation, totals computation, and ledger posting, same as a real
 * user clicking through the app. Run with the dev server already up:
 *   npx tsx scripts/seed-demo.ts
 */

const BASE = process.env.niko_BASE_URL ?? "http://localhost:3000";
let cookie = "";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data as any;
}

const today = new Date();
const daysAgo = (n: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const todayStr = daysAgo(0);

const log = (msg: string) => console.log(`  ${msg}`);

async function main() {
  console.log("Logging in as admin…");
  await api("POST", "/api/auth/login", { username: "admin", password: process.env.SEED_ADMIN_PASSWORD ?? "admin1234" });

  console.log("Loading reference data (accounts, taxes)…");
  const accounts = (await api("GET", "/api/accounting/accounts")) as unknown as Array<{ id: string; code: string; systemKey: string | null }>;
  const acctByCode = new Map(accounts.map((a) => [a.code, a.id]));
  const taxes = (await api("GET", "/api/taxes")) as unknown as Array<{ id: string; name: string }>;
  const taxByName = new Map(taxes.map((t) => [t.name, t.id]));
  const gst0 = taxByName.get("GST 0%")!;
  const gst5 = taxByName.get("GST 5%")!;

  // ---------- Organisation profile ----------
  console.log("Setting organisation profile…");
  await api("PATCH", "/api/settings/org", {
    name: "niko Farms Private Limited",
    gstin: "29AACCE1234F1Z5",
    pan: "AACCE1234F",
    stateCode: "29",
    phone: "+91 80 4567 8901",
    email: "accounts@nikofarms.in",
    address: "Plot 42, Poultry Industrial Estate",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560100",
  }).catch((e) => log(`org profile: ${e.message}`));

  // ---------- Bank accounts ----------
  console.log("Creating bank accounts…");
  const banks: Record<string, string> = {};
  for (const b of [
    { name: "HDFC Bank - Current A/C", kind: "bank", bankName: "HDFC Bank", accountNumber: "50100234567890", ifsc: "HDFC0001234", branch: "Koramangala" },
    { name: "SBI - CC A/C", kind: "bank", bankName: "State Bank of India", accountNumber: "36521987450012", ifsc: "SBIN0009876", branch: "Whitefield" },
    { name: "Petty Cash", kind: "cash" },
  ]) {
    const row = await api("POST", "/api/banking/accounts", b);
    banks[b.name] = row.id as string;
    log(`bank account: ${b.name}`);
  }

  // ---------- Customers ----------
  console.log("Creating customers…");
  const customers: Record<string, string> = {};
  const customerSeed = [
    { displayName: "Sri Lakshmi Traders", companyName: "Sri Lakshmi Traders", email: "orders@srilakshmi.in", phone: "9845012345", gstTreatment: "registered_business", gstin: "29AAAFS1234C1ZQ", placeOfSupplyState: "29", paymentTermsDays: 15, addresses: [{ kind: "billing", line1: "12 Market Road", city: "Bengaluru", state: "Karnataka", pincode: "560002", isDefault: true }] },
    { displayName: "Bhadra Eggs", companyName: "Bhadra Eggs & Poultry", email: "purchase@bhadraeggs.com", phone: "9900112233", gstTreatment: "registered_business", gstin: "27AABCB5678D1Z2", placeOfSupplyState: "27", paymentTermsDays: 7, addresses: [{ kind: "billing", line1: "45 APMC Yard", city: "Mumbai", state: "Maharashtra", pincode: "400001", isDefault: true }] },
    { displayName: "NB Traders", companyName: "NB Traders", email: "nbtraders@gmail.com", phone: "9741023456", gstTreatment: "unregistered_business", placeOfSupplyState: "29", paymentTermsDays: 0, addresses: [{ kind: "billing", line1: "8 Gandhi Bazaar", city: "Mysuru", state: "Karnataka", pincode: "570004", isDefault: true }] },
    { displayName: "Aneibu Chakhesang Traders", companyName: "Aneibu Chakhesang Traders", email: "aneibu.traders@gmail.com", phone: "9436012340", gstTreatment: "registered_business", gstin: "13AABCT4321E1Z8", placeOfSupplyState: "13", paymentTermsDays: 30, addresses: [{ kind: "billing", line1: "Dimapur Highway", city: "Dimapur", state: "Nagaland", pincode: "797112", isDefault: true }] },
  ];
  for (const c of customerSeed) {
    const existing = (await api("GET", `/api/contacts?type=customer&search=${encodeURIComponent(c.displayName)}`)) as unknown as Array<{ id: string; displayName: string }>;
    const found = existing.find((e) => e.displayName === c.displayName);
    if (found) {
      customers[c.displayName] = found.id;
      log(`customer exists: ${c.displayName}`);
      continue;
    }
    const row = await api("POST", "/api/contacts", { type: "customer", ...c });
    customers[c.displayName] = row.id as string;
    log(`customer: ${c.displayName}`);
  }

  // ---------- Vendors ----------
  console.log("Creating vendors…");
  const vendors: Record<string, string> = {};
  const vendorSeed = [
    { displayName: "Karnataka Maize Suppliers", companyName: "Karnataka Maize Suppliers", email: "sales@kmaize.in", phone: "9880123456", gstTreatment: "registered_business", gstin: "29AABCK9876F1Z1", placeOfSupplyState: "29", paymentTermsDays: 30, addresses: [{ kind: "billing", line1: "Yeshwanthpur APMC", city: "Bengaluru", state: "Karnataka", pincode: "560022", isDefault: true }] },
    { displayName: "Godrej Agrovet Ltd", companyName: "Godrej Agrovet Ltd", email: "orders@godrejagrovet.com", phone: "9822034567", gstTreatment: "registered_business", gstin: "27AAACG1234H1ZR", placeOfSupplyState: "27", paymentTermsDays: 45, addresses: [{ kind: "billing", line1: "Pirojshanagar, Vikhroli", city: "Mumbai", state: "Maharashtra", pincode: "400079", isDefault: true }] },
    { displayName: "Coastal Chemicals Pvt Ltd", companyName: "Coastal Chemicals Pvt Ltd", email: "accounts@coastalchem.in", phone: "9743098765", gstTreatment: "registered_business", gstin: "29AADCC5678J1Z9", placeOfSupplyState: "29", paymentTermsDays: 15, addresses: [{ kind: "billing", line1: "Peenya Industrial Area", city: "Bengaluru", state: "Karnataka", pincode: "560058", isDefault: true }] },
  ];
  for (const v of vendorSeed) {
    const existing = (await api("GET", `/api/contacts?type=vendor&search=${encodeURIComponent(v.displayName)}`)) as unknown as Array<{ id: string; displayName: string }>;
    const found = existing.find((e) => e.displayName === v.displayName);
    if (found) {
      vendors[v.displayName] = found.id;
      log(`vendor exists: ${v.displayName}`);
      continue;
    }
    const row = await api("POST", "/api/contacts", { type: "vendor", ...v });
    vendors[v.displayName] = row.id as string;
    log(`vendor: ${v.displayName}`);
  }

  // ---------- Items ----------
  console.log("Creating items…");
  const items: Record<string, string> = {};
  const itemSeed = [
    { name: "Eggs (Box of 210)", type: "goods", unit: "box", sellingPrice: "1050.00", isSold: true, isPurchased: false, taxId: gst0, salesAccountId: acctByCode.get("4000") },
    { name: "Layer Mash Feed", type: "goods", unit: "kg", sellingPrice: "42.50", costPrice: "35.00", taxId: gst0, salesAccountId: acctByCode.get("4010") ?? acctByCode.get("4000"), purchaseAccountId: acctByCode.get("5100") ?? acctByCode.get("5000") },
    { name: "Maize (Yellow)", type: "goods", unit: "kg", costPrice: "24.00", isSold: false, isPurchased: true, taxId: gst0, purchaseAccountId: acctByCode.get("5000"), preferredVendorId: vendors["Karnataka Maize Suppliers"] },
    { name: "Soya DOC", type: "goods", unit: "kg", costPrice: "48.00", isSold: false, isPurchased: true, taxId: gst5, purchaseAccountId: acctByCode.get("5000"), preferredVendorId: vendors["Godrej Agrovet Ltd"] },
    { name: "Poultry Vaccine (ND-IB)", type: "goods", unit: "vial", costPrice: "180.00", isSold: false, isPurchased: true, taxId: gst5, purchaseAccountId: acctByCode.get("6300"), preferredVendorId: vendors["Coastal Chemicals Pvt Ltd"] },
    { name: "Egg Tray (30 pcs)", type: "goods", unit: "tray", sellingPrice: "16.00", costPrice: "12.00", taxId: gst5 },
    { name: "Farm Consultancy", type: "service", unit: "hour", sellingPrice: "1500.00", isPurchased: false, salesAccountId: acctByCode.get("4100") },
  ];
  for (const it of itemSeed) {
    const existing = (await api("GET", `/api/items?search=${encodeURIComponent(it.name)}`)) as unknown as Array<{ id: string; name: string }>;
    const found = existing.find((e) => e.name === it.name);
    if (found) {
      items[it.name] = found.id;
      log(`item exists: ${it.name}`);
      continue;
    }
    const row = await api("POST", "/api/items", it);
    items[it.name] = row.id as string;
    log(`item: ${it.name}`);
  }

  // ---------- Purchase Orders -> Bills ----------
  console.log("Creating purchase orders…");
  const po1 = await api("POST", "/api/purchases/orders", {
    vendorId: vendors["Karnataka Maize Suppliers"],
    orderDate: daysAgo(25),
    reference: "PO-KMS-AUG",
    lines: [{ itemId: items["Maize (Yellow)"], name: "Maize (Yellow)", quantity: "5000", unit: "kg", rate: "24.00", taxId: gst0 }],
  });
  await api("POST", `/api/purchases/orders/${po1.id}/status`, { status: "issued" });
  await api("POST", `/api/purchases/orders/${po1.id}/convert-to-bill`, { billDate: daysAgo(20), vendorBillNumber: "KMS/2026/0817" });
  log("PO -> Bill: Karnataka Maize Suppliers (converted)");

  const po2 = await api("POST", "/api/purchases/orders", {
    vendorId: vendors["Godrej Agrovet Ltd"],
    orderDate: daysAgo(10),
    reference: "PO-GODREJ-SOYA",
    lines: [{ itemId: items["Soya DOC"], name: "Soya DOC", quantity: "2000", unit: "kg", rate: "48.00", taxId: gst5 }],
  });
  await api("POST", `/api/purchases/orders/${po2.id}/status`, { status: "issued" });
  log("PO issued (not yet billed): Godrej Agrovet Ltd");

  // ---------- Direct bills ----------
  console.log("Creating direct bills…");
  const billOverdue = await api("POST", "/api/purchases/bills", {
    vendorId: vendors["Coastal Chemicals Pvt Ltd"],
    billDate: daysAgo(30),
    vendorBillNumber: "CC/INV/4521",
    lines: [{ itemId: items["Poultry Vaccine (ND-IB)"], name: "Poultry Vaccine (ND-IB)", quantity: "100", unit: "vial", rate: "180.00", taxId: gst5 }],
  });
  log("bill (overdue, unpaid): Coastal Chemicals");

  const billPaid = await api("POST", "/api/purchases/bills", {
    vendorId: vendors["Karnataka Maize Suppliers"],
    billDate: daysAgo(5),
    vendorBillNumber: "KMS/2026/0902",
    lines: [{ itemId: items["Maize (Yellow)"], name: "Maize (Yellow)", quantity: "1000", unit: "kg", rate: "24.00", taxId: gst0 }],
  });
  log("bill (to be paid in full): Karnataka Maize Suppliers");

  // ---------- Vendor payments ----------
  console.log("Recording vendor payments…");
  const billPaidFull = (await api("GET", `/api/purchases/bills/${billPaid.id}`)) as unknown as { total: string };
  await api("POST", "/api/purchases/payments", {
    vendorId: vendors["Karnataka Maize Suppliers"],
    paymentDate: daysAgo(2),
    amount: billPaidFull.total,
    mode: "bank_transfer",
    reference: "NEFT/882910",
    bankAccountId: banks["HDFC Bank - Current A/C"],
    applications: [{ billId: billPaid.id, amount: billPaidFull.total }],
  });
  log("payment: Karnataka Maize Suppliers bill paid in full");

  const bill1 = (await api("GET", `/api/purchases/bills`)) as unknown as Array<{ id: string; vendorId: string; total: string; balanceDue: string }>;
  const kmsConvertedBill = bill1.find((b) => b.vendorId === vendors["Karnataka Maize Suppliers"] && Number(b.balanceDue) > 0 && b.id !== billPaid.id);
  if (kmsConvertedBill) {
    const partial = (Number(kmsConvertedBill.total) * 0.4).toFixed(2);
    await api("POST", "/api/purchases/payments", {
      vendorId: vendors["Karnataka Maize Suppliers"],
      paymentDate: daysAgo(15),
      amount: partial,
      mode: "upi",
      reference: "UPI/771023",
      bankAccountId: banks["SBI - CC A/C"],
      applications: [{ billId: kmsConvertedBill.id, amount: partial }],
    });
    log("payment: Karnataka Maize Suppliers (partial, from PO conversion)");
  }

  // ---------- Vendor credit ----------
  console.log("Creating a vendor credit…");
  await api("POST", "/api/purchases/vendor-credits", {
    vendorId: vendors["Coastal Chemicals Pvt Ltd"],
    creditDate: daysAgo(3),
    reference: "Damaged stock return",
    lines: [{ itemId: items["Poultry Vaccine (ND-IB)"], name: "Poultry Vaccine (ND-IB)", quantity: "5", unit: "vial", rate: "180.00", taxId: gst5 }],
  });
  log("vendor credit: Coastal Chemicals (damaged stock)");

  // ---------- Expenses ----------
  console.log("Recording expenses…");
  const expenseSeed = [
    { expenseDate: daysAgo(4), expenseAccountId: acctByCode.get("6110"), paidThroughId: banks["Petty Cash"], amount: "3200.00", reference: "Diesel - farm generator" },
    { expenseDate: daysAgo(8), expenseAccountId: acctByCode.get("6100"), paidThroughId: banks["HDFC Bank - Current A/C"], amount: "18450.00", reference: "BESCOM - August" },
    { expenseDate: daysAgo(1), expenseAccountId: acctByCode.get("6140"), paidThroughId: banks["Petty Cash"], amount: "1250.00", reference: "Stationery & courier" },
  ];
  for (const e of expenseSeed) {
    await api("POST", "/api/purchases/expenses", e);
    log(`expense: ${e.reference}`);
  }

  // ---------- Invoices: overdue, due today, paid, partially paid, draft ----------
  console.log("Creating invoices in varied states…");

  const invOverdue = await api("POST", "/api/sales/invoices", {
    customerId: customers["Bhadra Eggs"],
    invoiceDate: daysAgo(40),
    dueDate: daysAgo(25),
    lines: [{ itemId: items["Eggs (Box of 210)"], name: "Eggs (Box of 210)", quantity: "40", unit: "box", rate: "1050.00", taxId: gst0 }],
    saveAs: "sent",
  });
  log("invoice (overdue): Bhadra Eggs");

  const invDueToday = await api("POST", "/api/sales/invoices", {
    customerId: customers["NB Traders"],
    invoiceDate: daysAgo(15),
    dueDate: todayStr,
    lines: [{ itemId: items["Egg Tray (30 pcs)"], name: "Egg Tray (30 pcs)", quantity: "150", unit: "tray", rate: "16.00", taxId: gst5 }],
    saveAs: "sent",
  });
  log("invoice (due today): NB Traders");

  const invToPay = await api("POST", "/api/sales/invoices", {
    customerId: customers["Sri Lakshmi Traders"],
    invoiceDate: daysAgo(10),
    lines: [{ itemId: items["Eggs (Box of 210)"], name: "Eggs (Box of 210)", quantity: "20", unit: "box", rate: "1050.00", taxId: gst0 }],
    saveAs: "sent",
  });
  log("invoice (to be paid in full): Sri Lakshmi Traders");

  const invPartial = await api("POST", "/api/sales/invoices", {
    customerId: customers["Aneibu Chakhesang Traders"],
    invoiceDate: daysAgo(8),
    lines: [{ itemId: items["Eggs (Box of 210)"], name: "Eggs (Box of 210)", quantity: "60", unit: "box", rate: "1050.00", taxId: gst0 }],
    saveAs: "sent",
  });
  log("invoice (to be part-paid): Aneibu Chakhesang Traders");

  await api("POST", "/api/sales/invoices", {
    customerId: customers["Sri Lakshmi Traders"],
    invoiceDate: todayStr,
    lines: [{ itemId: items["Farm Consultancy"], name: "Farm Consultancy", quantity: "4", unit: "hour", rate: "1500.00", taxId: gst5 }],
  });
  log("invoice (draft): Sri Lakshmi Traders");

  // ---------- Customer payments ----------
  console.log("Recording customer payments…");
  const invToPayDoc = (await api("GET", `/api/sales/invoices/${invToPay.id}`)) as unknown as { total: string };
  await api("POST", "/api/sales/payments", {
    customerId: customers["Sri Lakshmi Traders"],
    paymentDate: daysAgo(1),
    amount: invToPayDoc.total,
    mode: "bank_transfer",
    reference: "NEFT/SLT-4471",
    bankAccountId: banks["HDFC Bank - Current A/C"],
    applications: [{ invoiceId: invToPay.id, amount: invToPayDoc.total }],
  });
  log("payment: Sri Lakshmi Traders (invoice paid in full)");

  const invPartialDoc = (await api("GET", `/api/sales/invoices/${invPartial.id}`)) as unknown as { total: string };
  const partialAmt = (Number(invPartialDoc.total) * 0.5).toFixed(2);
  await api("POST", "/api/sales/payments", {
    customerId: customers["Aneibu Chakhesang Traders"],
    paymentDate: daysAgo(4),
    amount: partialAmt,
    mode: "upi",
    reference: "UPI/ACT-9012",
    bankAccountId: banks["SBI - CC A/C"],
    applications: [{ invoiceId: invPartial.id, amount: partialAmt }],
  });
  log("payment: Aneibu Chakhesang Traders (partial)");

  // Advance / unapplied payment (on-account, no invoice application)
  await api("POST", "/api/sales/payments", {
    customerId: customers["NB Traders"],
    paymentDate: daysAgo(2),
    amount: "5000.00",
    mode: "cash",
    reference: "Advance received",
    bankAccountId: banks["Petty Cash"],
    applications: [],
  });
  log("payment: NB Traders (advance, unapplied)");

  // ---------- Credit note ----------
  console.log("Creating a credit note…");
  const cn = await api("POST", "/api/sales/credit-notes", {
    customerId: customers["Bhadra Eggs"],
    creditNoteDate: daysAgo(20),
    invoiceId: invOverdue.id,
    reference: "Short delivery adjustment",
    lines: [{ itemId: items["Eggs (Box of 210)"], name: "Eggs (Box of 210)", quantity: "2", unit: "box", rate: "1050.00", taxId: gst0 }],
  });
  const cnDoc = (await api("GET", `/api/sales/credit-notes/${cn.id}`)) as unknown as { total: string };
  await api("POST", `/api/sales/credit-notes/${cn.id}/apply`, {
    applications: [{ invoiceId: invOverdue.id, amount: cnDoc.total }],
  });
  log("credit note: Bhadra Eggs (applied against overdue invoice)");

  // ---------- Manual journals ----------
  console.log("Posting manual journal entries…");
  await api("POST", "/api/accounting/journals", {
    entryDate: daysAgo(1),
    narration: "Depreciation for the month - Plant & Equipment",
    lines: [
      { accountId: acctByCode.get("6130"), debit: "8500.00" },
      { accountId: acctByCode.get("1690"), credit: "8500.00" },
    ],
  });
  log("journal: monthly depreciation");

  await api("POST", "/api/accounting/journals", {
    entryDate: daysAgo(6),
    narration: "Bank charges - HDFC quarterly maintenance",
    lines: [
      { accountId: acctByCode.get("6200"), debit: "590.00" },
      { accountId: acctByCode.get("1100"), credit: "590.00" },
    ],
  });
  log("journal: bank charges");

  // ---------- Bank statement import + categorize/match/exclude ----------
  console.log("Importing bank statement lines…");
  const hdfcTxns = [
    { txnDate: daysAgo(1), direction: "credit", amount: invToPayDoc.total, utr: "NEFT/SLT-4471", description: "NEFT-SRI LAKSHMI TRADERS" },
    { txnDate: daysAgo(6), direction: "debit", amount: "590.00", utr: "CHG/Q3", description: "HDFC QUARTERLY CHARGES" },
    { txnDate: daysAgo(8), direction: "debit", amount: "18450.00", utr: "BESCOM/AUG", description: "BESCOM ELECTRICITY BILL" },
    { txnDate: daysAgo(12), direction: "debit", amount: "4200.00", utr: "ATM/W881", description: "ATM WITHDRAWAL" },
    { txnDate: daysAgo(18), direction: "credit", amount: "12000.00", utr: "RTGS/MISC", description: "RTGS RECEIVED - MISC" },
  ];
  await api("POST", "/api/banking/transactions/import", { bankAccountId: banks["HDFC Bank - Current A/C"], transactions: hdfcTxns });
  log(`imported ${hdfcTxns.length} HDFC statement lines`);

  await api("POST", "/api/banking/transactions/import", {
    bankAccountId: banks["SBI - CC A/C"],
    transactions: [
      { txnDate: daysAgo(15), direction: "debit", amount: "6182.40", utr: "UPI/771023", description: "UPI-KARNATAKA MAIZE SUPPLIERS" },
      { txnDate: daysAgo(4), direction: "credit", amount: "13230.00", utr: "UPI/ACT-9012", description: "UPI-ANEIBU CHAKHESANG" },
      { txnDate: daysAgo(20), direction: "debit", amount: "1500.00", utr: "POS/9981", description: "POS PURCHASE - FUEL" },
    ],
  });
  log("imported 3 SBI statement lines");

  console.log("Categorizing / matching bank transactions…");
  const hdfcRows = (await api("GET", `/api/banking/transactions?bankAccountId=${banks["HDFC Bank - Current A/C"]}&matchStatus=unmatched`)) as unknown as Array<{ id: string; description: string; direction: string; amount: string }>;

  const bescomTxn = hdfcRows.find((r) => r.description?.includes("BESCOM"));
  if (bescomTxn) {
    await api("POST", `/api/banking/transactions/${bescomTxn.id}/categorize`, {
      accountId: acctByCode.get("6100"),
      narration: "BESCOM electricity - categorized from statement",
    });
    log("categorized: BESCOM debit -> Electricity expense");
  }

  const atmTxn = hdfcRows.find((r) => r.description?.includes("ATM"));
  if (atmTxn) {
    await api("POST", `/api/banking/transactions/${atmTxn.id}/categorize`, {
      accountId: acctByCode.get("1110"),
      narration: "Cash withdrawal to Petty Cash",
    });
    log("categorized: ATM withdrawal -> Petty Cash");
  }

  const rtgsTxn = hdfcRows.find((r) => r.description?.includes("RTGS"));
  if (rtgsTxn) {
    await api("POST", `/api/banking/transactions/${rtgsTxn.id}/exclude`);
    log("excluded: unidentified RTGS credit");
  }

  const sltTxn = hdfcRows.find((r) => r.utr === "NEFT/SLT-4471");
  if (sltTxn) {
    const journals = (await api("GET", "/api/accounting/journals")) as unknown as Array<{ id: string; narration: string }>;
    const paymentJournal = journals.find((j) => j.narration.includes("Sri Lakshmi Traders") && j.narration.includes("PMT"));
    if (paymentJournal) {
      await api("POST", `/api/banking/transactions/${sltTxn.id}/match`, { journalEntryId: paymentJournal.id });
      log("matched: NEFT credit -> Sri Lakshmi Traders payment JE");
    } else {
      log("skip match: could not find payment JE by narration");
    }
  }

  console.log("\nDone. Demo data seeded across Items, Contacts, Sales, Purchases, Banking, and Accountant.");
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message);
  process.exit(1);
});
