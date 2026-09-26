import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ListPage, StatusBadge, type Column, type ListView } from "../components/list-page";
import { SummaryBanner, type BannerStat } from "../components/summary-banner";
import type { SearchField } from "../components/advanced-search";
import { AttachmentsButton } from "../components/attachments";
import { api, formatMoney } from "../api";
import { LogoMark } from "../components/logo";
import { billNo } from "../lib/utils";

export interface DocRow {
  id: string;
  number: string;
  status: string;
  total?: string;
  balanceDue?: string;
  balance?: string;
  amount?: string;
  unappliedAmount?: string;
  dueDate?: string;
  contactName?: string;
  [k: string]: unknown;
}

export const shortDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

interface DocColumnOpts {
  balance?: "balanceDue" | "balance";
  amountKey?: string;
  dueDate?: boolean;
  contactHeader?: string;
  numberHeader?: string;
}

export function docColumns(dateKey: string, opts: DocColumnOpts): Column<DocRow>[] {
  const cols: Column<DocRow>[] = [
    // portrait: the four that let you recognise a row on a phone held upright —
    // when, which one, who with, how much. Everything else waits for landscape.
    // An ISO date sorts chronologically as plain text, which is the one good
    // thing about yyyy-mm-dd. Status carries no sort, as in Zoho: ordering a
    // badge alphabetically puts Draft above Overdue and answers nothing.
    { key: "date", header: "Date", portrait: true, sort: (r) => r[dateKey] as string, render: (r) => shortDate(r[dateKey] as string) },
    {
      key: "number",
      header: opts.numberHeader ?? "Number",
      portrait: true,
      sort: (r) => r.number,
      render: (r) => <span className="font-medium text-brand-600">{r.number}</span>,
    },
    {
      key: "contact",
      header: opts.contactHeader ?? "Customer Name",
      portrait: true,
      sort: (r) => r.contactName,
      render: (r) => <span className="text-gray-800">{r.contactName ?? "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.status} dueDate={opts.dueDate ? r.dueDate : undefined} />,
    },
  ];
  if (opts.dueDate) {
    cols.push({ key: "due", header: "Due Date", sort: (r) => r.dueDate, render: (r) => shortDate(r.dueDate) });
  }
  cols.push({
    key: "amount",
    header: "Amount",
    align: "right",
    portrait: true,
    sort: (r) => Number((r[opts.amountKey ?? "total"] as string) ?? r.total) || 0,
    render: (r) => formatMoney((r[opts.amountKey ?? "total"] as string) ?? r.total),
  });
  if (opts.balance) {
    cols.push({
      key: "bal",
      header: "Balance Due",
      align: "right",
      sort: (r) => Number(r[opts.balance!] as string) || 0,
      render: (r) => formatMoney(r[opts.balance!] as string),
    });
  }
  return cols;
}

const statusViews = (statuses: string[]): ListView[] => [
  { label: "All", params: {} },
  ...statuses.map((s) => ({ label: s.replace(/_/g, " "), params: { status: s } })),
];

/**
 * Advanced-search fields per module.
 *
 * These follow Zoho's Advanced Search box for box and in Zoho's order, minus
 * the fields niko has no data for — GST treatment, place of supply, TCS, tax
 * exemptions, projects, salesperson and addresses are absent by design, and
 * offering them as boxes that filter nothing would be worse than not offering
 * them. A few of niko's own follow Zoho's set (Internal#, Vendor Bill Total,
 * Due Date on invoices): they were here before and still answer questions.
 *
 * The keys must match what the module declares in server/services/search-specs;
 * a key with no counterpart there is read by nothing.
 */
const itemFields: SearchField[] = [
  { key: "itemId", label: "Item Name", kind: "item" },
  { key: "itemDescription", label: "Item Description", kind: "text" },
];
const ACCOUNT: SearchField = { key: "accountId", label: "Account", kind: "account" };
const TOTAL: SearchField = { key: "total", label: "Total Range", kind: "numberRange" };
const DATE: SearchField = { key: "date", label: "Date Range", kind: "dateRange" };
const CREATED: SearchField = { key: "created", label: "Created Between", kind: "dateRange" };
const NOTES: SearchField = { key: "notes", label: "Notes", kind: "text" };
const REFERENCE: SearchField = { key: "reference", label: "Reference#", kind: "text" };
const VENDOR: SearchField = { key: "vendorId", label: "Vendor", kind: "contact", contactType: "vendor" };
const CUSTOMER: SearchField = { key: "customerId", label: "Customer Name", kind: "contact", contactType: "customer" };
/** Status choices in Zoho's casing: "partially_paid" reads "Partially Paid". */
const status = (options: (string | { value: string; label: string })[]): SearchField => ({
  key: "status",
  label: "Status",
  kind: "select",
  options: options.map((o) =>
    typeof o === "string" ? { value: o, label: o.replace(/_/g, " ").replace(/(^| )\w/g, (c) => c.toUpperCase()) } : o,
  ),
});
const CREDIT_STATUS = status(["draft", "open", "closed", "void"]);
const PAYMENT_METHOD: SearchField = {
  key: "mode",
  label: "Payment Method",
  kind: "select",
  options: [
    { value: "cash", label: "Cash" },
    { value: "bank_transfer", label: "Bank Transfer" },
    { value: "upi", label: "UPI" },
    { value: "cheque", label: "Cheque" },
    { value: "card", label: "Card" },
  ],
};

export const BILL_SEARCH: SearchField[] = [
  // Bill# is the vendor's number, as on the list; niko's counter is Internal#.
  { key: "vendorBillNumber", label: "Bill#", kind: "text" },
  // The linked purchase order's number, or the order number a Zoho bill kept in its reference.
  { key: "purchaseOrderNumber", label: "P.O#", kind: "text" },
  DATE,
  { key: "dueDate", label: "Due Date", kind: "dateRange" },
  CREATED,
  // Overdue and Unpaid are readings of an owed bill, worked out on the server.
  status(["draft", "open", "overdue", "unpaid", "partially_paid", "paid", "void"]),
  ...itemFields,
  TOTAL,
  NOTES,
  VENDOR,
  { key: "vendorPan", label: "Vendor PAN", kind: "text" },
  ACCOUNT,
  { key: "number", label: "Internal#", kind: "text" },
  REFERENCE,
  // What the vendor printed, before our deductions — the figure they quote on
  // the phone, which our own total never equals on a truck that ran short.
  { key: "vendorBillTotal", label: "Vendor Bill Total", kind: "numberRange" },
];

export const INVOICE_SEARCH: SearchField[] = [
  { key: "number", label: "Invoice#", kind: "text" },
  // Zoho's "Order Number" on an invoice is its reference.
  { key: "reference", label: "Order Number", kind: "text" },
  DATE,
  CREATED,
  status(["draft", "sent", "overdue", "unpaid", "partially_paid", "paid", "void"]),
  ...itemFields,
  ACCOUNT,
  TOTAL,
  CUSTOMER,
  { key: "dueDate", label: "Due Date", kind: "dateRange" },
  { key: "customerGstin", label: "Customer GSTIN", kind: "text" },
  NOTES,
];

/**
 * Zoho's Source, Customer Name and Employee are left out: a niko expense is
 * typed in by hand, is never billed on to a customer and carries no employee.
 */
export const EXPENSE_SEARCH: SearchField[] = [
  { key: "accountId", label: "Expense Account", kind: "account" },
  { key: "paidThroughId", label: "Paid Through", kind: "account", accountSource: "bank" },
  NOTES,
  REFERENCE,
  DATE,
  // The two states the list shows: paid, or still owed with no paid-through account.
  status(["paid", "unpaid"]),
  TOTAL,
  VENDOR,
  { key: "number", label: "Expense#", kind: "text" },
];

/**
 * Zoho's Status is left out — a niko payment is recorded once, paid, with no
 * draft or void state to tell apart — and so is Payments Made's Bank Reference#,
 * which would be the same Reference# column a second time.
 */
export const CUSTOMER_PAYMENT_SEARCH: SearchField[] = [
  CUSTOMER,
  { key: "number", label: "Payment #", kind: "text" },
  REFERENCE,
  DATE,
  TOTAL,
  PAYMENT_METHOD,
  NOTES,
];
export const VENDOR_PAYMENT_SEARCH: SearchField[] = [
  VENDOR,
  { key: "number", label: "Payment #", kind: "text" },
  REFERENCE,
  DATE,
  TOTAL,
  PAYMENT_METHOD,
  NOTES,
];

export const VENDOR_CREDIT_SEARCH: SearchField[] = [
  { key: "number", label: "Credit Note#", kind: "text" },
  REFERENCE,
  DATE,
  CREDIT_STATUS,
  ...itemFields,
  TOTAL,
  NOTES,
  ACCOUNT,
  VENDOR,
];

export const CREDIT_NOTE_SEARCH: SearchField[] = [
  { key: "number", label: "Credit Note#", kind: "text" },
  REFERENCE,
  DATE,
  CREDIT_STATUS,
  ...itemFields,
  ACCOUNT,
  TOTAL,
  NOTES,
  CUSTOMER,
];

export const PURCHASE_ORDER_SEARCH: SearchField[] = [
  { key: "number", label: "Purchase Order#", kind: "text" },
  REFERENCE,
  DATE,
  { key: "expectedDeliveryDate", label: "Expected Delivery Date", kind: "dateRange" },
  CREATED,
  status(["draft", "issued", "partially_billed", "billed", "closed", "cancelled"]),
  ...itemFields,
  TOTAL,
  VENDOR,
  ACCOUNT,
];

/**
 * Manual Journals. Zoho's "Notes" is niko's narration, and "Published" is what
 * Zoho calls a posted entry. Customer Name and Vendor Name are left out because
 * a niko journal line carries no contact; Reporting Method and Journal Type
 * because niko keeps one set of books, with no cash-basis-only entries.
 */
export const JOURNAL_SEARCH: SearchField[] = [
  { key: "number", label: "Journal#", kind: "text" },
  REFERENCE,
  DATE,
  status([
    { value: "draft", label: "Draft" },
    { value: "posted", label: "Published" },
    { value: "reversed", label: "Reversed" },
  ]),
  ACCOUNT,
  { key: "accountCode", label: "Account Code", kind: "text" },
  { key: "narration", label: "Notes", kind: "text" },
  TOTAL,
];

export const INVOICE_VIEWS = statusViews(["draft", "sent", "partially_paid", "paid", "void"]);
export const INVOICE_COLUMNS = docColumns("invoiceDate", { balance: "balanceDue", dueDate: true, numberHeader: "Invoice#" });
export const BILL_VIEWS = statusViews(["open", "partially_paid", "paid", "void"]);

const dateTime = (v: unknown) =>
  v
    ? new Date(v as string).toLocaleString("en-IN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

/**
 * Zoho Bills list: Date | Bill# | Reference Number | Vendor | Status | Due Date | Amount | Balance Due | Created By | Created Time
 *
 * Bill# is the vendor's own number, as in Zoho — it is what the vendor quotes
 * and what is printed on the paper. niko's counter has no Zoho counterpart and
 * sits in its own column, after the vendor's; a bill entered without a vendor
 * number falls back to the counter so the column is never blank.
 */
export const BILL_COLUMNS: Column<DocRow>[] = [
  { key: "date", header: "Date", portrait: true, sort: (r) => r.billDate as string, render: (r) => shortDate(r.billDate as string) },
  { key: "number", header: "Bill#", portrait: true, sort: (r) => billNo(r), render: (r) => <span className="font-medium text-brand-600">{billNo(r)}</span> },
  { key: "reference", header: "Reference Number", sort: (r) => r.reference as string, render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
  { key: "internal", header: "Internal#", sort: (r) => r.number, render: (r) => <span className="text-gray-600">{r.number}</span> },
  { key: "contact", header: "Vendor Name", portrait: true, sort: (r) => r.contactName, render: (r) => <span className="text-gray-800">{r.contactName ?? "—"}</span> },
  { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} dueDate={r.dueDate} /> },
  { key: "due", header: "Due Date", sort: (r) => r.dueDate, render: (r) => shortDate(r.dueDate) },
  { key: "amount", header: "Amount", align: "right", portrait: true, sort: (r) => Number(r.total) || 0, render: (r) => formatMoney(r.total) },
  { key: "bal", header: "Balance Due", align: "right", sort: (r) => Number(r.balanceDue) || 0, render: (r) => formatMoney(r.balanceDue) },
  { key: "createdBy", header: "Created By", sort: (r) => r.createdByName as string, render: (r) => <span className="text-gray-600">{(r.createdByName as string) || "—"}</span> },
  { key: "createdTime", header: "Created Time", sort: (r) => r.createdAt as string, render: (r) => <span className="whitespace-nowrap text-gray-600">{dateTime(r.createdAt)}</span> },
];

interface SummaryStats {
  totalOutstanding: string;
  dueToday: string;
  dueWithin30Days: string;
  overdue: string;
  avgDaysToGetPaid?: number;
}

/**
 * The Payment Summary strip above the Invoices / Bills lists — Zoho's own
 * figures under Zoho's own headings: five on Invoices, four on Bills (a bill
 * has no "days for getting paid"), behind the same Show Details / Hide toggle.
 *
 * It used to show two figures and leave the rest off, because four across the
 * top of a phone left none of them readable. The toggle is the answer Zoho
 * gives the same problem: the whole strip folds to one line, and the browser
 * remembers which way it was left, per list.
 */
const SUMMARY_OPEN_KEY = "niko.paymentSummary.open";
function readSummaryOpen(side: string): boolean {
  try {
    return localStorage.getItem(`${SUMMARY_OPEN_KEY}.${side}`) !== "0";
  } catch {
    return true;
  }
}
function PaymentSummaryBanner({ endpoint, side }: { endpoint: string; side: "receivable" | "payable" }) {
  const { data } = useQuery({
    queryKey: [endpoint],
    queryFn: () => api<SummaryStats>(endpoint),
  });
  const [open, setOpen] = useState(() => readSummaryOpen(side));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(`${SUMMARY_OPEN_KEY}.${side}`, next ? "1" : "0");
    } catch {
      /* a browser that keeps nothing still gets the toggle for this visit */
    }
  };
  const link = "text-brand-600 hover:underline";
  if (!open) {
    return (
      <div className="flex items-center gap-3 border-b border-yolk-200/70 bg-gradient-to-r from-yolk-100 via-yolk-50 to-transparent px-4 py-2 sm:px-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-yolk-700/80">Payment Summary</span>
        <button type="button" onClick={toggle} className={`ml-auto text-[12px] ${link}`}>
          Show Details
        </button>
      </div>
    );
  }
  const receivable = side === "receivable";
  const overdue = Number(data?.overdue ?? 0);
  const secondary: BannerStat[] = [
    { label: "Due Today", value: formatMoney(data?.dueToday ?? 0) },
    { label: "Due Within 30 Days", value: formatMoney(data?.dueWithin30Days ?? 0) },
    // Overdue gets the dot when it is not zero — the one place on this page
    // red is earned rather than decorative.
    { label: receivable ? "Overdue Invoices" : "Overdue Bills", value: formatMoney(data?.overdue ?? 0), alert: overdue > 0 },
  ];
  if (receivable) {
    secondary.push({ label: "Average No. of Days for Getting Paid", value: `${data?.avgDaysToGetPaid ?? 0} Days` });
  }
  return (
    <SummaryBanner
      primary={{
        label: receivable ? "Total Outstanding Receivables" : "Total Outstanding Payables",
        value: formatMoney(data?.totalOutstanding ?? 0),
      }}
      secondary={secondary}
      action={
        <button type="button" onClick={toggle} className={link}>
          Hide
        </button>
      }
    />
  );
}

