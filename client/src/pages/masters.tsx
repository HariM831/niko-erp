import { useQuery } from "@tanstack/react-query";
import { ListPage, StatusBadge, type ListView } from "../components/list-page";
import type { SearchField } from "../components/advanced-search";
import { AttachmentsButton } from "../components/attachments";
import { SummaryBanner } from "../components/summary-banner";
import { Package } from "lucide-react";
import { api, formatDate, formatMoney } from "../api";
import { JOURNAL_SEARCH } from "./documents";
import { ITEM_CATEGORIES, ITEM_CATEGORY_LABELS, type ItemCategory } from "@shared/item-categories";

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
  mobile?: string;
  contactPersonName?: string | null;
  contactPersonPhone?: string | null;
  gstin?: string;
  gstTreatment?: string;
  outstanding: string;
  isActive: boolean;
}

const contactColumns = (balanceHeader: string) => [
  {
    key: "name",
    header: "Name",
    portrait: true,
    sort: (r: ContactRow) => r.displayName,
    render: (r: ContactRow) => (
      <span className="font-medium text-brand-600">{r.displayName}</span>
    ),
  },
  {
    key: "contact",
    header: "Contact Person",
    portrait: true,
    sort: (r: ContactRow) => r.contactPersonName,
    render: (r: ContactRow) => <span className="text-gray-800">{r.contactPersonName || "—"}</span>,
  },
  {
    key: "phone",
    header: "Phone",
    portrait: true,
    clamp: 9,
    // Sorted on whichever of the three the row actually shows.
    sort: (r: ContactRow) => r.mobile || r.contactPersonPhone || r.phone,
    /*
     * Three sources, because no single one is populated enough to be a column.
     * Of 441 vendors: 124 carry a mobile, 41 have a contact person with a number
     * of their own, and 26 have a work phone. Mobile first — it is both the
     * best-covered and the one that gets answered.
     */
    render: (r: ContactRow) => (
      <span className="tabular-nums">{r.mobile || r.contactPersonPhone || r.phone || "—"}</span>
    ),
  },
  {
    key: "company",
    header: "Company Name",
    sort: (r: ContactRow) => r.companyName,
    render: (r: ContactRow) => r.companyName ?? "—",
  },
  {
    key: "email",
    header: "Email",
    clamp: 12,
    sort: (r: ContactRow) => r.email,
    render: (r: ContactRow) => r.email ?? "—",
  },
  {
    key: "gstt",
    header: "GST Treatment",
    sort: (r: ContactRow) => r.gstTreatment,
    render: (r: ContactRow) => (
      <span className="capitalize">{(r.gstTreatment ?? "").replace(/_/g, " ") || "—"}</span>
    ),
  },
  {
    key: "outstanding",
    header: balanceHeader,
    align: "right" as const,
    // A number, so 9,00,000 sorts above 85,000 rather than below it.
    sort: (r: ContactRow) => Number(r.outstanding) || 0,
    render: (r: ContactRow) => <span className="tabular-nums">{formatMoney(r.outstanding)}</span>,
  },
];

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

/**
 * Zoho's contact search, as far as niko keeps the data. Customer Type and
 * MSME Registered? are left out: niko records neither, so a box for them would
 * filter nothing. First and Last Name are the contact persons', as in Zoho.
 * Customers and Vendors ask the same questions, so they share the one set.
 */
const CONTACT_SEARCH: SearchField[] = [
  { key: "displayName", label: "Display Name", kind: "text" },
  { key: "companyName", label: "Company Name", kind: "text" },
  { key: "firstName", label: "First Name", kind: "text" },
  { key: "lastName", label: "Last Name", kind: "text" },
  { key: "email", label: "Email", kind: "text" },
  { key: "status", label: "Status", kind: "select", options: STATUS_OPTIONS },
  { key: "phone", label: "Phone", kind: "text" },
  { key: "address", label: "Address", kind: "text" },
  { key: "pan", label: "PAN", kind: "text" },
  { key: "notes", label: "Notes", kind: "text" },
];

/** The Customers / Vendors lists' own hero — total outstanding leads, matching the "Receivables/Payables (BCY)" column each row already shows. */
function ContactSummaryBanner({ type }: { type: "customer" | "vendor" }) {
  const { data } = useQuery({
    queryKey: ["/api/contacts/summary", type],
    queryFn: () =>
      api<{ totalOutstanding: string; active: number; newThisMonth: number }>(`/api/contacts/summary?type=${type}`),
  });
  return (
    <SummaryBanner
      primary={{
        label:
          type === "customer"
            ? "Total receivables outstanding (market only)"
            : "Total payables outstanding (market only)",
        value: formatMoney(data?.totalOutstanding ?? 0),
      }}
      secondary={[
        { label: `Active ${type}s`, value: String(data?.active ?? 0) },
        { label: "New this month", value: String(data?.newThisMonth ?? 0) },
      ]}
    />
  );
}

