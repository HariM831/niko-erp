import { TransactionForm, type TransactionFormConfig } from "../components/transaction-form";

const configs: Record<string, TransactionFormConfig> = {
  invoice: {
    title: "New Invoice",
    endpoint: "/api/sales/invoices",
    listPath: "/sales/invoices",
    contactType: "customer",
    contactLabel: "Customer",
    dateField: "invoiceDate",
    dateLabel: "Invoice Date",
    withSend: true,
  },
  estimate: {
    title: "New Estimate",
    endpoint: "/api/sales/estimates",
    listPath: "/sales/estimates",
    contactType: "customer",
    contactLabel: "Customer",
    dateField: "estimateDate",
    dateLabel: "Estimate Date",
  },
  "sales-order": {
    title: "New Sales Order",
    endpoint: "/api/sales/sales-orders",
    listPath: "/sales/sales-orders",
    contactType: "customer",
    contactLabel: "Customer",
    dateField: "orderDate",
    dateLabel: "Order Date",
  },
  "credit-note": {
    title: "New Credit Note",
    endpoint: "/api/sales/credit-notes",
    listPath: "/sales/credit-notes",
    contactType: "customer",
    contactLabel: "Customer",
    dateField: "creditNoteDate",
    dateLabel: "Credit Note Date",
  },
  bill: {
    title: "New Bill",
    endpoint: "/api/purchases/bills",
    listPath: "/purchases/bills",
    contactType: "vendor",
    contactLabel: "Vendor",
    dateField: "billDate",
    dateLabel: "Bill Date",
    withAccountColumn: true,
  },
  "purchase-order": {
    title: "New Purchase Order",
    endpoint: "/api/purchases/orders",
    listPath: "/purchases/orders",
    contactType: "vendor",
    contactLabel: "Vendor",
    dateField: "orderDate",
    dateLabel: "Order Date",
    withAccountColumn: true,
  },
  "vendor-credit": {
    title: "New Vendor Credit",
    endpoint: "/api/purchases/vendor-credits",
    listPath: "/purchases/vendor-credits",
    contactType: "vendor",
    contactLabel: "Vendor",
    dateField: "creditDate",
    dateLabel: "Credit Date",
    withAccountColumn: true,
  },
};

export function TransactionNewPage({ kind }: { kind: string }) {
  const config = configs[kind];
  if (!config) return <div className="p-8 text-sm text-gray-500">Unknown transaction type.</div>;
  return <TransactionForm config={config} />;
}
