import { Redirect, Route, Switch } from "wouter";
import { useAuth } from "./auth";
import { AppLayout } from "./components/layout";
import { LoginPage } from "./pages/login";
import { HomePage } from "./pages/home";
import { ReportsPage, ReportViewPage } from "./pages/reports";
import { WeeklySummaryPage } from "./pages/report-weekly-summary";
import { OwnerBillingPage } from "./pages/owner-billing";
import { ChartOfAccountsPage } from "./pages/chart-of-accounts";
import { TransactionLockingPage } from "./pages/transaction-locking";
import { BudgetDetailPage, BudgetNewPage, BudgetsPage } from "./pages/budgets";
import { BulkUpdatePage } from "./pages/bulk-update";
import { FeedFormulasPage } from "./pages/feed-formulas";
import { FeedProductionPage } from "./pages/feed-production";
import { FarmsHousesPage } from "./pages/farms-houses";
import { FarmsBatchesPage } from "./pages/farms-batches";
import { ShedConditionsPage } from "./pages/shed-conditions";
import { FarmStorePage } from "./pages/farm-store";
import { DrEggsyPage } from "./pages/dr-eggsy";
import { EggAgreementsPage } from "./pages/egg-agreements";
import { EggCalendarPage } from "./pages/egg-calendar";
import { EggBenchmarkPage } from "./pages/egg-benchmark";
import { EggLoadingPage } from "./pages/egg-loading";
import { EggGradingPage } from "./pages/egg-grading";
import { HouseDetailPage } from "./pages/house-detail";
import { FlockDetailPage } from "./pages/flock-detail";
import {
  CustomersPage,
  ItemsPage,
  JournalsPage,
  VendorsPage,
} from "./pages/masters";
import {
  BillsPage,
  CreditNotesPage,
  CustomerPaymentsPage,
  ExpensesPage,
  InvoicesPage,
  PurchaseOrdersPage,
  VendorCreditsPage,
  VendorPaymentsPage,
} from "./pages/documents";
import { TransactionNewPage } from "./pages/transaction-new";
import { PaymentNewPage } from "./pages/payment-new";
import { PaymentsPage } from "./pages/payments";
import { ExpenseNewPage } from "./pages/expense-new";
import { DocumentDetailPage } from "./pages/document-detail";
import { ContactNewPage } from "./pages/contact-new";
import { ContactDetailPage } from "./pages/contact-detail";
import { ItemNewPage } from "./pages/item-new";
import { JournalNewPage } from "./pages/journal-new";
import { BankAccountNewPage, BankingDetailPage } from "./pages/banking-detail";
import { BankingOverviewPage } from "./pages/banking-overview";
import { SettingsPage } from "./pages/settings";
import {
  FixedAssetDetailPage,
  FixedAssetNewPage,
  FixedAssetsPage,
} from "./pages/fixed-assets";
import {
  InventoryAdjustmentDetailPage,
  InventoryAdjustmentNewPage,
  InventoryAdjustmentsPage,
  StockPage,
} from "./pages/inventory";
import { ActivityLogPage } from "./pages/activity-log";
import { ItemDetailPage } from "./pages/item-detail";
import {
  AccountLedgerPage,
  ExpenseDetailPage,
  JournalDetailPage,
  PaymentDetailPage,
} from "./pages/record-details";
import { DocumentSplitView } from "./components/split-view";
import { OfficeStationPage } from "./pages/office";
import { GoodsReceiptsPage } from "./pages/office-receipts";
import { GateInPage } from "./pages/office-gate";
import { StationPage, isStation, stationPath } from "./pages/office-stations";
import { SettlementPage } from "./pages/office-settlement";
import { PayrollOverviewPage } from "./pages/payroll/overview";
import { PayrollEmployeesPage } from "./pages/payroll/employees";
import { PayrollTimePage } from "./pages/payroll/time";
import { PayrollGatePage } from "./pages/payroll/gate";
import { PayrollFaceEnrollmentPage } from "./pages/payroll/face-enrollment";
import { PayrollPayInputsPage } from "./pages/payroll/pay-inputs";
import { PayrollRunPage } from "./pages/payroll/run";
import { PayrollWagesPage } from "./pages/payroll/wages";
import { PayrollCanteenPage } from "./pages/payroll/canteen";
import { PayrollDevicesPage } from "./pages/payroll/devices";

