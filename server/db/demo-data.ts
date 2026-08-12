/**
 * Populates a fresh set of books with realistic poultry-farm data so every screen
 * has something to show.
 *
 * It drives the real HTTP API rather than writing rows directly, so every document
 * goes through the same validation and posting path the app uses — the resulting
 * journals, balances and statuses are exactly what you'd get by typing it all in.
 *
 * Usage (server must already be running):
 *   npm run db:demo
 */

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const USERNAME = process.env.DEMO_USER ?? "admin";
const PASSWORD = process.env.DEMO_PASSWORD ?? "admin1234";

let cookie = "";

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      // The API rejects mutating requests without a same-origin Origin header.
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** Date helpers — everything is positioned relative to today so the data never goes stale. */
const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return iso(d);
};
const daysAhead = (n: number) => daysAgo(-n);

interface Account { id: string; code: string; name: string; type: string; isGroup: boolean; isActive: boolean }

async function main() {
  console.log(`Seeding demo data into ${BASE}\n`);
  await call("/api/auth/login", "POST", { username: USERNAME, password: PASSWORD });

  const existing = await call<any[]>("/api/sales/invoices");
  if (existing.length > 0) {
    console.error(
      `Refusing to run: ${existing.length} invoice(s) already exist.\n` +
        `Demo data is meant for empty books — run "npm run db:reset" first if you want a clean slate.`,
    );
    process.exit(1);
  }

  const accounts = await call<Account[]>("/api/accounting/accounts");
  const byCode = (code: string) => {
    const a = accounts.find((x) => x.code === code);
    if (!a) throw new Error(`Expected account ${code} in the chart of accounts`);
    return a.id;
  };
  const taxes = await call<Array<{ id: string; name: string; rate: string }>>("/api/taxes");
  const gst5 = taxes.find((t) => Number(t.rate) === 5)?.id;
  const gst18 = taxes.find((t) => Number(t.rate) === 18)?.id;

  // ---------- Bank accounts ----------
  const banks: Record<string, string> = {};
  for (const b of [
    { name: "ICICI Current A/c", kind: "bank", bankName: "ICICI Bank", accountNumber: "058805001234", ifsc: "ICIC0000588", branch: "Tezpur" },
    { name: "SBI Current A/c", kind: "bank", bankName: "State Bank of India", accountNumber: "38291047561", ifsc: "SBIN0007238", branch: "Nabil" },
    { name: "Petty Cash", kind: "cash" },
  ]) {
    const row = await call<{ id: string }>("/api/banking/accounts", "POST", b);
    banks[b.name] = row.id;
  }
  console.log(`✓ ${Object.keys(banks).length} bank accounts`);

  // ---------- Customers ----------
  const customers: Record<string, string> = {};
  for (const c of [
    { displayName: "Guwahati Poultry Traders", companyName: "Guwahati Poultry Traders Pvt Ltd", email: "orders@gptraders.in", phone: "9864012345", gstTreatment: "registered_business", gstin: "18AABCG1234K1Z5", placeOfSupplyState: "18", paymentTermsDays: 30 },
    { displayName: "Shillong Fresh Foods", companyName: "Shillong Fresh Foods LLP", email: "accounts@shillongfresh.in", phone: "9863456789", gstTreatment: "registered_business", gstin: "17AAECS4567M1Z2", placeOfSupplyState: "17", paymentTermsDays: 15 },
    { displayName: "Tezpur Retail Mart", email: "tezpurmart@gmail.com", phone: "9435098765", gstTreatment: "registered_business", gstin: "18AAFCT7788P1ZQ", placeOfSupplyState: "18", paymentTermsDays: 7 },
    { displayName: "Dibrugarh Egg Distributors", email: "sales@dibrugarhegg.in", phone: "9954123456", gstTreatment: "unregistered_business", placeOfSupplyState: "18", paymentTermsDays: 30 },
    { displayName: "Walk-in Customer", gstTreatment: "consumer", placeOfSupplyState: "18", paymentTermsDays: 0 },
  ]) {
    const row = await call<{ id: string }>("/api/contacts", "POST", { type: "customer", ...c });
    customers[c.displayName] = row.id;
  }
  console.log(`✓ ${Object.keys(customers).length} customers`);

  // ---------- Vendors ----------
  const vendors: Record<string, string> = {};
  for (const v of [
    { displayName: "Coastal Feed Company", companyName: "Coastal Feed Company Pvt Ltd", email: "sales@coastalfeed.in", phone: "9812345670", gstTreatment: "registered_business", gstin: "19AABCC9012L1Z8", placeOfSupplyState: "19", paymentTermsDays: 30 },
    { displayName: "Northeast Vet Supplies", email: "info@nevetsupplies.in", phone: "9707123456", gstTreatment: "registered_business", gstin: "18AAGCN3456R1Z1", placeOfSupplyState: "18", paymentTermsDays: 15 },
    { displayName: "Assam Roadways Carriers", email: "ops@assamroadways.in", phone: "9435112233", gstTreatment: "registered_business", gstin: "18AACFA2233N1ZP", placeOfSupplyState: "18", paymentTermsDays: 7 },
    { displayName: "Brahmaputra Packaging", email: "orders@brahmapack.in", phone: "9678234512", gstTreatment: "registered_business", gstin: "18AADCB5566T1ZK", placeOfSupplyState: "18", paymentTermsDays: 30 },
    { displayName: "Sonitpur Chick Hatchery", email: "hatchery@sonitpurchicks.in", phone: "9864778899", gstTreatment: "registered_business", gstin: "18AAJCS8899W1ZM", placeOfSupplyState: "18", paymentTermsDays: 15 },
  ]) {
    const row = await call<{ id: string }>("/api/contacts", "POST", { type: "vendor", ...v });
    vendors[v.displayName] = row.id;
  }
  console.log(`✓ ${Object.keys(vendors).length} vendors`);

  // ---------- Items ----------
  // Sales accounts are set deliberately so invoices land on the right revenue head.
  const items: Record<string, string> = {};
  for (const it of [
    { name: "Table Eggs (30 pc tray)", sku: "EGG-TRAY-30", unit: "tray", hsnOrSac: "0407", isSold: true, sellingPrice: "195.00", salesAccountId: byCode("4001"), isPurchased: false, taxId: gst5 },
    { name: "Brown Eggs (30 pc tray)", sku: "EGG-BRN-30", unit: "tray", hsnOrSac: "0407", isSold: true, sellingPrice: "225.00", salesAccountId: byCode("4001"), isPurchased: false, taxId: gst5 },
    { name: "Broiler Feed (50 kg)", sku: "FEED-BR-50", unit: "bag", hsnOrSac: "2309", isSold: true, sellingPrice: "1850.00", salesAccountId: byCode("4002"), isPurchased: true, costPrice: "1620.00", purchaseAccountId: byCode("5001"), taxId: gst5 },
    { name: "Layer Feed (50 kg)", sku: "FEED-LY-50", unit: "bag", hsnOrSac: "2309", isSold: true, sellingPrice: "1720.00", salesAccountId: byCode("4002"), isPurchased: true, costPrice: "1495.00", purchaseAccountId: byCode("5001"), taxId: gst5 },
    { name: "Day-old Chicks", sku: "CHICK-DOC", unit: "pcs", hsnOrSac: "0105", isSold: true, sellingPrice: "42.00", salesAccountId: byCode("4003"), isPurchased: true, costPrice: "34.00", purchaseAccountId: byCode("5003"), taxId: gst5 },
    { name: "Poultry Manure (50 kg)", sku: "MANURE-50", unit: "bag", hsnOrSac: "3101", isSold: true, sellingPrice: "180.00", salesAccountId: byCode("4004"), isPurchased: false },
    { name: "Gunny Bags (used)", sku: "GUNNY-USED", unit: "pcs", isSold: true, sellingPrice: "22.00", salesAccountId: byCode("4005"), isPurchased: false },
    { name: "Vaccine — Newcastle", sku: "VAC-ND", unit: "vial", hsnOrSac: "3002", isSold: false, isPurchased: true, costPrice: "340.00", purchaseAccountId: byCode("5002"), taxId: gst5 },
    { name: "Egg Trays (empty)", sku: "PKG-TRAY", unit: "pcs", isSold: false, isPurchased: true, costPrice: "8.50", purchaseAccountId: byCode("5004"), taxId: gst18 },
  ]) {
    const row = await call<{ id: string }>("/api/items", "POST", it);
    items[it.name] = row.id;
  }
  console.log(`✓ ${Object.keys(items).length} items`);

  const line = (itemName: string, quantity: string, rate: string, opts: Record<string, unknown> = {}) => ({
    itemId: items[itemName],
    name: itemName,
    quantity,
    rate,
    ...opts,
  });

  // ---------- Invoices ----------
  // A deliberate spread of ages and statuses so the list, ageing and dashboards all have something to show.
  const invoiceSpecs = [
    { customer: "Guwahati Poultry Traders", date: daysAgo(72), reference: "PO-GPT-4471", saveAs: "sent", lines: [line("Table Eggs (30 pc tray)", "480", "195.00", { taxId: gst5 }), line("Brown Eggs (30 pc tray)", "120", "225.00", { taxId: gst5 })] },
    { customer: "Shillong Fresh Foods", date: daysAgo(58), reference: "SFF/2026/118", saveAs: "sent", lines: [line("Table Eggs (30 pc tray)", "300", "198.00", { taxId: gst5 }), line("Poultry Manure (50 kg)", "60", "180.00")] },
    { customer: "Tezpur Retail Mart", date: daysAgo(41), saveAs: "sent", lines: [line("Brown Eggs (30 pc tray)", "90", "228.00", { taxId: gst5 })] },
    { customer: "Guwahati Poultry Traders", date: daysAgo(33), reference: "PO-GPT-4502", saveAs: "sent", lines: [line("Layer Feed (50 kg)", "40", "1720.00", { taxId: gst5 }), line("Broiler Feed (50 kg)", "25", "1850.00", { taxId: gst5 })] },
    { customer: "Dibrugarh Egg Distributors", date: daysAgo(24), saveAs: "sent", lines: [line("Table Eggs (30 pc tray)", "600", "192.00", { taxId: gst5 })] },
    { customer: "Shillong Fresh Foods", date: daysAgo(18), reference: "SFF/2026/143", saveAs: "sent", lines: [line("Day-old Chicks", "2000", "42.00", { taxId: gst5 })] },
    { customer: "Tezpur Retail Mart", date: daysAgo(11), saveAs: "sent", lines: [line("Table Eggs (30 pc tray)", "150", "195.00", { taxId: gst5 }), line("Gunny Bags (used)", "200", "22.00")] },
    { customer: "Guwahati Poultry Traders", date: daysAgo(5), reference: "PO-GPT-4530", saveAs: "sent", lines: [line("Brown Eggs (30 pc tray)", "240", "225.00", { taxId: gst5 }), line("Poultry Manure (50 kg)", "80", "180.00")] },
    { customer: "Walk-in Customer", date: daysAgo(2), saveAs: "sent", lines: [line("Table Eggs (30 pc tray)", "12", "200.00", { taxId: gst5 })] },
    // Left as drafts so the Draft filter isn't empty.
    { customer: "Dibrugarh Egg Distributors", date: daysAgo(1), saveAs: "draft", lines: [line("Layer Feed (50 kg)", "30", "1720.00", { taxId: gst5 })] },
    { customer: "Shillong Fresh Foods", date: iso(today), saveAs: "draft", lines: [line("Table Eggs (30 pc tray)", "360", "196.00", { taxId: gst5 })] },
  ];

  const invoices: Array<{ id: string; number: string; total: string; customer: string }> = [];
  for (const spec of invoiceSpecs) {
    const row = await call<{ id: string; number: string; total: string }>("/api/sales/invoices", "POST", {
      customerId: customers[spec.customer],
      invoiceDate: spec.date,
      reference: spec.reference,
      saveAs: spec.saveAs,
      lines: spec.lines,
    });
    invoices.push({ ...row, customer: spec.customer });
  }
  console.log(`✓ ${invoices.length} invoices`);

  // ---------- Payments received ----------
  // Mix of full settlements, one part-payment and one advance, so balances vary.
  const posted = invoices.filter((_, i) => invoiceSpecs[i]!.saveAs === "sent");
  const paymentSpecs = [
    { invoiceIdx: 0, date: daysAgo(45), mode: "bank_transfer", bank: "ICICI Current A/c", reference: "NEFT/GPT/88123", portion: 1 },
    { invoiceIdx: 1, date: daysAgo(40), mode: "cheque", bank: "SBI Current A/c", reference: "CHQ 442190", portion: 1 },
    { invoiceIdx: 2, date: daysAgo(20), mode: "upi", bank: "ICICI Current A/c", reference: "UPI/TRM/553201", portion: 1 },
    { invoiceIdx: 3, date: daysAgo(12), mode: "bank_transfer", bank: "ICICI Current A/c", reference: "NEFT/GPT/91004", portion: 0.5 },
    { invoiceIdx: 4, date: daysAgo(6), mode: "cash", bank: "Petty Cash", reference: "Cash receipt 21", portion: 0.35 },
  ];
  for (const p of paymentSpecs) {
    const inv = posted[p.invoiceIdx]!;
    const amount = (Math.round(Number(inv.total) * p.portion * 100) / 100).toFixed(2);
    await call("/api/sales/payments", "POST", {
      customerId: customers[inv.customer],
      paymentDate: p.date,
      amount,
      mode: p.mode,
      reference: p.reference,
      bankAccountId: banks[p.bank],
      applications: [{ invoiceId: inv.id, amount }],
    });
  }
  // An unapplied advance — shows up as "Unused Amount" on the payments list.
  await call("/api/sales/payments", "POST", {
    customerId: customers["Guwahati Poultry Traders"],
    paymentDate: daysAgo(3),
    amount: "50000.00",
    mode: "bank_transfer",
    reference: "NEFT/GPT/91580 (advance)",
    bankAccountId: banks["ICICI Current A/c"],
    applications: [],
  });
  console.log(`✓ ${paymentSpecs.length + 1} payments received`);

  // ---------- Credit notes ----------
  await call("/api/sales/credit-notes", "POST", {
    customerId: customers["Tezpur Retail Mart"],
    creditNoteDate: daysAgo(9),
    reference: "Breakage in transit",
    lines: [line("Brown Eggs (30 pc tray)", "6", "228.00", { taxId: gst5 })],
  });
  await call("/api/sales/credit-notes", "POST", {
    customerId: customers["Dibrugarh Egg Distributors"],
    creditNoteDate: daysAgo(4),
    reference: "Rate difference on DED/24",
    lines: [line("Table Eggs (30 pc tray)", "600", "3.00", { taxId: gst5 })],
  });
  console.log("✓ 2 credit notes");

  // ---------- Purchase orders ----------
  for (const po of [
    { vendor: "Coastal Feed Company", date: daysAgo(30), expected: daysAgo(16), reference: "Monthly feed indent", lines: [line("Broiler Feed (50 kg)", "120", "1620.00", { accountId: byCode("5001"), taxId: gst5 })] },
    { vendor: "Sonitpur Chick Hatchery", date: daysAgo(21), expected: daysAgo(7), reference: "Batch 2026-07", lines: [line("Day-old Chicks", "5000", "34.00", { accountId: byCode("5003"), taxId: gst5 })] },
    { vendor: "Brahmaputra Packaging", date: daysAgo(8), expected: daysAhead(6), lines: [line("Egg Trays (empty)", "8000", "8.50", { accountId: byCode("5004"), taxId: gst18 })] },
    { vendor: "Northeast Vet Supplies", date: daysAgo(2), expected: daysAhead(12), reference: "Vaccination schedule Q2", lines: [line("Vaccine — Newcastle", "60", "340.00", { accountId: byCode("5002"), taxId: gst5 })] },
  ]) {
    await call("/api/purchases/orders", "POST", {
      vendorId: vendors[po.vendor],
      orderDate: po.date,
      expectedDeliveryDate: po.expected,
      reference: po.reference,
      lines: po.lines,
    });
  }
  console.log("✓ 4 purchase orders");

  // ---------- Bills ----------
  // The first carries freight so the landed-cost view and its separate freight
  // journal have something real to display.
  const bills: Array<{ id: string; number: string; total: string; vendor: string }> = [];
  for (const b of [
    {
      vendor: "Coastal Feed Company", date: daysAgo(28), vendorBillNumber: "CFC/26-27/0912", reference: "Against PO — monthly feed indent",
      freightAmount: "18500.00", freightVendorId: vendors["Assam Roadways Carriers"], freightAccountId: byCode("5005"),
      lines: [line("Broiler Feed (50 kg)", "120", "1620.00", { accountId: byCode("5001"), taxId: gst5 }), line("Layer Feed (50 kg)", "80", "1495.00", { accountId: byCode("5001"), taxId: gst5 })],
    },
    { vendor: "Sonitpur Chick Hatchery", date: daysAgo(19), vendorBillNumber: "SCH/1188", lines: [line("Day-old Chicks", "5000", "34.00", { accountId: byCode("5003"), taxId: gst5 })] },
    { vendor: "Northeast Vet Supplies", date: daysAgo(14), vendorBillNumber: "NVS/2026/337", lines: [line("Vaccine — Newcastle", "40", "340.00", { accountId: byCode("5002"), taxId: gst5 })] },
    { vendor: "Brahmaputra Packaging", date: daysAgo(7), vendorBillNumber: "BP/4471", lines: [line("Egg Trays (empty)", "8000", "8.50", { accountId: byCode("5004"), taxId: gst18 })] },
    { vendor: "Coastal Feed Company", date: daysAgo(3), vendorBillNumber: "CFC/26-27/0987", lines: [line("Broiler Feed (50 kg)", "60", "1635.00", { accountId: byCode("5001"), taxId: gst5 })] },
  ]) {
    const row = await call<{ id: string; number: string; total: string }>("/api/purchases/bills", "POST", {
      vendorId: vendors[b.vendor],
      billDate: b.date,
      vendorBillNumber: b.vendorBillNumber,
      reference: b.reference,
      freightAmount: b.freightAmount,
      freightVendorId: b.freightVendorId,
      freightAccountId: b.freightAccountId,
      lines: b.lines,
    });
    bills.push({ ...row, vendor: b.vendor });
  }
  console.log(`✓ ${bills.length} bills (one with freight/landed cost)`);

  // ---------- Payments made ----------
  for (const p of [
    { billIdx: 0, date: daysAgo(22), mode: "bank_transfer", bank: "ICICI Current A/c", reference: "RTGS/CFC/7781", portion: 1 },
    { billIdx: 1, date: daysAgo(15), mode: "cheque", bank: "SBI Current A/c", reference: "CHQ 118842", portion: 1 },
    { billIdx: 2, date: daysAgo(8), mode: "bank_transfer", bank: "ICICI Current A/c", reference: "NEFT/NVS/2211", portion: 0.6 },
  ]) {
    const bill = bills[p.billIdx]!;
    const amount = (Math.round(Number(bill.total) * p.portion * 100) / 100).toFixed(2);
    await call("/api/purchases/payments", "POST", {
      vendorId: vendors[bill.vendor],
      paymentDate: p.date,
      amount,
      mode: p.mode,
      reference: p.reference,
      bankAccountId: banks[p.bank],
      applications: [{ billId: bill.id, amount }],
    });
  }
  console.log("✓ 3 payments made");

  // ---------- Vendor credits ----------
  await call("/api/purchases/vendor-credits", "POST", {
    vendorId: vendors["Coastal Feed Company"],
    creditDate: daysAgo(17),
    reference: "Short supply — 4 bags",
    lines: [line("Broiler Feed (50 kg)", "4", "1620.00", { accountId: byCode("5001"), taxId: gst5 })],
  });
  await call("/api/purchases/vendor-credits", "POST", {
    vendorId: vendors["Brahmaputra Packaging"],
    creditDate: daysAgo(5),
    reference: "Damaged trays returned",
    lines: [line("Egg Trays (empty)", "350", "8.50", { accountId: byCode("5004"), taxId: gst18 })],
  });
  console.log("✓ 2 vendor credits");

  // ---------- Expenses ----------
  const expenseSpecs = [
    { date: daysAgo(35), account: "6002", paidThrough: "ICICI Current A/c", vendor: undefined, amount: "48200.00", reference: "APDCL bill — Nabil shed" },
    { date: daysAgo(29), account: "6003", paidThrough: "ICICI Current A/c", vendor: "Assam Roadways Carriers", amount: "12400.00", reference: "LPG cylinders — brooding" },
    { date: daysAgo(26), account: "6006", paidThrough: "Petty Cash", vendor: undefined, amount: "3850.00", reference: "Shed repairs — labour" },
    { date: daysAgo(20), account: "6004", paidThrough: "ICICI Current A/c", vendor: "Assam Roadways Carriers", amount: "22750.00", reference: "Egg delivery — Guwahati route" },
    { date: daysAgo(13), account: "6002", paidThrough: "SBI Current A/c", vendor: undefined, amount: "51900.00", reference: "APDCL bill — Panbari shed" },
    { date: daysAgo(9), account: "6005", paidThrough: "Petty Cash", vendor: undefined, amount: "6200.00", reference: "Loading charges" },
    { date: daysAgo(4), account: "6004", paidThrough: "ICICI Current A/c", vendor: "Assam Roadways Carriers", amount: "18300.00", reference: "Feed transport — Coastal" },
  ];
  for (const e of expenseSpecs) {
    await call("/api/purchases/expenses", "POST", {
      expenseDate: e.date,
      expenseAccountId: byCode(e.account),
      paidThroughId: banks[e.paidThrough],
      vendorId: e.vendor ? vendors[e.vendor] : undefined,
      amount: e.amount,
      reference: e.reference,
    });
  }
  console.log(`✓ ${expenseSpecs.length} expenses`);

  // ---------- Manual journals ----------
  await call("/api/accounting/journals", "POST", {
    entryDate: daysAgo(31),
    narration: "Depreciation for the month — sheds and equipment",
    reference: "DEP/2026/04",
    lines: [
      { accountId: byCode("6600"), debit: "42000.00", description: "Depreciation charge" },
      { accountId: byCode("1090"), credit: "42000.00", description: "Accumulated depreciation" },
    ],
  });
  await call("/api/accounting/journals", "POST", {
    entryDate: daysAgo(10),
    narration: "Mortality write-off — batch 2026-06",
    reference: "MORT/06",
    lines: [
      { accountId: byCode("6007"), debit: "18700.00", description: "Bird mortality" },
      { accountId: byCode("1231"), credit: "18700.00", description: "Bird stock reduction" },
    ],
  });
  console.log("✓ 2 manual journals");

  // ---------- Budget ----------
  const fyYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  await call("/api/budgets", "POST", {
    name: `FY ${fyYear}-${String((fyYear + 1) % 100).padStart(2, "0")} Operating Budget`,
    startDate: `${fyYear}-04-01`,
    endDate: `${fyYear + 1}-03-31`,
    period: "monthly",
    accountIds: [byCode("4001"), byCode("4002"), byCode("4003"), byCode("5001"), byCode("6002"), byCode("6004")],
  });
  console.log("✓ 1 budget");

  // ---------- Sanity check ----------
  const rows = await call<Array<{ totalDebit: string; totalCredit: string }>>(
    "/api/accounting/reports/trial-balance",
  );
  const debit = rows.reduce((s, r) => s + Number(r.totalDebit), 0);
  const credit = rows.reduce((s, r) => s + Number(r.totalCredit), 0);
  const balanced = debit > 0 && Math.abs(debit - credit) < 0.005;
  console.log(
    `\nTrial balance: debit ₹${debit.toFixed(2)} vs credit ₹${credit.toFixed(2)} — ` +
      (balanced ? "balanced ✓" : "OUT OF BALANCE ✗"),
  );
  if (!balanced) process.exit(1);
  console.log("\nDemo data loaded. Log in as admin / admin1234.");
}

void main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
