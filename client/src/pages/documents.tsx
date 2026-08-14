import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ListPage, StatusBadge, type Column, type ListView } from "../components/list-page";
import type { SearchField } from "../components/advanced-search";
import { AttachmentsButton } from "../components/attachments";
import { api, formatMoney } from "../api";

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
    { key: "date", header: "Date", render: (r) => shortDate(r[dateKey] as string) },
    {
      key: "number",
      header: opts.numberHeader ?? "Number",
      render: (r) => <span className="font-medium text-brand-600">{r.number}</span>,
    },
    {
      key: "contact",
      header: opts.contactHeader ?? "Customer Name",
      render: (r) => <span className="text-gray-800">{r.contactName ?? "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.status} dueDate={opts.dueDate ? r.dueDate : undefined} />,
    },
  ];
  if (opts.dueDate) {
    cols.push({ key: "due", header: "Due Date", render: (r) => shortDate(r.dueDate) });
  }
  cols.push({
    key: "amount",
    header: "Amount",
    align: "right",
    render: (r) => formatMoney((r[opts.amountKey ?? "total"] as string) ?? r.total),
  });
  if (opts.balance) {
    cols.push({
      key: "bal",
      header: "Balance Due",
      align: "right",
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
 * These mirror Zoho's Advanced Search, minus the fields EGGSY has no equivalent
 * for — GST treatment, place of supply, TCS, tax exemptions and projects are
 * absent by design, and offering them as boxes that filter nothing would be
 * worse than not offering them.
 *
 * The keys must match what the module declares in server/services/search-specs;
 * a key with no counterpart there is read by nothing.
 */
const dated = (label: string): SearchField[] => [
  { key: "date", label, kind: "dateRange" },
  { key: "created", label: "Created Between", kind: "dateRange" },
];

export const BILL_SEARCH: SearchField[] = [
  { key: "number", label: "Bill#", kind: "text" },
  { key: "vendorBillNumber", label: "Vendor Bill#", kind: "text" },
  { key: "reference", label: "Reference#", kind: "text" },
  { key: "vendorId", label: "Vendor", kind: "contact", contactType: "vendor" },
  { key: "vendorPan", label: "Vendor PAN", kind: "text" },
  { key: "status", label: "Status", kind: "select", options: ["open", "partially_paid", "paid", "void"] },
  ...dated("Bill Date"),
  { key: "dueDate", label: "Due Date", kind: "dateRange" },
  { key: "total", label: "Total", kind: "numberRange" },
  { key: "itemDescription", label: "Item Description", kind: "text" },
  { key: "account", label: "Account", kind: "account" },
  { key: "notes", label: "Notes", kind: "text" },
];

export const INVOICE_SEARCH: SearchField[] = [
  { key: "number", label: "Invoice#", kind: "text" },
  { key: "reference", label: "Reference#", kind: "text" },
  { key: "customerId", label: "Customer", kind: "contact", contactType: "customer" },
  { key: "customerGstin", label: "Customer GSTIN", kind: "text" },
  { key: "status", label: "Status", kind: "select", options: ["draft", "sent", "partially_paid", "paid", "void"] },
  ...dated("Invoice Date"),
  { key: "dueDate", label: "Due Date", kind: "dateRange" },
  { key: "total", label: "Total", kind: "numberRange" },
  { key: "itemDescription", label: "Item Description", kind: "text" },
  { key: "account", label: "Account", kind: "account" },
  { key: "notes", label: "Notes", kind: "text" },
];

export const EXPENSE_SEARCH: SearchField[] = [
  { key: "number", label: "Expense#", kind: "text" },
  { key: "reference", label: "Reference#", kind: "text" },
  { key: "vendorId", label: "Vendor", kind: "contact", contactType: "vendor" },
  ...dated("Expense Date"),
  { key: "total", label: "Amount", kind: "numberRange" },
  { key: "account", label: "Expense Account", kind: "account" },
  { key: "notes", label: "Notes", kind: "text" },
];

const paymentSearch = (side: "customer" | "vendor"): SearchField[] => [
  { key: "number", label: "Payment#", kind: "text" },
  { key: "reference", label: "Reference#", kind: "text" },
  {
    key: side === "customer" ? "customerId" : "vendorId",
    label: side === "customer" ? "Customer" : "Vendor",
    kind: "contact",
    contactType: side,
  },
  { key: "mode", label: "Mode", kind: "select", options: ["cash", "bank_transfer", "upi", "cheque", "card"] },
  ...dated("Payment Date"),
  { key: "total", label: "Amount", kind: "numberRange" },
  { key: "notes", label: "Notes", kind: "text" },
];
export const CUSTOMER_PAYMENT_SEARCH = paymentSearch("customer");
export const VENDOR_PAYMENT_SEARCH = paymentSearch("vendor");

export const VENDOR_CREDIT_SEARCH: SearchField[] = [
  { key: "number", label: "Credit Note#", kind: "text" },
  { key: "reference", label: "Reference#", kind: "text" },
  { key: "vendorId", label: "Vendor", kind: "contact", contactType: "vendor" },
  { key: "status", label: "Status", kind: "select", options: ["open", "closed", "void"] },
  ...dated("Credit Date"),
  { key: "total", label: "Total", kind: "numberRange" },
  { key: "account", label: "Account", kind: "account" },
  { key: "notes", label: "Notes", kind: "text" },
];

export const CREDIT_NOTE_SEARCH: SearchField[] = [
  { key: "number", label: "Credit Note#", kind: "text" },
  { key: "reference", label: "Reference#", kind: "text" },
  { key: "customerId", label: "Customer", kind: "contact", contactType: "customer" },
  { key: "status", label: "Status", kind: "select", options: ["open", "closed", "void"] },
  ...dated("Credit Note Date"),
  { key: "total", label: "Total", kind: "numberRange" },
  { key: "account", label: "Account", kind: "account" },
  { key: "notes", label: "Notes", kind: "text" },
];

export const PURCHASE_ORDER_SEARCH: SearchField[] = [
  { key: "number", label: "Order#", kind: "text" },
  { key: "reference", label: "Reference#", kind: "text" },
  { key: "vendorId", label: "Vendor", kind: "contact", contactType: "vendor" },
  {
    key: "status",
    label: "Status",
    kind: "select",
    options: ["draft", "issued", "partially_billed", "billed", "closed", "cancelled"],
  },
  { key: "created", label: "Created Between", kind: "dateRange" },
  { key: "total", label: "Total", kind: "numberRange" },
  { key: "account", label: "Account", kind: "account" },
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

/** Zoho Bills list: Date | Bill# | Reference Number | Vendor | Status | Due Date | Amount | Balance Due | Created By | Created Time */
export const BILL_COLUMNS: Column<DocRow>[] = [
  { key: "date", header: "Date", render: (r) => shortDate(r.billDate as string) },
  { key: "number", header: "Bill#", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
  { key: "reference", header: "Reference Number", render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
  { key: "contact", header: "Vendor Name", render: (r) => <span className="text-gray-800">{r.contactName ?? "—"}</span> },
  { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} dueDate={r.dueDate} /> },
  { key: "due", header: "Due Date", render: (r) => shortDate(r.dueDate) },
  { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.total) },
  { key: "bal", header: "Balance Due", align: "right", render: (r) => formatMoney(r.balanceDue) },
  { key: "createdBy", header: "Created By", render: (r) => <span className="text-gray-600">{(r.createdByName as string) || "—"}</span> },
  { key: "createdTime", header: "Created Time", render: (r) => <span className="whitespace-nowrap text-gray-600">{dateTime(r.createdAt)}</span> },
];

interface SummaryStats {
  totalOutstanding: string;
  dueToday: string;
  dueWithin30Days: string;
  overdue: string;
  avgDaysToGetPaid?: number;
}

/** Zoho's Payment Summary strip above the Invoices / Bills lists. */
function PaymentSummaryBanner({ endpoint, side }: { endpoint: string; side: "receivable" | "payable" }) {
  const { data } = useQuery({
    queryKey: [endpoint],
    queryFn: () => api<SummaryStats>(endpoint),
  });
  const stats = [
    {
      label: side === "receivable" ? "Total Outstanding Receivables" : "Total Outstanding Payables",
      value: formatMoney(data?.totalOutstanding ?? 0),
    },
    { label: "Due Today", value: formatMoney(data?.dueToday ?? 0) },
    { label: "Due Within 30 Days", value: formatMoney(data?.dueWithin30Days ?? 0) },
    {
      label: side === "receivable" ? "Overdue Invoice" : "OverDue Bills",
      value: formatMoney(data?.overdue ?? 0),
    },
    ...(side === "receivable"
      ? [{ label: "Average No. of Days for Getting Paid", value: `${data?.avgDaysToGetPaid ?? 0} Days` }]
      : []),
  ];
  return (
    <div
      className={`grid gap-6 border-b bg-white px-5 py-4 ${side === "receivable" ? "grid-cols-5" : "grid-cols-4"}`}
    >
      {stats.map((s) => (
        <div key={s.label}>
          <div className="text-[13px] font-semibold tabular-nums text-gray-800">{s.value}</div>
          <div className="mt-0.5 text-xs text-gray-500">{s.label}</div>
        </div>
      ))}
    </div>
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
    columns={[
      { key: "date", header: "Date", render: (r) => shortDate(r.paymentDate as string) },
      { key: "number", header: "Payment #", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "reference", header: "Reference Number", render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Customer Name", render: (r) => r.contactName ?? "—" },
      { key: "invoices", header: "Invoice#", render: (r) => <span className="text-gray-600">{(r.invoiceNumbers as string) || "—"}</span> },
      { key: "mode", header: "Mode", render: (r) => <span className="capitalize">{String(r.mode ?? "").replace(/_/g, " ")}</span> },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
      { key: "unapplied", header: "Unused Amount", align: "right", render: (r) => formatMoney(r.unappliedAmount) },
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
    columns={[
      { key: "date", header: "Date", render: (r) => shortDate(r.orderDate as string) },
      { key: "number", header: "Purchase Order#", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "reference", header: "Reference#", render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Vendor Name", render: (r) => <span className="text-gray-800">{r.contactName ?? "—"}</span> },
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
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.total) },
      {
        key: "delivery",
        header: "Delivery Date",
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
      extraActions={
        <button onClick={() => navigate("/purchases/bills/new?upload=1")} className="btn-secondary">
          Upload Bill
        </button>
      }
    />
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
    columns={[
      { key: "date", header: "Date", render: (r) => shortDate(r.paymentDate as string) },
      { key: "number", header: "Payment #", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "reference", header: "Reference#", render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Vendor Name", render: (r) => r.contactName ?? "—" },
      { key: "bills", header: "Bill#", render: (r) => <span className="text-gray-600">{(r.billNumbers as string) || "—"}</span> },
      { key: "mode", header: "Mode", render: (r) => <span className="capitalize">{String(r.mode ?? "").replace(/_/g, " ")}</span> },
      { key: "status", header: "Status", render: () => <StatusBadge status="paid" /> },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
      { key: "unapplied", header: "Unused Amount", align: "right", render: (r) => formatMoney(r.unappliedAmount) },
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
    columns={[
      { key: "date", header: "Date", render: (r) => shortDate(r.creditDate as string) },
      { key: "number", header: "Credit Note#", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "reference", header: "Reference Number", render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Vendor Name", render: (r) => <span className="text-gray-800">{r.contactName ?? "—"}</span> },
      { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.total) },
      { key: "bal", header: "Balance", align: "right", render: (r) => formatMoney(r.balance) },
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
    columns={[
      { key: "date", header: "Date", render: (r) => shortDate(r.expenseDate as string) },
      { key: "account", header: "Expense Account", render: (r) => <span className="text-gray-800">{(r.expenseAccountName as string) ?? "—"}</span> },
      { key: "ref", header: "Reference#", render: (r) => <span className="text-gray-600">{(r.reference as string) || "—"}</span> },
      { key: "contact", header: "Vendor Name", render: (r) => r.contactName ?? "—" },
      { key: "paidThrough", header: "Paid Through", render: (r) => <span className="text-gray-600">{(r.paidThroughName as string) ?? "—"}</span> },
      {
        key: "status",
        header: "Status",
        render: () => (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Non-Billable</span>
        ),
      },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
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
