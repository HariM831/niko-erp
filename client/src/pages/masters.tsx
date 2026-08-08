import { ListPage, StatusBadge, type ListView } from "../components/list-page";
import { AttachmentsButton } from "../components/attachments";
import { Package } from "lucide-react";
import { formatDate, formatMoney } from "../api";

const activeViews: ListView[] = [
  { label: "All", params: {} },
  { label: "Active", params: { isActive: "true" } },
  { label: "Inactive", params: { isActive: "false" } },
];

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
  hsnOrSac?: string;
  sellingPrice?: string;
  costPrice?: string;
  salesDescription?: string;
  purchaseDescription?: string;
  trackInventory?: boolean;
  openingStock?: string;
  imageId?: string | null;
  isActive: boolean;
}

/** Matches Zoho Books' Items list column set exactly. */
export const ItemsPage = () => (
  <ListPage<ItemRow>
    title="Items"
    endpoint="/api/items"
    rowKey={(r) => r.id}
    views={activeViews}
    searchPlaceholder="Search items…"
    newLabel="New Item"
    newPath="/items/new"
    rowPath={(r) => `/items/${r.id}`}
    columns={[
      {
        key: "name",
        header: "Name",
        render: (r) => (
          <div className="flex items-center gap-2.5">
            {r.imageId ? (
              <img
                src={`/api/attachments/${r.imageId}/download`}
                alt=""
                className="h-8 w-8 rounded-lg border border-gray-200 object-cover"
              />
            ) : (
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-gray-100 text-gray-400">
                <Package size={13} />
              </span>
            )}
            <span className="font-medium text-brand-600">{r.name}</span>
          </div>
        ),
      },
      {
        key: "purchaseDescription",
        header: "Purchase Description",
        render: (r) => <span className="text-gray-600">{r.purchaseDescription ?? "—"}</span>,
      },
      {
        key: "purchaseRate",
        header: "Purchase Rate",
        align: "right",
        render: (r) => (r.costPrice ? formatMoney(r.costPrice) : formatMoney(0)),
      },
      {
        key: "description",
        header: "Description",
        render: (r) => <span className="text-gray-600">{r.salesDescription ?? "—"}</span>,
      },
      {
        key: "rate",
        header: "Rate",
        align: "right",
        render: (r) => (r.sellingPrice ? formatMoney(r.sellingPrice) : formatMoney(0)),
      },
      {
        key: "stock",
        header: "Stock on Hand",
        align: "right",
        render: (r) => (r.trackInventory ? Number(r.openingStock ?? 0) : "—"),
      },
      { key: "hsn", header: "HSN/SAC", render: (r) => r.hsnOrSac ?? "—" },
      { key: "unit", header: "Usage Unit", render: (r) => r.unit },
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
    rowPath={(r) => `/accountant/accounts/${r.id}`}
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
    rowPath={(r) => `/accountant/journals/${r.id}`}
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
