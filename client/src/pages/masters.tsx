import { useQuery } from "@tanstack/react-query";
import { ListPage, StatusBadge, type ListView } from "../components/list-page";
import { AttachmentsButton } from "../components/attachments";
import { SummaryBanner } from "../components/summary-banner";
import { Package } from "lucide-react";
import { api, formatDate, formatMoney } from "../api";
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
  gstin?: string;
  gstTreatment?: string;
  outstanding: string;
  isActive: boolean;
}

const contactColumns = (balanceHeader: string) => [
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
  {
    key: "outstanding",
    header: balanceHeader,
    align: "right" as const,
    render: (r: ContactRow) => <span className="tabular-nums">{formatMoney(r.outstanding)}</span>,
  },
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
    rowKey={(r) => r.id}
    newLabel="New Journal"
    newPath="/accountant/journals/new"
    rowPath={(r) => `/accountant/journals/${r.id}`}
    banner={<JournalSummaryBanner />}
    columns={[
      { key: "date", header: "Date", render: (r) => formatDate(r.entryDate) },
      { key: "number", header: "Journal#", render: (r) => <span className="font-medium text-brand-600">{r.entryNumber}</span> },
      { key: "reference", header: "Reference Number", render: (r) => <span className="text-gray-600">{r.reference || r.narration}</span> },
      { key: "status", header: "Status", render: (r) => <StatusBadge status={JOURNAL_STATUS[r.status] ?? r.status} /> },
      { key: "notes", header: "Notes", render: (r) => <span className="text-gray-600">{r.reference ? r.narration : ""}</span> },
      { key: "amount", header: "Amount", align: "right", render: (r) => formatMoney(r.amount) },
      { key: "createdBy", header: "Created By", render: (r) => <span className="text-gray-600">{r.createdByName ?? "—"}</span> },
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