export const CustomersPage = () => (
  <ListPage<ContactRow>
    title="Customers"
    endpoint="/api/contacts?type=customer"
    rowKey={(r) => r.id}
    newLabel="New Customer"
    newPath="/sales/customers/new"
    rowPath={(r) => `/sales/customers/${r.id}`}
    columns={contactColumns("Receivables (BCY)")}
    views={activeViews}
    searchFields={CONTACT_SEARCH}
    banner={<ContactSummaryBanner type="customer" />}
  />
);

export const VendorsPage = () => (
  <ListPage<ContactRow>
    title="Vendors"
    endpoint="/api/contacts?type=vendor"
    rowKey={(r) => r.id}
    newLabel="New Vendor"
    newPath="/purchases/vendors/new"
    rowPath={(r) => `/purchases/vendors/${r.id}`}
    columns={contactColumns("Payables (BCY)")}
    views={activeViews}
    searchFields={CONTACT_SEARCH}
    banner={<ContactSummaryBanner type="vendor" />}
  />
);

interface ItemRow {
  id: string;
  category: ItemCategory | null;
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
  /** Opening plus every movement; null when the item does not track stock. */
  stockOnHand?: string | null;
  imageId?: string | null;
  isActive: boolean;
}

/** Matches Zoho Books' Items list column set exactly. */
/** All/Active/Inactive, then one view per category — the grouping the field is for. */
const itemViews: ListView[] = [
  ...activeViews,
  ...ITEM_CATEGORIES.map((c) => ({ label: ITEM_CATEGORY_LABELS[c], params: { category: c } })),
  { label: "Uncategorised", params: { category: "none" } },
];

/**
 * Zoho's item search, plus the two things niko's items carry that Zoho's
 * dialog lacks: SKU and category. Category is keyed apart from the views'
 * `category` so the two narrow together instead of one overwriting the other.
 */
const ITEM_SEARCH: SearchField[] = [
  { key: "name", label: "Item Name", kind: "text" },
  { key: "sku", label: "SKU", kind: "text" },
  { key: "description", label: "Description", kind: "text" },
  {
    key: "itemCategory",
    label: "Category",
    kind: "select",
    options: [
      ...ITEM_CATEGORIES.map((c) => ({ value: c, label: ITEM_CATEGORY_LABELS[c] })),
      { value: "none", label: "Uncategorised" },
    ],
  },
  { key: "rate", label: "Rate", kind: "numberRange" },
  { key: "purchaseRate", label: "Purchase Rate", kind: "numberRange" },
  { key: "status", label: "Status", kind: "select", options: STATUS_OPTIONS },
  { key: "salesAccountId", label: "Sales Account", kind: "account", accountTypes: ["income"] },
  { key: "purchaseAccountId", label: "Purchase Account", kind: "account" },
];

/** The Items list's own hero — stock value leads, below-reorder is the one alert. */
function ItemSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["/api/items/summary"],
    queryFn: () =>
      api<{ totalItems: number; active: number; stockValue: string; belowReorder: number }>("/api/items/summary"),
  });
  const below = data?.belowReorder ?? 0;
  return (
    <SummaryBanner
      primary={{ label: "Stock on hand value", value: formatMoney(data?.stockValue ?? 0) }}
      secondary={[
        { label: "Total items", value: String(data?.totalItems ?? 0) },
        { label: "Active", value: String(data?.active ?? 0) },
        { label: "Below reorder level", value: String(below), alert: below > 0 },
      ]}
    />
  );
}

