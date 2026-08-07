import { ListPage, StatusBadge, type Column, type ListView } from "../components/list-page";
import { formatMoney } from "../api";

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
}

export function docColumns(dateKey: string, opts: DocColumnOpts): Column<DocRow>[] {
  const cols: Column<DocRow>[] = [
    { key: "date", header: "Date", render: (r) => shortDate(r[dateKey] as string) },
    {
      key: "number",
      header: "Number",
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

export const INVOICE_VIEWS = statusViews(["draft", "sent", "partially_paid", "paid", "void"]);
export const INVOICE_COLUMNS = docColumns("invoiceDate", { balance: "balanceDue", dueDate: true });
export const BILL_VIEWS = statusViews(["open", "partially_paid", "paid", "void"]);
export const BILL_COLUMNS = docColumns("billDate", {
  balance: "balanceDue",
  dueDate: true,
  contactHeader: "Vendor Name",
});

export const InvoicesPage = () => (
  <ListPage<DocRow>
    title="Invoices"
    endpoint="/api/sales/invoices"
    rowKey={(r) => r.id}
    views={INVOICE_VIEWS}
    newPath="/sales/invoices/new"
    rowPath={(r) => `/sales/invoices/${r.id}`}
    columns={INVOICE_COLUMNS}
  />
);

export const EstimatesPage = () => (
  <ListPage<DocRow>
    title="Estimates"
    endpoint="/api/sales/estimates"
    rowKey={(r) => r.id}
    views={statusViews(["draft", "sent", "accepted", "declined", "invoiced"])}
    newPath="/sales/estimates/new"
    rowPath={(r) => `/sales/estimates/${r.id}`}
    columns={docColumns("estimateDate", {})}
  />
);

export const SalesOrdersPage = () => (
  <ListPage<DocRow>
    title="Sales Orders"
    endpoint="/api/sales/sales-orders"
    rowKey={(r) => r.id}
    views={statusViews(["draft", "confirmed", "closed", "void"])}
    newPath="/sales/sales-orders/new"
    rowPath={(r) => `/sales/sales-orders/${r.id}`}
    columns={docColumns("orderDate", {})}
  />
);

export const CustomerPaymentsPage = () => (
  <ListPage<DocRow>
    title="Payments"
    endpoint="/api/sales/payments"
    rowKey={(r) => r.id}
    newPath="/sales/payments/new"
    columns={[
      { key: "date", header: "Date", render: (r) => shortDate(r.paymentDate as string) },
      { key: "number", header: "Payment #", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "contact", header: "Customer Name", render: (r) => r.contactName ?? "—" },
      { key: "mode", header: "Mode", render: (r) => <span className="capitalize">{String(r.mode ?? "").replace(/_/g, " ")}</span> },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
      { key: "unapplied", header: "Unused Amount", align: "right", render: (r) => formatMoney(r.unappliedAmount) },
    ]}
  />
);

export const CreditNotesPage = () => (
  <ListPage<DocRow>
    title="Credit Notes"
    endpoint="/api/sales/credit-notes"
    rowKey={(r) => r.id}
    views={statusViews(["open", "closed", "void"])}
    newPath="/sales/credit-notes/new"
    rowPath={(r) => `/sales/credit-notes/${r.id}`}
    columns={docColumns("creditNoteDate", { balance: "balance" })}
  />
);

export const PurchaseOrdersPage = () => (
  <ListPage<DocRow>
    title="Purchase Orders"
    endpoint="/api/purchases/orders"
    rowKey={(r) => r.id}
    views={statusViews(["draft", "issued", "partially_billed", "billed", "closed", "cancelled"])}
    newPath="/purchases/orders/new"
    rowPath={(r) => `/purchases/orders/${r.id}`}
    columns={docColumns("orderDate", { contactHeader: "Vendor Name" })}
  />
);

export const BillsPage = () => (
  <ListPage<DocRow>
    title="Bills"
    endpoint="/api/purchases/bills"
    rowKey={(r) => r.id}
    views={BILL_VIEWS}
    newPath="/purchases/bills/new"
    rowPath={(r) => `/purchases/bills/${r.id}`}
    columns={BILL_COLUMNS}
  />
);

export const VendorPaymentsPage = () => (
  <ListPage<DocRow>
    title="Payments Made"
    endpoint="/api/purchases/payments"
    rowKey={(r) => r.id}
    newPath="/purchases/payments/new"
    columns={[
      { key: "date", header: "Date", render: (r) => shortDate(r.paymentDate as string) },
      { key: "number", header: "Payment #", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "contact", header: "Vendor Name", render: (r) => r.contactName ?? "—" },
      { key: "tds", header: "TDS", align: "right", render: (r) => formatMoney(r.tdsAmount as string) },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
    ]}
  />
);

export const VendorCreditsPage = () => (
  <ListPage<DocRow>
    title="Vendor Credits"
    endpoint="/api/purchases/vendor-credits"
    rowKey={(r) => r.id}
    views={statusViews(["open", "closed", "void"])}
    newPath="/purchases/vendor-credits/new"
    rowPath={(r) => `/purchases/vendor-credits/${r.id}`}
    columns={docColumns("creditDate", { balance: "balance", contactHeader: "Vendor Name" })}
  />
);

export const ExpensesPage = () => (
  <ListPage<DocRow>
    title="Expenses"
    endpoint="/api/purchases/expenses"
    rowKey={(r) => r.id}
    newPath="/purchases/expenses/new"
    columns={[
      { key: "date", header: "Date", render: (r) => shortDate(r.expenseDate as string) },
      { key: "number", header: "Expense #", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "contact", header: "Vendor Name", render: (r) => r.contactName ?? "—" },
      { key: "ref", header: "Reference", render: (r) => String(r.reference ?? "—") },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
    ]}
  />
);