const SPLIT: Record<string, { endpoint: string; basePath: string; title: string; newPath: string; dateKey: string }> = {
  invoice: { endpoint: "/api/sales/invoices", basePath: "/sales/invoices", title: "Invoices", newPath: "/sales/invoices/new", dateKey: "invoiceDate" },
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
        {/* A spec is a fact about a material, so it lives on the material.
            The old index redirects rather than 404ing. */}
        <Route path="/items/quality-specs">{() => <Redirect to="/items" />}</Route>
        <Route path="/items/:id/edit">{(p) => <ItemNewPage editId={p.id!} />}</Route>
        <Route path="/items/:id">{(p) => <ItemDetailPage id={p.id!} />}</Route>
        <Route path="/items" component={ItemsPage} />
        <Route path="/banking/new">{() => <BankAccountNewPage />}</Route>
        <Route path="/banking/:id/edit">{(p) => <BankAccountNewPage editId={p.id!} />}</Route>
        <Route path="/banking/:id">{(p) => <BankingDetailPage bankAccountId={p.id!} />}</Route>
        <Route path="/banking" component={BankingOverviewPage} />
        <Route path="/sales/customers/new">{() => <ContactNewPage type="customer" />}</Route>
        <Route path="/sales/customers/:id/edit">{(p) => <ContactNewPage type="customer" editId={p.id!} />}</Route>
        <Route path="/sales/customers/:id">{(p) => <ContactDetailPage id={p.id!} />}</Route>
        <Route path="/sales/customers" component={CustomersPage} />
        <Route path="/sales/invoices/new">{() => <TransactionNewPage kind="invoice" />}</Route>
        <Route path="/sales/invoices/:id/edit">{(p) => <TransactionNewPage kind="invoice" editId={p.id!} />}</Route>
        <Route path="/sales/invoices/:id">{(p) => <SplitDetail kind="invoice" id={p.id!} />}</Route>
        <Route path="/sales/invoices" component={InvoicesPage} />
        <Route path="/sales/egg-calendar" component={EggCalendarPage} />
        <Route path="/sales/egg-agreements" component={EggAgreementsPage} />
        <Route path="/sales/egg-benchmark" component={EggBenchmarkPage} />
        <Route path="/sales/egg-loading" component={EggLoadingPage} />
        <Route path="/sales/payments/new">{() => <PaymentNewPage side="customer" />}</Route>
        <Route path="/sales/payments/:id/edit">{(p) => <PaymentNewPage side="customer" editId={p.id!} />}</Route>
        <Route path="/sales/payments/:id">{(p) => <PaymentDetailPage side="customer" id={p.id!} />}</Route>
        <Route path="/sales/payments" component={CustomerPaymentsPage} />
        <Route path="/sales/credit-notes/new">{() => <TransactionNewPage kind="credit-note" />}</Route>
        <Route path="/sales/credit-notes/:id/edit">{(p) => <TransactionNewPage kind="credit-note" editId={p.id!} />}</Route>
        <Route path="/sales/credit-notes/:id">{(p) => <SplitDetail kind="credit-note" id={p.id!} />}</Route>
        <Route path="/sales/credit-notes" component={CreditNotesPage} />
        <Route path="/purchases/vendors/new">{() => <ContactNewPage type="vendor" />}</Route>
        <Route path="/purchases/vendors/:id/edit">{(p) => <ContactNewPage type="vendor" editId={p.id!} />}</Route>
        <Route path="/purchases/vendors/:id">{(p) => <ContactDetailPage id={p.id!} />}</Route>
        <Route path="/purchases/vendors" component={VendorsPage} />
        <Route path="/purchases/expenses/new">{() => <ExpenseNewPage />}</Route>
        <Route path="/purchases/expenses/:id/edit">{(p) => <ExpenseNewPage editId={p.id!} />}</Route>
        <Route path="/purchases/expenses/:id">{(p) => <ExpenseDetailPage id={p.id!} />}</Route>
        <Route path="/purchases/expenses" component={ExpensesPage} />
        <Route path="/purchases/orders/new">{() => <TransactionNewPage kind="purchase-order" />}</Route>
        <Route path="/purchases/orders/:id/edit">{(p) => <TransactionNewPage kind="purchase-order" editId={p.id!} />}</Route>
        <Route path="/purchases/orders/:id">{(p) => <SplitDetail kind="purchase-order" id={p.id!} />}</Route>
        <Route path="/purchases/orders" component={PurchaseOrdersPage} />
        <Route path="/purchases/bills/new">{() => <TransactionNewPage kind="bill" />}</Route>
        <Route path="/purchases/bills/:id/edit">{(p) => <TransactionNewPage kind="bill" editId={p.id!} />}</Route>
        <Route path="/purchases/bills/:id">{(p) => <SplitDetail kind="bill" id={p.id!} />}</Route>
        <Route path="/purchases/bills" component={BillsPage} />
        {/* What we owe and have not paid, and the file that pays it. Its own
            path rather than a tab on Payments Made: one is a list of money
            about to leave, the other of money already gone. */}
        <Route path="/purchases/payables" component={PaymentsPage} />
        <Route path="/purchases/payments/new">{() => <PaymentNewPage side="vendor" />}</Route>
        <Route path="/purchases/payments/:id/edit">{(p) => <PaymentNewPage side="vendor" editId={p.id!} />}</Route>
        <Route path="/purchases/payments/:id">{(p) => <PaymentDetailPage side="vendor" id={p.id!} />}</Route>
        <Route path="/purchases/payments" component={VendorPaymentsPage} />
        <Route path="/purchases/vendor-credits/new">{() => <TransactionNewPage kind="vendor-credit" />}</Route>
        <Route path="/purchases/vendor-credits/:id/edit">{(p) => <TransactionNewPage kind="vendor-credit" editId={p.id!} />}</Route>
        <Route path="/purchases/vendor-credits/:id">{(p) => <SplitDetail kind="vendor-credit" id={p.id!} />}</Route>
        <Route path="/purchases/vendor-credits" component={VendorCreditsPage} />
        <Route path="/office/receipts" component={GoodsReceiptsPage} />
        <Route path="/office/gate" component={GateInPage} />
        {/* Weigh In, QC, Unloading and Weigh Out are one page with four tabs.
            The tab lives in the URL so a refresh and a shared link both land
            where they were, and the four old paths still work. */}
        <Route path="/office/unloading/:station">
          {(p) =>
            isStation(p.station!) ? (
              <StationPage key={p.station} station={p.station} />
            ) : (
              <Redirect to={stationPath("weighbridge")} />
            )
          }
        </Route>
        <Route path="/office/unloading">{() => <StationPage station="weighbridge" />}</Route>
        {/* The stations had a sidebar entry each before they became tabs. */}
        <Route path="/office/weighbridge">{() => <Redirect to={stationPath("weighbridge")} />}</Route>
        <Route path="/office/qc">{() => <Redirect to={stationPath("qc")} />}</Route>
        <Route path="/office/weigh-out">{() => <Redirect to={stationPath("weigh-out")} />}</Route>
        {/* An analysis is a fact about a material, so it lives on the
            material — beside its quality spec. */}
        <Route path="/feed-mill/nutrients">{() => <Redirect to="/items" />}</Route>
        <Route path="/feed-mill/formulas" component={FeedFormulasPage} />
        {/* The formulator is no longer a screen of its own: it IS the
            single-formula view, so its old path lands there. */}
        <Route path="/feed-mill/formulator">{() => <Redirect to="/feed-mill/formulas" />}</Route>
        <Route path="/feed-mill/production" component={FeedProductionPage} />
        <Route path="/accountant/group-companies" component={OwnerBillingPage} />
        {/* The page moved under Accountant; old links keep working. */}
        <Route path="/farms/owner-billing">{() => <Redirect to="/accountant/group-companies" />}</Route>
        <Route path="/farms/store" component={FarmStorePage} />
        <Route path="/farms/dr-eggsy" component={DrEggsyPage} />
        <Route path="/farms/egg-stock" component={EggGradingPage} />
        <Route path="/farms" component={FarmsHousesPage} />
        <Route path="/farms/batches" component={FarmsBatchesPage} />
        {/* The Houses screen moved up to /farms; keep the old path working. */}
        <Route path="/farms/daily">{() => <Redirect to="/farms" />}</Route>
        {/* The controller's own readings, drawn. Its own screen rather than a
            tab on the house: a sensor and a tally sheet are two claims. */}
        <Route path="/farms/conditions/:id" component={ShedConditionsPage} />
        <Route path="/farms/houses/:id" component={HouseDetailPage} />
        <Route path="/farms/flocks/:id" component={FlockDetailPage} />
        {/* Feed transfer is weighed on the same platform, so it lives with the
            other weighments rather than in a screen of its own. */}
        <Route path="/feed-mill/transfers">
          {() => <Redirect to={stationPath("transfer")} />}
        </Route>
        <Route path="/office/settlement" component={SettlementPage} />
        <Route path="/office/:station">
          {(p) => <OfficeStationPage key={p.station} stationKey={p.station!} />}
        </Route>
        <Route path="/accountant/journals/new" component={JournalNewPage} />
        <Route path="/accountant/journals/:id">{(p) => <JournalDetailPage id={p.id!} />}</Route>
        <Route path="/accountant/journals" component={JournalsPage} />
        {/* Keyed on the account so drilling from one ledger to another resets
            the page's own date filters instead of keeping the previous ones. */}
        <Route path="/accountant/accounts/:id">
          {(p) => <AccountLedgerPage key={p.id} id={p.id!} />}
        </Route>
        <Route path="/accountant/accounts" component={ChartOfAccountsPage} />
        <Route path="/accountant/bulk-update" component={BulkUpdatePage} />
        <Route path="/accountant/budgets/new">{() => <BudgetNewPage />}</Route>
        <Route path="/accountant/budgets/:id">{(p) => <BudgetDetailPage id={p.id!} />}</Route>
        <Route path="/accountant/budgets" component={BudgetsPage} />
        <Route path="/accountant/assets/new">{() => <FixedAssetNewPage />}</Route>
        <Route path="/accountant/assets/:id">{(p) => <FixedAssetDetailPage id={p.id!} />}</Route>
        <Route path="/accountant/assets" component={FixedAssetsPage} />
        <Route path="/accountant/transaction-locking" component={TransactionLockingPage} />
        <Route path="/inventory/adjustments/new">{() => <InventoryAdjustmentNewPage />}</Route>
        <Route path="/inventory/adjustments/:id">
          {(p) => <InventoryAdjustmentDetailPage id={p.id!} />}
        </Route>
        <Route path="/inventory/adjustments" component={InventoryAdjustmentsPage} />
        <Route path="/inventory/stock" component={StockPage} />
        <Route path="/payroll/employees" component={PayrollEmployeesPage} />
        <Route path="/payroll/time" component={PayrollTimePage} />
        <Route path="/payroll/gate" component={PayrollGatePage} />
        <Route path="/payroll/face-enrollment" component={PayrollFaceEnrollmentPage} />
        <Route path="/payroll/pay-inputs" component={PayrollPayInputsPage} />
        <Route path="/payroll/run" component={PayrollRunPage} />
        <Route path="/payroll/wages" component={PayrollWagesPage} />
        <Route path="/payroll/canteen" component={PayrollCanteenPage} />
        <Route path="/payroll/devices" component={PayrollDevicesPage} />
        {/* Payroll's masters moved to Settings, where every module keeps them. */}
        <Route path="/payroll/settings">{() => <Redirect to="/settings" />}</Route>
        <Route path="/payroll" component={PayrollOverviewPage} />
        <Route path="/reports/weekly-management-summary" component={WeeklySummaryPage} />
        <Route path="/reports/:key">{(p) => <ReportViewPage reportKey={p.key!} />}</Route>
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
