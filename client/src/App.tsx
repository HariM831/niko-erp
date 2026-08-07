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
        <Route path="/items" component={ItemsPage} />
        <Route path="/banking" component={BankingPage} />
        <Route path="/sales/customers" component={CustomersPage} />
        <Route path="/sales/estimates" component={EstimatesPage} />
        <Route path="/sales/sales-orders" component={SalesOrdersPage} />
        <Route path="/sales/invoices" component={InvoicesPage} />
        <Route path="/sales/payments" component={CustomerPaymentsPage} />
        <Route path="/sales/credit-notes" component={CreditNotesPage} />
        <Route path="/purchases/vendors" component={VendorsPage} />
        <Route path="/purchases/expenses" component={ExpensesPage} />
        <Route path="/purchases/orders" component={PurchaseOrdersPage} />
        <Route path="/purchases/bills" component={BillsPage} />
        <Route path="/purchases/payments" component={VendorPaymentsPage} />
        <Route path="/purchases/vendor-credits" component={VendorCreditsPage} />
        <Route path="/accountant/journals" component={JournalsPage} />
        <Route path="/accountant/accounts" component={AccountsPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route>
          <div className="p-8 text-sm text-gray-500">Page not found.</div>
        </Route>
      </Switch>
    </AppLayout>
  );
}