/** The Purchase Orders list's own hero — open value leads, delivery slippage is the one alert. */
function PurchaseOrderSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["/api/purchases/orders/summary"],
    queryFn: () =>
      api<{ openValue: string; draftValue: string; billedThisMonth: string; overdueForDelivery: string }>(
        "/api/purchases/orders/summary",
      ),
  });
  const overdueValue = Number(data?.overdueForDelivery ?? 0);
  return (
    <SummaryBanner
      primary={{ label: "Open purchase orders", value: formatMoney(data?.openValue ?? 0) }}
      secondary={[
        { label: "Draft", value: formatMoney(data?.draftValue ?? 0) },
        {
          label: "Overdue for delivery",
          value: formatMoney(data?.overdueForDelivery ?? 0),
          alert: overdueValue > 0,
        },
        { label: "Billed this month", value: formatMoney(data?.billedThisMonth ?? 0) },
      ]}
    />
  );
}

/** The Credit Notes list's own hero — open balance leads. */
function CreditNoteSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["/api/sales/credit-notes/summary"],
    queryFn: () =>
      api<{ openBalance: string; issuedThisMonth: string; openCount: number; closedValue: string }>(
        "/api/sales/credit-notes/summary",
      ),
  });
  return (
    <SummaryBanner
      primary={{ label: "Open credit balance", value: formatMoney(data?.openBalance ?? 0) }}
      secondary={[
        { label: "Issued this month", value: formatMoney(data?.issuedThisMonth ?? 0) },
        { label: "Open credit notes", value: String(data?.openCount ?? 0) },
        { label: "Closed", value: formatMoney(data?.closedValue ?? 0) },
      ]}
    />
  );
}