export const ItemsPage = () => (
  <ListPage<ItemRow>
    title="Items"
    endpoint="/api/items"
    rowKey={(r) => r.id}
    views={itemViews}
    searchFields={ITEM_SEARCH}
    groupBy={(r) => (r.category ? ITEM_CATEGORY_LABELS[r.category] : "Uncategorised")}
    groupOrder={[...ITEM_CATEGORIES.map((c) => ITEM_CATEGORY_LABELS[c]), "Uncategorised"]}
    newLabel="New Item"
    newPath="/items/new"
    rowPath={(r) => `/items/${r.id}`}
    banner={<ItemSummaryBanner />}
    columns={[
      {
        key: "name",
        header: "Name",
        portrait: true,
        sort: (r) => r.name,
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
        key: "category",
        header: "Category",
        sort: (r) => (r.category ? ITEM_CATEGORY_LABELS[r.category] : null),
        render: (r) =>
          r.category ? (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
              {ITEM_CATEGORY_LABELS[r.category]}
            </span>
          ) : (
            <span className="text-gray-300">—</span>
          ),
      },
      {
        key: "purchaseDescription",
        header: "Purchase Description",
        sort: (r) => r.purchaseDescription,
        render: (r) => <span className="text-gray-600">{r.purchaseDescription ?? "—"}</span>,
      },
      {
        key: "purchaseRate",
        header: "Purchase Rate",
        align: "right",
        sort: (r) => Number(r.costPrice ?? 0),
        render: (r) => (r.costPrice ? formatMoney(r.costPrice) : formatMoney(0)),
      },
      {
        key: "description",
        header: "Description",
        sort: (r) => r.salesDescription,
        render: (r) => <span className="text-gray-600">{r.salesDescription ?? "—"}</span>,
      },
      {
        key: "rate",
        header: "Rate",
        align: "right",
        sort: (r) => Number(r.sellingPrice ?? 0),
        render: (r) => (r.sellingPrice ? formatMoney(r.sellingPrice) : formatMoney(0)),
      },
      {
        key: "stock",
        portrait: true,
        header: "Stock on Hand",
        align: "right",
        // An item nobody counts has no stock to compare, so it sinks rather
        // than pretending to hold zero.
        sort: (r) => (r.trackInventory ? Number(r.stockOnHand ?? r.openingStock ?? 0) : null),
        render: (r) =>
          r.trackInventory
            ? `${Number(r.stockOnHand ?? r.openingStock ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${r.unit}`
            : "—",
      },
      { key: "hsn", header: "HSN/SAC", sort: (r) => r.hsnOrSac, render: (r) => r.hsnOrSac ?? "—" },
      { key: "unit", header: "Usage Unit", sort: (r) => r.unit, render: (r) => r.unit },
    ]}
  />
);

interface JournalRow {
  id: string;
  entryNumber: string;
  entryDate: string;
  narration: string;
  reference: string | null;
  sourceType: string;
  status: string;
  amount: string;
  createdByName: string | null;
}

/** Zoho calls a posted journal "published". */
const JOURNAL_STATUS: Record<string, string> = {
  posted: "published",
  draft: "draft",
  reversed: "reversed",
};

/** The Manual Journals list's own hero — this month's activity leads. */
function JournalSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["/api/accounting/journals/summary"],
    queryFn: () =>
      api<{ thisMonth: string; entriesThisMonth: number; draftCount: number; thisYear: string }>(
        "/api/accounting/journals/summary",
      ),
  });
  return (
    <SummaryBanner
      primary={{ label: "Journalled this month", value: formatMoney(data?.thisMonth ?? 0) }}
      secondary={[
        { label: "Entries this month", value: String(data?.entriesThisMonth ?? 0) },
        { label: "Draft", value: String(data?.draftCount ?? 0) },
        { label: "This year", value: formatMoney(data?.thisYear ?? 0) },
      ]}
    />
  );
}

export const JournalsPage = () => (
  <ListPage<JournalRow>
    title="Manual Journals"
    endpoint="/api/accounting/journals"
    searchFields={JOURNAL_SEARCH}
    rowKey={(r) => r.id}
    newLabel="New Journal"
    newPath="/accountant/journals/new"
    rowPath={(r) => `/accountant/journals/${r.id}`}
    banner={<JournalSummaryBanner />}
    columns={[
      { key: "date", header: "Date", portrait: true, sort: (r) => r.entryDate, render: (r) => formatDate(r.entryDate) },
      { key: "number", header: "Journal#", portrait: true, sort: (r) => r.entryNumber, render: (r) => <span className="font-medium text-brand-600">{r.entryNumber}</span> },
      { key: "reference", header: "Narration", portrait: true, sort: (r) => r.narration || r.reference, render: (r) => <span className="text-gray-600">{r.narration || r.reference}</span> },
      { key: "status", header: "Status", render: (r) => <StatusBadge status={JOURNAL_STATUS[r.status] ?? r.status} /> },
      { key: "notes", header: "Notes", sort: (r) => (r.reference ? r.narration : null), render: (r) => <span className="text-gray-600">{r.reference ? r.narration : ""}</span> },
      { key: "amount", header: "Amount", align: "right", portrait: true, sort: (r) => Number(r.amount) || 0, render: (r) => formatMoney(r.amount) },
      { key: "createdBy", header: "Created By", sort: (r) => r.createdByName, render: (r) => <span className="text-gray-600">{r.createdByName ?? "—"}</span> },
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
        sort: (r) => r.name,
        render: (r) => (
          <div>
            <div className="font-medium text-brand-600">{r.name}</div>
            <div className="text-xs text-gray-500">
              {r.bankName ?? r.kind} {r.accountNumber ? `•••${r.accountNumber.slice(-4)}` : ""}
            </div>
          </div>
        ),
      },
      { key: "kind", header: "Type", sort: (r) => r.kind, render: (r) => <span className="capitalize">{r.kind}</span> },
      { key: "balance", header: "Balance", align: "right", sort: (r) => Number(r.balance) || 0, render: (r) => formatMoney(r.balance) },
    ]}
  />
);
