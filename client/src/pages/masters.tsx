import { ListPage, StatusBadge } from "../components/list-page";
import { AttachmentsButton } from "../components/attachments";
import { formatDate, formatMoney } from "../api";

interface ContactRow {
  id: string;
  displayName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  gstin?: string;
  gstTreatment?: string;
  isActive: boolean;
}

const contactColumns = [
  {
    key: "name",
    header: "Name",
    render: (r: ContactRow) => (
      <span className="font-medium text-brand-600">{r.displayName}</span>
    ),
  },
  { key: "company", header: "Company Name", render: (r: ContactRow) => r.companyName ?? "—" },
  { key: "email", header: "Email", render: (r: ContactRow) => r.email ?? "—" },
  { key: "phone", header: "Work Phone", render: (r: ContactRow) => r.phone ?? "—" },
  {
    key: "gstt",
    header: "GST Treatment",
    render: (r: ContactRow) => (
      <span className="capitalize">{(r.gstTreatment ?? "").replace(/_/g, " ") || "—"}</span>
    ),
  },
  { key: "gstin", header: "GSTIN", render: (r: ContactRow) => r.gstin ?? "—" },
];

export const CustomersPage = () => (
  <ListPage<ContactRow>
    title="Customers"
    endpoint="/api/contacts?type=customer"
    rowKey={(r) => r.id}
    searchPlaceholder="Search customers…"
    newLabel="New Customer"
    newPath="/sales/customers/new"
    rowPath={(r) => `/sales/customers/${r.id}`}
    columns={contactColumns}
  />
);

export const VendorsPage = () => (
  <ListPage<ContactRow>
    title="Vendors"
    endpoint="/api/contacts?type=vendor"
    rowKey={(r) => r.id}
    searchPlaceholder="Search vendors…"
    newLabel="New Vendor"
    newPath="/purchases/vendors/new"
    rowPath={(r) => `/purchases/vendors/${r.id}`}
    columns={contactColumns}
  />
);

interface ItemRow {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  type: string;
  sellingPrice?: string;
  costPrice?: string;
  isActive: boolean;
}

export const ItemsPage = () => (
  <ListPage<ItemRow>
    title="Items"
    endpoint="/api/items"
    rowKey={(r) => r.id}
    searchPlaceholder="Search items…"
    newLabel="New Item"
    newPath="/items/new"
    columns={[
      {
        key: "name",
        header: "Name",
        render: (r) => (
          <div>
            <div className="font-medium text-brand-600">{r.name}</div>
            {r.sku && <div className="text-xs text-gray-500">SKU: {r.sku}</div>}
          </div>
        ),
      },
      { key: "type", header: "Type", render: (r) => r.type },
      { key: "unit", header: "Unit", render: (r) => r.unit },
      { key: "sell", header: "Selling Price", align: "right", render: (r) => (r.sellingPrice ? formatMoney(r.sellingPrice) : "—") },
      { key: "cost", header: "Cost Price", align: "right", render: (r) => (r.costPrice ? formatMoney(r.costPrice) : "—") },
    ]}
  />
);

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
}

export const AccountsPage = () => (
  <ListPage<AccountRow>
    title="Chart of Accounts"
    endpoint="/api/accounting/accounts"
    rowKey={(r) => r.id}
    newLabel="New Account"
    columns={[
      { key: "code", header: "Code", render: (r) => <span className="tabular-nums">{r.code}</span> },
      { key: "name", header: "Account Name", render: (r) => <span className="font-medium">{r.name}</span> },
      { key: "type", header: "Type", render: (r) => <span className="capitalize">{r.type}</span> },
      {
        key: "active",
        header: "Status",
        render: (r) => <StatusBadge status={r.isActive ? "open" : "void"} />,
      },
    ]}
  />
);

interface JournalRow {
  id: string;
  entryNumber: string;
  entryDate: string;
  narration: string;
  sourceType: string;
  status: string;
}

export const JournalsPage = () => (
  <ListPage<JournalRow>
    title="Manual Journals"
    endpoint="/api/accounting/journals"
    rowKey={(r) => r.id}
    newLabel="New Journal"
    newPath="/accountant/journals/new"
    columns={[
      { key: "date", header: "Date", render: (r) => formatDate(r.entryDate) },
      { key: "number", header: "Number", render: (r) => <span className="font-medium text-brand-600">{r.entryNumber}</span> },
      { key: "narration", header: "Narration", render: (r) => r.narration },
      { key: "source", header: "Source", render: (r) => <span className="capitalize">{r.sourceType.replace(/_/g, " ")}</span> },
      { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
      {
        key: "files",
        header: "",
        align: "right",
        render: (r) => (
          <div onClick={(e) => e.stopPropagation()} className="inline-block">
            <AttachmentsButton entityType="journal_entry" entityId={r.id} />
          </div>
        ),
      },
    ]}
  />
);

interface BankAccountRow {
  id: string;
  name: string;
  kind: string;
  bankName?: string;
  accountNumber?: string;
  balance: string;
}

export const BankingPage = () => (
  <ListPage<BankAccountRow>
    title="Banking"
    endpoint="/api/banking/accounts"
    rowKey={(r) => r.id}
    newLabel="Add Bank Account"
    newPath="/banking/new"
    rowPath={(r) => `/banking/${r.id}`}
    columns={[
      {
        key: "name",
        header: "Account",
        render: (r) => (
          <div>
            <div className="font-medium text-brand-600">{r.name}</div>
            <div className="text-xs text-gray-500">
              {r.bankName ?? r.kind} {r.accountNumber ? `•••${r.accountNumber.slice(-4)}` : ""}
            </div>
          </div>
        ),
      },
      { key: "kind", header: "Type", render: (r) => <span className="capitalize">{r.kind}</span> },
      { key: "balance", header: "Balance", align: "right", render: (r) => formatMoney(r.balance) },
    ]}
  />
);