/** The Vendor Credits list's own hero — same shape as Credit Notes, the purchase side of it. */
function VendorCreditSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["/api/purchases/vendor-credits/summary"],
    queryFn: () =>
      api<{ openBalance: string; issuedThisMonth: string; openCount: number; closedValue: string }>(
        "/api/purchases/vendor-credits/summary",
      ),
  });
  return (
    <SummaryBanner
      primary={{ label: "Open credit balance", value: formatMoney(data?.openBalance ?? 0) }}
      secondary={[
        { label: "Issued this month", value: formatMoney(data?.issuedThisMonth ?? 0) },
        { label: "Open vendor credits", value: String(data?.openCount ?? 0) },
        { label: "Closed", value: formatMoney(data?.closedValue ?? 0) },
      ]}
    />
  );
}

/** The Expenses list's own hero — this month leads. No alert dot: a spend record isn't a problem the way overdue money is. */
function ExpenseSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["/api/purchases/expenses/summary"],
    queryFn: () =>
      api<{ thisMonth: string; thisWeek: string; last30Days: string; thisYear: string }>(
        "/api/purchases/expenses/summary",
      ),
  });
  return (
    <SummaryBanner
      primary={{ label: "This month's expenses", value: formatMoney(data?.thisMonth ?? 0) }}
      secondary={[
        { label: "This week", value: formatMoney(data?.thisWeek ?? 0) },
        { label: "Last 30 days", value: formatMoney(data?.last30Days ?? 0) },
        { label: "This year", value: formatMoney(data?.thisYear ?? 0) },
      ]}
    />
  );
}

