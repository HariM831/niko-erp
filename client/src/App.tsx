import { Route, Switch } from "wouter";
import { useAuth } from "./auth";
import { AppLayout } from "./components/layout";
import { LoginPage } from "./pages/login";
import { HomePage } from "./pages/home";
import { ReportsPage } from "./pages/reports";
import {
  AccountsPage,
  BankingPage,
  CustomersPage,
  ItemsPage,
  JournalsPage,
  VendorsPage,
} from "./pages/masters";
import {
  BillsPage,
  CreditNotesPage,
  CustomerPaymentsPage,
  EstimatesPage,
  ExpensesPage,
  InvoicesPage,
  PurchaseOrdersPage,
  SalesOrdersPage,
  VendorCreditsPage,
  VendorPaymentsPage,
} from "./pages/documents";
import { TransactionNewPage } from "./pages/transaction-new";
import { PaymentNewPage } from "./pages/payment-new";
import { ExpenseNewPage } from "./pages/expense-new";
import { DocumentDetailPage } from "./pages/document-detail";
import { ContactNewPage } from "./pages/contact-new";
import { ContactDetailPage } from "./pages/contact-detail";
import { ItemNewPage } from "./pages/item-new";
import { JournalNewPage } from "./pages/journal-new";
import { BankAccountNewPage, BankingDetailPage } from "./pages/banking-detail";
import { SettingsPage } from "./pages/settings";
import { ActivityLogPage } from "./pages/activity-log";
import { ItemDetailPage } from "./pages/item-detail";
import {
  AccountLedgerPage,
  ExpenseDetailPage,
  JournalDetailPage,
  PaymentDetailPage,
} from "./pages/record-details";
import { DocumentSplitView } from "./components/split-view";

const SPLIT: Record<string, { endpoint: string; basePath: string; title: string; newPath: string; dateKey: string }> = {
  invoice: { endpoint: "/api/sales/invoices", basePath: "/sales/invoices", title: "Invoices", newPath: "/sales/invoices/new", dateKey: "invoiceDate" },
  estimate: { endpoint: "/api/sales/estimates", basePath: "/sales/estimates", title: "Estimates", newPath: "/sales/estimates/new", dateKey: "estimateDate" },
  "sales-order": { endpoint: "/api/sales/sales-orders", basePath: "/sales/sales-orders", title: "Sales Orders", newPath: "/sales/sales-orders/new", dateKey: "orderDate" },
  "credit-note": { endpoint: "/api/sales/credit-notes", basePath: "/sales/credit-notes", title: "Credit Notes", newPath: "/sales/credit-notes/new", dateKey: "creditNoteDate" },
  bill: { endpoint: "/api/purchases/bills", basePath: "/purchases/bills", title: "Bills", newPath: "/purchases/bills/new", dateKey: "billDate" },
  "purchase-order": { endpoint: "/api/purchases/orders", basePath: "/purchases/orders", title: "Purchase Orders", newPath: "/purchases/orders/new", dateKey: "orderDate" },
  "vendor-credit": { endpoint: "/api/purchases/vendor-credits", basePath: "/purchases/vendor-credits", title: "Vendor Credits", newPath: "/purchases/vendor-credits/new", dateKey: "creditDate" },
};

