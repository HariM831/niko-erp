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
        <Route path="/items/new" component={ItemNewPage} />
        <Route path="/items" component={ItemsPage} />
        <Route path="/banking/new" component={BankAccountNewPage} />
        <Route path="/banking/:id">{(p) => <BankingDetailPage bankAccountId={p.id!} />}</Route>
        <Route path="/banking" component={BankingPage} />
        <Route path="/sales/customers/new">{() => <ContactNewPage type="customer" />}</Route>
        <Route path="/sales/customers/:id">{(p) => <ContactDetailPage id={p.id!} />}</Route>
        <Route path="/sales/customers" component={CustomersPage} />
        <Route path="/sales/estimates/new">{() => <TransactionNewPage kind="estimate" />}</Route>
        <Route path="/sales/estimates/:id">{(p) => <DocumentDetailPage kind="estimate" id={p.id!} />}</Route>
        <Route path="/sales/estimates" component={EstimatesPage} />
        <Route path="/sales/sales-orders/new">{() => <TransactionNewPage kind="sales-order" />}</Route>
        <Route path="/sales/sales-orders/:id">{(p) => <DocumentDetailPage kind="sales-order" id={p.id!} />}</Route>
        <Route path="/sales/sales-orders" component={SalesOrdersPage} />
        <Route path="/sales/invoices/new">{() => <TransactionNewPage kind="invoice" />}</Route>
        <Route path="/sales/invoices/:id">{(p) => <DocumentDetailPage kind="invoice" id={p.id!} />}</Route>
        <Route path="/sales/invoices" component={InvoicesPage} />
        <Route path="/sales/payments/new">{() => <PaymentNewPage side="customer" />}</Route>
        <Route path="/sales/payments" component={CustomerPaymentsPage} />
        <Route path="/sales/credit-notes/new">{() => <TransactionNewPage kind="credit-note" />}</Route>
        <Route path="/sales/credit-notes/:id">{(p) => <DocumentDetailPage kind="credit-note" id={p.id!} />}</Route>
        <Route path="/sales/credit-notes" component={CreditNotesPage} />
        <Route path="/purchases/vendors/new">{() => <ContactNewPage type="vendor" />}</Route>
        <Route path="/purchases/vendors/:id">{(p) => <ContactDetailPage id={p.id!} />}</Route>
        <Route path="/purchases/vendors" component={VendorsPage} />
        <Route path="/purchases/expenses/new" component={ExpenseNewPage} />
        <Route path="/purchases/expenses" component={ExpensesPage} />
        <Route path="/purchases/orders/new">{() => <TransactionNewPage kind="purchase-order" />}</Route>
        <Route path="/purchases/orders/:id">{(p) => <DocumentDetailPage kind="purchase-order" id={p.id!} />}</Route>
        <Route path="/purchases/orders" component={PurchaseOrdersPage} />
        <Route path="/purchases/bills/new">{() => <TransactionNewPage kind="bill" />}</Route>
        <Route path="/purchases/bills/:id">{(p) => <DocumentDetailPage kind="bill" id={p.id!} />}</Route>
        <Route path="/purchases/bills" component={BillsPage} />
        <Route path="/purchases/payments/new">{() => <PaymentNewPage side="vendor" />}</Route>
        <Route path="/purchases/payments" component={VendorPaymentsPage} />
        <Route path="/purchases/vendor-credits/new">{() => <TransactionNewPage kind="vendor-credit" />}</Route>
        <Route path="/purchases/vendor-credits/:id">{(p) => <DocumentDetailPage kind="vendor-credit" id={p.id!} />}</Route>
        <Route path="/purchases/vendor-credits" component={VendorCreditsPage} />
        <Route path="/accountant/journals/new" component={JournalNewPage} />
        <Route path="/accountant/journals" component={JournalsPage} />
        <Route path="/accountant/accounts" component={AccountsPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route>
          <div className="p-8 text-sm text-gray-500">Page not found.</div>
        </Route>
      </Switch>
    </AppLayout>
  );
}