/** The Payments Received list's own hero — received this month leads. */
function PaymentsReceivedSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["/api/sales/payments/summary"],
    queryFn: () =>
      api<{ thisMonth: string; thisWeek: string; unapplied: string; thisYear: string }>("/api/sales/payments/summary"),
  });
  return (
    <SummaryBanner
      primary={{ label: "Received this month", value: formatMoney(data?.thisMonth ?? 0) }}
      secondary={[
        { label: "This week", value: formatMoney(data?.thisWeek ?? 0) },
        { label: "Unapplied (advances)", value: formatMoney(data?.unapplied ?? 0) },
        { label: "This year", value: formatMoney(data?.thisYear ?? 0) },
      ]}
    />
  );
}

/** The Payments Made list's own hero — paid this month leads. */
function PaymentsMadeSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["/api/purchases/payments/summary"],
    queryFn: () =>
      api<{ thisMonth: string; thisWeek: string; unapplied: string; thisYear: string }>(
        "/api/purchases/payments/summary",
      ),
  });
  return (
    <SummaryBanner
      primary={{ label: "Paid this month", value: formatMoney(data?.thisMonth ?? 0) }}
      secondary={[
        { label: "This week", value: formatMoney(data?.thisWeek ?? 0) },
        { label: "Unapplied (advances)", value: formatMoney(data?.unapplied ?? 0) },
        { label: "This year", value: formatMoney(data?.thisYear ?? 0) },
      ]}
    />
  );
}

