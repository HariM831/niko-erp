import { TransactionForm, type TransactionFormConfig } from "../components/transaction-form";

const configs: Record<string, TransactionFormConfig> = {
  invoice: {
    title: "New Invoice",
    entityType: "invoice",
    endpoint: "/api/sales/invoices",
    listPath: "/sales/invoices",
    contactType: "customer",
    contactLabel: "Customer",
    dateField: "invoiceDate",
    dateLabel: "Invoice Date",
    withAccountColumn: true,
    withSend: true,
  },
  "credit-note": {
    title: "New Credit Note",
    entityType: "credit_note",
    endpoint: "/api/sales/credit-notes",
    listPath: "/sales/credit-notes",
    contactType: "customer",
    contactLabel: "Customer",
    dateField: "creditNoteDate",
    dateLabel: "Credit Note Date",
    withAccountColumn: true,
  },
  bill: {
    title: "New Bill",
    entityType: "bill",
    endpoint: "/api/purchases/bills",
    listPath: "/purchases/bills",
    contactType: "vendor",
    contactLabel: "Vendor",
    dateField: "billDate",
    dateLabel: "Bill Date",
    withAccountColumn: true,
    withVendorBillNumber: true,
    withFreight: true,
  },
  "purchase-order": {
    title: "New Purchase Order",
    entityType: "purchase_order",
    endpoint: "/api/purchases/orders",
    listPath: "/purchases/orders",
    contactType: "vendor",
    contactLabel: "Vendor",
    dateField: "orderDate",
    dateLabel: "Order Date",
    withAccountColumn: true,
    withDeliveryDate: true,
  },
  "vendor-credit": {
    title: "New Vendor Credit",
    entityType: "vendor_credit",
    endpoint: "/api/purchases/vendor-credits",
    listPath: "/purchases/vendor-credits",
    contactType: "vendor",
    contactLabel: "Vendor",
    dateField: "creditDate",
    dateLabel: "Credit Date",
    withAccountColumn: true,
  },
};

export function TransactionNewPage({ kind, editId }: { kind: string; editId?: string }) {
  const config = configs[kind];
  if (!config) return <div className="p-8 text-sm text-gray-500">Unknown transaction type.</div>;
  return <TransactionForm config={config} editId={editId} />;
}
