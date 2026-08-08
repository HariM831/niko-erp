import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Package } from "lucide-react";
import { api, formatMoney } from "../api";
import { AttachmentsButton } from "../components/attachments";
import { CommentsButton } from "../components/comments";
import { StatusBadge } from "../components/list-page";
import { shortDate } from "./documents";

interface Item {
  id: string;
  type: string;
  name: string;
  sku?: string;
  unit: string;
  hsnOrSac?: string;
  isSold: boolean;
  sellingPrice?: string;
  salesAccountId?: string;
  salesDescription?: string;
  isPurchased: boolean;
  costPrice?: string;
  purchaseAccountId?: string;
  purchaseDescription?: string;
  preferredVendorId?: string;
  preferredVendorName?: string | null;
  taxId?: string;
  trackInventory: boolean;
  inventoryAccountId?: string;
  openingStock: string;
  reorderLevel?: string;
  isActive: boolean;
}

interface Attachment {
  id: string;
  fileName: string;
  mimeType: string;
}

type TxnRow = {
  id: string;
  number: string;
  date: string;
  status: string;
  contactName: string;
  quantity: string;
  amount: string;
};
interface Transactions {
  invoices: TxnRow[];
  bills: TxnRow[];
  estimates: TxnRow[];
  salesOrders: TxnRow[];
  purchaseOrders: TxnRow[];
}

const TXN_SECTIONS: Array<{ key: keyof Transactions; label: string; basePath: string }> = [
  { key: "invoices", label: "Invoices", basePath: "/sales/invoices" },
  { key: "estimates", label: "Estimates", basePath: "/sales/estimates" },
  { key: "salesOrders", label: "Sales Orders", basePath: "/sales/sales-orders" },
  { key: "bills", label: "Bills", basePath: "/purchases/bills" },
  { key: "purchaseOrders", label: "Purchase Orders", basePath: "/purchases/orders" },
];

const Field = ({ label, value, link }: { label: string; value: string; link?: string }) => (
  <div>
    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
    {link ? (
      <Link href={link} className="mt-0.5 block text-[13px] font-medium text-brand-600 hover:underline">
        {value}
      </Link>
    ) : (
      <div className="mt-0.5 text-[13px] font-medium">{value}</div>
    )}
  </div>
);