function SplitDetail({ kind, id }: { kind: string; id: string }) {
  const cfg = SPLIT[kind]!;
  return (
    <DocumentSplitView {...cfg} activeId={id}>
      <DocumentDetailPage kind={kind} id={id} />
    </DocumentSplitView>
  );
}

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-sm text-gray-500">Loading…</div>;
  }
  if (!user) return <LoginPage />;

  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/items/new">{() => <ItemNewPage />}</Route>
        <Route path="/items/:id/edit">{(p) => <ItemNewPage editId={p.id!} />}</Route>
        <Route path="/items/:id">{(p) => <ItemDetailPage id={p.id!} />}</Route>
        <Route path="/items" component={ItemsPage} />
        <Route path="/banking/new" component={BankAccountNewPage} />
        <Route path="/banking/:id">{(p) => <BankingDetailPage bankAccountId={p.id!} />}</Route>
        <Route path="/banking" component={BankingPage} />
        <Route path="/sales/customers/new">{() => <ContactNewPage type="customer" />}</Route>
        <Route path="/sales/customers/:id/edit">{(p) => <ContactNewPage type="customer" editId={p.id!} />}</Route>
        <Route path="/sales/customers/:id">{(p) => <ContactDetailPage id={p.id!} />}</Route>
        <Route path="/sales/customers" component={CustomersPage} />
        <Route path="/sales/estimates/new">{() => <TransactionNewPage kind="estimate" />}</Route>
        <Route path="/sales/estimates/:id">{(p) => <SplitDetail kind="estimate" id={p.id!} />}</Route>
        <Route path="/sales/estimates" component={EstimatesPage} />
        <Route path="/sales/sales-orders/new">{() => <TransactionNewPage kind="sales-order" />}</Route>
        <Route path="/sales/sales-orders/:id">{(p) => <SplitDetail kind="sales-order" id={p.id!} />}</Route>
        <Route path="/sales/sales-orders" component={SalesOrdersPage} />
        <Route path="/sales/invoices/new">{() => <TransactionNewPage kind="invoice" />}</Route>
        <Route path="/sales/invoices/:id/edit">{(p) => <TransactionNewPage kind="invoice" editId={p.id!} />}</Route>
        <Route path="/sales/invoices/:id">{(p) => <SplitDetail kind="invoice" id={p.id!} />}</Route>
        <Route path="/sales/invoices" component={InvoicesPage} />
        <Route path="/sales/payments/new">{() => <PaymentNewPage side="customer" />}</Route>
        <Route path="/sales/payments/:id">{(p) => <PaymentDetailPage side="customer" id={p.id!} />}</Route>
        <Route path="/sales/payments" component={CustomerPaymentsPage} />
        <Route path="/sales/credit-notes/new">{() => <TransactionNewPage kind="credit-note" />}</Route>
        <Route path="/sales/credit-notes/:id">{(p) => <SplitDetail kind="credit-note" id={p.id!} />}</Route>
        <Route path="/sales/credit-notes" component={CreditNotesPage} />
        <Route path="/purchases/vendors/new">{() => <ContactNewPage type="vendor" />}</Route>
        <Route path="/purchases/vendors/:id/edit">{(p) => <ContactNewPage type="vendor" editId={p.id!} />}</Route>
        <Route path="/purchases/vendors/:id">{(p) => <ContactDetailPage id={p.id!} />}</Route>
        <Route path="/purchases/vendors" component={VendorsPage} />
        <Route path="/purchases/expenses/new" component={ExpenseNewPage} />
        <Route path="/purchases/expenses/:id">{(p) => <ExpenseDetailPage id={p.id!} />}</Route>
        <Route path="/purchases/expenses" component={ExpensesPage} />
        <Route path="/purchases/orders/new">{() => <TransactionNewPage kind="purchase-order" />}</Route>
        <Route path="/purchases/orders/:id">{(p) => <SplitDetail kind="purchase-order" id={p.id!} />}</Route>
        <Route path="/purchases/orders" component={PurchaseOrdersPage} />
        <Route path="/purchases/bills/new">{() => <TransactionNewPage kind="bill" />}</Route>
        <Route path="/purchases/bills/:id">{(p) => <SplitDetail kind="bill" id={p.id!} />}</Route>
        <Route path="/purchases/bills" component={BillsPage} />
        <Route path="/purchases/payments/new">{() => <PaymentNewPage side="vendor" />}</Route>
        <Route path="/purchases/payments/:id">{(p) => <PaymentDetailPage side="vendor" id={p.id!} />}</Route>
        <Route path="/purchases/payments" component={VendorPaymentsPage} />
        <Route path="/purchases/vendor-credits/new">{() => <TransactionNewPage kind="vendor-credit" />}</Route>
        <Route path="/purchases/vendor-credits/:id">{(p) => <SplitDetail kind="vendor-credit" id={p.id!} />}</Route>
        <Route path="/purchases/vendor-credits" component={VendorCreditsPage} />
        <Route path="/accountant/journals/new" component={JournalNewPage} />
        <Route path="/accountant/journals/:id">{(p) => <JournalDetailPage id={p.id!} />}</Route>
        <Route path="/accountant/journals" component={JournalsPage} />
        <Route path="/accountant/accounts/:id">{(p) => <AccountLedgerPage id={p.id!} />}</Route>
        <Route path="/accountant/accounts" component={AccountsPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/activity-log" component={ActivityLogPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route>
          <div className="p-8 text-sm text-gray-500">Page not found.</div>
        </Route>
      </Switch>
    </AppLayout>
  );
}