export const InvoicesPage = () => (
  <ListPage<DocRow>
    title="Invoices"
    endpoint="/api/sales/invoices"
    searchFields={INVOICE_SEARCH}
    rowKey={(r) => r.id}
    views={INVOICE_VIEWS}
    newPath="/sales/invoices/new"
    rowPath={(r) => `/sales/invoices/${r.id}`}
    columns={INVOICE_COLUMNS}
    banner={<PaymentSummaryBanner endpoint="/api/sales/invoices/summary" side="receivable" />}
  />
);

export const CustomerPaymentsPage = () => (
  <ListPage<DocRow>
    title="Received Payments"
    endpoint="/api/sales/payments"
    searchFields={CUSTOMER_PAYMENT_SEARCH}
    rowKey={(r) => r.id}
    newPath="/sales/payments/new"
    rowPath={(r) => `/sales/payments/${r.id}`}
    banner={<PaymentsReceivedSummaryBanner />}
    columns={[
      { key: "date", header: "Date", portrait: true, sort: (r) => r.paymentDate as string, render: (r) => shortDate(r.paymentDate as string) },
      { key: "number", header: "Payment #", portrait: true, sort: (r) => r.number, render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "reference", header: "Reference Number", sort: (r) => r.reference as string, render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Customer Name", portrait: true, sort: (r) => r.contactName, render: (r) => r.contactName ?? "—" },
      { key: "invoices", header: "Invoice#", sort: (r) => r.invoiceNumbers as string, render: (r) => <span className="text-gray-600">{(r.invoiceNumbers as string) || "—"}</span> },
      { key: "mode", header: "Mode", sort: (r) => r.mode as string, render: (r) => <span className="capitalize">{String(r.mode ?? "").replace(/_/g, " ")}</span> },
      { key: "amount", header: "Amount", align: "right", portrait: true, sort: (r) => Number(r.amount) || 0, render: (r) => formatMoney(r.amount) },
      { key: "unapplied", header: "Unused Amount", align: "right", sort: (r) => Number(r.unappliedAmount) || 0, render: (r) => formatMoney(r.unappliedAmount) },
      { key: "status", header: "Status", render: () => <StatusBadge status="paid" /> },
    ]}
  />
);

export const CreditNotesPage = () => (
  <ListPage<DocRow>
    title="Credit Notes"
    endpoint="/api/sales/credit-notes"
    searchFields={CREDIT_NOTE_SEARCH}
    rowKey={(r) => r.id}
    views={statusViews(["open", "closed", "void"])}
    newPath="/sales/credit-notes/new"
    rowPath={(r) => `/sales/credit-notes/${r.id}`}
    columns={docColumns("creditNoteDate", { balance: "balance", numberHeader: "Credit Note#" })}
    banner={<CreditNoteSummaryBanner />}
  />
);

/** Zoho shows how much of a PO has been turned into bills. */
const BILLED_STATUS: Record<string, string> = {
  draft: "YET TO BE BILLED",
  issued: "YET TO BE BILLED",
  partially_billed: "PARTIALLY BILLED",
  billed: "BILLED",
  closed: "CLOSED",
  cancelled: "CLOSED",
};

const daysOverdue = (date?: string) => {
  if (!date) return 0;
  const diff = Date.now() - new Date(`${date}T00:00:00`).getTime();
  return Math.floor(diff / 86_400_000);
};

export const PurchaseOrdersPage = () => (
  <ListPage<DocRow>
    title="Purchase Orders"
    endpoint="/api/purchases/orders"
    searchFields={PURCHASE_ORDER_SEARCH}
    rowKey={(r) => r.id}
    views={statusViews(["draft", "issued", "partially_billed", "billed", "closed", "cancelled"])}
    newPath="/purchases/orders/new"
    rowPath={(r) => `/purchases/orders/${r.id}`}
    banner={<PurchaseOrderSummaryBanner />}
    columns={[
      { key: "date", header: "Date", portrait: true, sort: (r) => r.orderDate as string, render: (r) => shortDate(r.orderDate as string) },
      { key: "number", header: "Purchase Order#", portrait: true, sort: (r) => r.number, render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "reference", header: "Reference#", sort: (r) => r.reference as string, render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Vendor Name", portrait: true, sort: (r) => r.contactName, render: (r) => <span className="text-gray-800">{r.contactName ?? "—"}</span> },
      { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
      {
        key: "billed",
        header: "Billed Status",
        render: (r) => (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            {BILLED_STATUS[r.status] ?? "—"}
          </span>
        ),
      },
      { key: "amount", header: "Amount", align: "right", portrait: true, sort: (r) => Number(r.total) || 0, render: (r) => formatMoney(r.total) },
      {
        key: "delivery",
        header: "Delivery Date",
        sort: (r) => r.expectedDeliveryDate as string,
        render: (r) => {
          const d = r.expectedDeliveryDate as string | undefined;
          if (!d) return "—";
          const late = r.status === "issued" && daysOverdue(d) > 0;
          return (
            <div>
              <div>{shortDate(d)}</div>
              {late && (
                <div className="text-[11px] text-red-600">Overdue by {daysOverdue(d)} days</div>
              )}
            </div>
          );
        },
      },
    ]}
  />
);

export const BillsPage = () => {
  const [, navigate] = useLocation();
  return (
    <div className="relative h-full">
      {/* Bills only, by choice — not a shared ListPage feature. The rows are
          opaque white, so this sits over them rather than behind, sits low
          enough to clear the banner and the dense top rows, and ignores the
          pointer entirely. */}
      <LogoMark
        decorative
        className="pointer-events-none absolute left-1/2 top-2/3 z-10 w-[38%] max-w-md -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.05]"
      />
      <div className="h-full">
        <ListPage<DocRow>
          title="Bills"
          endpoint="/api/purchases/bills"
          searchFields={BILL_SEARCH}
          rowKey={(r) => r.id}
          views={BILL_VIEWS}
          newPath="/purchases/bills/new"
          rowPath={(r) => `/purchases/bills/${r.id}`}
          columns={BILL_COLUMNS}
          banner={<PaymentSummaryBanner endpoint="/api/purchases/bills/summary" side="payable" />}
        />
      </div>
    </div>
  );
};

export const VendorPaymentsPage = () => (
  <ListPage<DocRow>
    title="Payments"
    endpoint="/api/purchases/payments"
    searchFields={VENDOR_PAYMENT_SEARCH}
    rowKey={(r) => r.id}
    newPath="/purchases/payments/new"
    rowPath={(r) => `/purchases/payments/${r.id}`}
    banner={<PaymentsMadeSummaryBanner />}
    columns={[
      { key: "date", header: "Date", portrait: true, sort: (r) => r.paymentDate as string, render: (r) => shortDate(r.paymentDate as string) },
      { key: "number", header: "Payment #", portrait: true, sort: (r) => r.number, render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "reference", header: "Reference#", sort: (r) => r.reference as string, render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Vendor Name", portrait: true, sort: (r) => r.contactName, render: (r) => r.contactName ?? "—" },
      { key: "bills", header: "Bill#", sort: (r) => r.billNumbers as string, render: (r) => <span className="text-gray-600">{(r.billNumbers as string) || "—"}</span> },
      { key: "mode", header: "Mode", sort: (r) => r.mode as string, render: (r) => <span className="capitalize">{String(r.mode ?? "").replace(/_/g, " ")}</span> },
      { key: "status", header: "Status", render: () => <StatusBadge status="paid" /> },
      { key: "amount", header: "Amount", align: "right", portrait: true, sort: (r) => Number(r.amount) || 0, render: (r) => formatMoney(r.amount) },
      { key: "unapplied", header: "Unused Amount", align: "right", sort: (r) => Number(r.unappliedAmount) || 0, render: (r) => formatMoney(r.unappliedAmount) },
    ]}
  />
);

export const VendorCreditsPage = () => (
  <ListPage<DocRow>
    title="Vendor Credits"
    endpoint="/api/purchases/vendor-credits"
    searchFields={VENDOR_CREDIT_SEARCH}
    rowKey={(r) => r.id}
    views={statusViews(["open", "closed", "void"])}
    newPath="/purchases/vendor-credits/new"
    rowPath={(r) => `/purchases/vendor-credits/${r.id}`}
    banner={<VendorCreditSummaryBanner />}
    columns={[
      { key: "date", header: "Date", portrait: true, sort: (r) => r.creditDate as string, render: (r) => shortDate(r.creditDate as string) },
      { key: "number", header: "Credit Note#", portrait: true, sort: (r) => r.number, render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "reference", header: "Reference Number", sort: (r) => r.reference as string, render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Vendor Name", portrait: true, sort: (r) => r.contactName, render: (r) => <span className="text-gray-800">{r.contactName ?? "—"}</span> },
      { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
      { key: "amount", header: "Amount", align: "right", portrait: true, sort: (r) => Number(r.total) || 0, render: (r) => formatMoney(r.total) },
      { key: "bal", header: "Balance", align: "right", sort: (r) => Number(r.balance) || 0, render: (r) => formatMoney(r.balance) },
    ]}
  />
);

export const ExpensesPage = () => (
  <ListPage<DocRow>
    title="Expenses"
    endpoint="/api/purchases/expenses"
    searchFields={EXPENSE_SEARCH}
    rowKey={(r) => r.id}
    newPath="/purchases/expenses/new"
    rowPath={(r) => `/purchases/expenses/${r.id}`}
    banner={<ExpenseSummaryBanner />}
    columns={[
      { key: "date", header: "Date", portrait: true, sort: (r) => r.expenseDate as string, render: (r) => shortDate(r.expenseDate as string) },
      { key: "account", header: "Expense Account", portrait: true, sort: (r) => r.expenseAccountName as string, render: (r) => <span className="text-gray-800">{(r.expenseAccountName as string) ?? "—"}</span> },
      { key: "ref", header: "Reference#", clamp: 8, sort: (r) => r.reference as string, render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Vendor Name", sort: (r) => r.contactName, render: (r) => r.contactName ?? "—" },
      // What the money was actually spent on. It lives in notes and was
      // never shown; on a phone it matters more than which vendor took it.
      {
        key: "description",
        header: "Description",
        portrait: true,
        clamp: 13,
        sort: (r) => r.notes as string,
        render: (r) => <span className="text-gray-600">{(r.notes as string) || "—"}</span>,
      },
      { key: "paidThrough", header: "Paid Through", sort: (r) => r.paidThroughName as string, render: (r) => <span className="text-gray-600">{(r.paidThroughName as string) ?? "—"}</span> },
      {
        // An expense entered with no paid-through account is money still owed:
        // it sits on the Payments screen with the unpaid bills until it is
        // settled, so the list has to say which kind it is.
        key: "status",
        header: "Status",
        render: (r) =>
          r.paidThroughName ? (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Paid</span>
          ) : (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Unpaid</span>
          ),
      },
      { key: "amount", header: "Amount", align: "right", portrait: true, sort: (r) => Number(r.amount) || 0, render: (r) => formatMoney(r.amount) },
      {
        key: "files",
        header: "",
        align: "right",
        render: (r) => (
          <div onClick={(e) => e.stopPropagation()} className="inline-block">
            <AttachmentsButton entityType="expense" entityId={r.id} />
          </div>
        ),
      },
    ]}
  />
);
