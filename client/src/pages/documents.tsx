import { ListPage, StatusBadge, type ListView } from "../components/list-page";
import { formatDate, formatMoney } from "../api";

interface DocRow {
  id: string;
  number: string;
  status: string;
  total?: string;
  balanceDue?: string;
  balance?: string;
  amount?: string;
  unappliedAmount?: string;
  [k: string]: unknown;
}

function docColumns(dateKey: string, opts: { balance?: "balanceDue" | "balance" | "unappliedAmount"; amountKey?: string }) {
  const cols = [
    { key: "date", header: "Date", render: (r: DocRow) => formatDate(r[dateKey] as string) },
    { key: "number", header: "Number", render: (r: DocRow) => <span className="font-medium text-brand-600">{r.number}</span> },
    { key: "status", header: "Status", render: (r: DocRow) => <StatusBadge status={r.status} /> },
    {
      key: "amount",
      header: "Amount",
      align: "right" as const,
      render: (r: DocRow) => formatMoney((r[opts.amountKey ?? "total"] as string) ?? r.total),
    },
  ];
  if (opts.balance) {
    cols.push({
      key: "bal",
      header: opts.balance === "unappliedAmount" ? "Unapplied" : "Balance Due",
      align: "right" as const,
      render: (r: DocRow) => formatMoney(r[opts.balance!] as string),
    });
  }
  return cols;
}

const statusViews = (statuses: string[]): ListView[] => [
  { label: "All", params: {} },
  ...statuses.map((s) => ({ label: s.replace(/_/g, " "), params: { status: s } })),
];

export const InvoicesPage = () => (
  <ListPage<DocRow>
    title="Invoices"
    endpoint="/api/sales/invoices"
    rowKey={(r) => r.id}
    views={statusViews(["draft", "sent", "partially_paid", "paid", "void"])}
    newLabel="New Invoice"
    newPath="/sales/invoices/new"
    rowPath={(r) => `/sales/invoices/${r.id}`}
    columns={docColumns("invoiceDate", { balance: "balanceDue" })}
  />
);

export const EstimatesPage = () => (
  <ListPage<DocRow>
    title="Estimates"
    endpoint="/api/sales/estimates"
    rowKey={(r) => r.id}
    views={statusViews(["draft", "sent", "accepted", "declined", "invoiced"])}
    newLabel="New Estimate"
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
    newLabel="New Sales Order"
    newPath="/sales/sales-orders/new"
    rowPath={(r) => `/sales/sales-orders/${r.id}`}
    columns={docColumns("orderDate", {})}
  />
);

export const CustomerPaymentsPage = () => (
  <ListPage<DocRow>
    title="Payments Received"
    endpoint="/api/sales/payments"
    rowKey={(r) => r.id}
    newLabel="Record Payment"
    newPath="/sales/payments/new"
    columns={[
      { key: "date", header: "Date", render: (r) => formatDate(r.paymentDate as string) },
      { key: "number", header: "Number", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "mode", header: "Mode", render: (r) => String(r.mode ?? "").replace(/_/g, " ") },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
      { key: "unapplied", header: "Unapplied", align: "right", render: (r) => formatMoney(r.unappliedAmount) },
    ]}
  />
);

export const CreditNotesPage = () => (
  <ListPage<DocRow>
    title="Credit Notes"
    endpoint="/api/sales/credit-notes"
    rowKey={(r) => r.id}
    views={statusViews(["open", "closed", "void"])}
    newLabel="New Credit Note"
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
    newLabel="New Purchase Order"
    newPath="/purchases/orders/new"
    rowPath={(r) => `/purchases/orders/${r.id}`}
    columns={docColumns("orderDate", {})}
  />
);

export const BillsPage = () => (
  <ListPage<DocRow>
    title="Bills"
    endpoint="/api/purchases/bills"
    rowKey={(r) => r.id}
    views={statusViews(["open", "partially_paid", "paid", "void"])}
    newLabel="New Bill"
    newPath="/purchases/bills/new"
    rowPath={(r) => `/purchases/bills/${r.id}`}
    columns={docColumns("billDate", { balance: "balanceDue" })}
  />
);

export const VendorPaymentsPage = () => (
  <ListPage<DocRow>
    title="Payments Made"
    endpoint="/api/purchases/payments"
    rowKey={(r) => r.id}
    newLabel="Record Payment"
    newPath="/purchases/payments/new"
    columns={[
      { key: "date", header: "Date", render: (r) => formatDate(r.paymentDate as string) },
      { key: "number", header: "Number", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
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
    newLabel="New Vendor Credit"
    newPath="/purchases/vendor-credits/new"
    rowPath={(r) => `/purchases/vendor-credits/${r.id}`}
    columns={docColumns("creditDate", { balance: "balance" })}
  />
);

export const ExpensesPage = () => (
  <ListPage<DocRow>
    title="Expenses"
    endpoint="/api/purchases/expenses"
    rowKey={(r) => r.id}
    newLabel="Record Expense"
    newPath="/purchases/expenses/new"
    columns={[
      { key: "date", header: "Date", render: (r) => formatDate(r.expenseDate as string) },
      { key: "number", header: "Number", render: (r) => <span className="font-medium text-brand-600">{r.number}</span> },
      { key: "ref", header: "Reference", render: (r) => String(r.reference ?? "—") },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
    ]}
  />
);