export function ItemDetailPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"overview" | "transactions">("overview");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const { data: item, isLoading } = useQuery({
    queryKey: ["item", id],
    queryFn: () => api<Item>(`/api/items/${id}`),
  });
  const { data: files } = useQuery({
    queryKey: ["attachments", "item", id],
    queryFn: () => api<Attachment[]>(`/api/attachments?entityType=item&entityId=${id}`),
  });
  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Array<{ id: string; code: string; name: string }>>("/api/accounting/accounts"),
  });
  const { data: taxes } = useQuery({
    queryKey: ["taxes"],
    queryFn: () => api<Array<{ id: string; name: string }>>("/api/taxes"),
  });
  const { data: txns } = useQuery({
    queryKey: ["item-transactions", id],
    queryFn: () => api<Transactions>(`/api/items/${id}/transactions`),
    enabled: tab === "transactions",
  });

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const toggleActive = async () => {
    if (!item) return;
    await api(`/api/items/${id}`, { method: "PATCH", body: { isActive: !item.isActive } });
    await qc.invalidateQueries({ queryKey: ["item", id] });
    setMoreOpen(false);
  };

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!item) return <div className="p-8 text-sm text-red-600">Item not found.</div>;

  const images = files?.filter((f) => f.mimeType.startsWith("image/")) ?? [];
  const acctName = (aid?: string) => {
    if (!aid) return "—";
    const a = accounts?.find((x) => x.id === aid);
    return a ? `${a.code} · ${a.name}` : "—";
  };
  const taxName = item.taxId ? (taxes?.find((t) => t.id === item.taxId)?.name ?? "—") : "Not Taxable";

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-6 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate("/items")} className="text-gray-400 hover:text-gray-700">←</button>
            <h1 className="text-lg font-semibold">{item.name}</h1>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {item.type}
            </span>
            {!item.isActive && <StatusBadge status="void" />}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => navigate(`/items/${id}/edit`)} className="btn-secondary">
              Edit
            </button>
            <div className="relative" ref={moreRef}>
              <button onClick={() => setMoreOpen((o) => !o)} className="btn-secondary flex items-center gap-1">
                More <ChevronDown size={13} />
              </button>
              {moreOpen && (
                <div className="absolute right-0 top-9 z-20 w-44 rounded-lg border bg-white py-1 shadow-lg">
                  <button
                    onClick={() => void toggleActive()}
                    className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-gray-50"
                  >
                    {item.isActive ? "Mark as Inactive" : "Mark as Active"}
                  </button>
                </div>
              )}
            </div>
            <CommentsButton entityType="item" entityId={id} />
            <AttachmentsButton entityType="item" entityId={id} />
          </div>
        </div>
        <nav className="flex gap-5 text-[13px]">
          {(["overview", "transactions"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`border-b-2 pb-2 capitalize ${
                tab === t ? "border-brand-500 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      {tab === "overview" ? (
        <div className="flex-1 overflow-y-auto bg-surface p-6">
          <div className="card mx-auto flex max-w-3xl gap-8 p-8">
            <div className="shrink-0">
              {images.length ? (
                <div className="space-y-2">
                  <img
                    src={`/api/attachments/${images[0]!.id}/download`}
                    alt={item.name}
                    className="h-40 w-40 rounded-xl border border-gray-200 object-cover shadow-sm"
                  />
                  {images.length > 1 && (
                    <div className="flex gap-1.5">
                      {images.slice(1, 5).map((im) => (
                        <img
                          key={im.id}
                          src={`/api/attachments/${im.id}/download`}
                          alt=""
                          className="h-9 w-9 rounded-lg border border-gray-200 object-cover"
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid h-40 w-40 place-items-center rounded-xl bg-gray-100 text-gray-300">
                  <Package size={40} strokeWidth={1.2} />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-4">
                <Field label="SKU" value={item.sku ?? "—"} />
                <Field label="Usage Unit" value={item.unit} />
                <Field label="HSN / SAC" value={item.hsnOrSac ?? "—"} />
                <Field label="Tax Rate" value={taxName} />
              </div>

              {item.isSold && (
                <div className="mb-5 border-t pt-5">
                  <h3 className="mb-2 text-[13px] font-bold">Sales Information</h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <Field label="Selling Price" value={item.sellingPrice ? formatMoney(item.sellingPrice) : "—"} />
                    <Field label="Account" value={acctName(item.salesAccountId) === "—" ? "Sales (default)" : acctName(item.salesAccountId)} />
                    {item.salesDescription && (
                      <div className="col-span-2">
                        <Field label="Description" value={item.salesDescription} />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {item.isPurchased && (
                <div className="mb-5 border-t pt-5">
                  <h3 className="mb-2 text-[13px] font-bold">Purchase Information</h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <Field label="Cost Price" value={item.costPrice ? formatMoney(item.costPrice) : "—"} />
                    <Field label="Account" value={acctName(item.purchaseAccountId) === "—" ? "Cost of Goods Sold (default)" : acctName(item.purchaseAccountId)} />
                    {item.purchaseDescription && <Field label="Description" value={item.purchaseDescription} />}
                    {item.preferredVendorName && (
                      <Field
                        label="Preferred Vendor"
                        value={item.preferredVendorName}
                        link={`/purchases/vendors/${item.preferredVendorId}`}
                      />
                    )}
                  </div>
                </div>
              )}

              {item.trackInventory && (
                <div className="border-t pt-5">
                  <h3 className="mb-2 text-[13px] font-bold">Inventory</h3>
                  <div className="grid grid-cols-3 gap-6">
                    <Field label="Inventory Account" value={acctName(item.inventoryAccountId)} />
                    <Field label="Opening Stock" value={`${Number(item.openingStock)} ${item.unit}`} />
                    <Field label="Reorder Level" value={item.reorderLevel ? `${Number(item.reorderLevel)} ${item.unit}` : "—"} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          {TXN_SECTIONS.map((s) => {
            const rows = txns?.[s.key] ?? [];
            return (
              <div key={s.key} className="mb-7">
                <h3 className="mb-2 text-sm font-semibold">{s.label}</h3>
                {!rows.length ? (
                  <p className="rounded-xl border border-dashed px-4 py-3 text-[13px] text-gray-400">
                    No {s.label.toLowerCase()} for this item yet.
                  </p>
                ) : (
                  <table className="w-full max-w-4xl text-[13px]">
                    <thead className="table-head">
                      <tr>
                        <th className="border-b border-[#ebeaf2] px-3 py-2">Date</th>
                        <th className="border-b border-[#ebeaf2] px-3 py-2">Number</th>
                        <th className="border-b border-[#ebeaf2] px-3 py-2">Name</th>
                        <th className="border-b border-[#ebeaf2] px-3 py-2">Status</th>
                        <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Quantity</th>
                        <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr
                          key={r.id + r.number}
                          onClick={() => navigate(`${s.basePath}/${r.id}`)}
                          className="row-hover cursor-pointer border-b border-[#ebeaf2]"
                        >
                          <td className="px-3 py-2.5">{shortDate(r.date)}</td>
                          <td className="px-3 py-2.5 font-medium text-brand-600">{r.number}</td>
                          <td className="px-3 py-2.5">{r.contactName}</td>
                          <td className="px-3 py-2.5">
                            <StatusBadge status={r.status} />
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{Number(r.quantity)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
