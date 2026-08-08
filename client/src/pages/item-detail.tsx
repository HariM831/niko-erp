import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { api, formatMoney } from "../api";
import { AttachmentsButton } from "../components/attachments";
import { CommentsButton } from "../components/comments";

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
  isPurchased: boolean;
  costPrice?: string;
  purchaseAccountId?: string;
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

export function ItemDetailPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
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

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!item) return <div className="p-8 text-sm text-red-600">Item not found.</div>;

  const images = files?.filter((f) => f.mimeType.startsWith("image/")) ?? [];
  const acctName = (aid?: string) => {
    if (!aid) return "—";
    const a = accounts?.find((x) => x.id === aid);
    return a ? `${a.code} · ${a.name}` : "—";
  };
  const taxName = item.taxId ? (taxes?.find((t) => t.id === item.taxId)?.name ?? "—") : "None";

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-2.5">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/items")} className="text-gray-400 hover:text-gray-700">←</button>
          <h1 className="text-base font-semibold">{item.name}</h1>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
            {item.type}
          </span>
          {item.trackInventory && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-green-600">Tracked</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <CommentsButton entityType="item" entityId={id} />
          <AttachmentsButton entityType="item" entityId={id} />
        </div>
      </header>

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
              <Field label="Unit" value={item.unit} />
              <Field label="HSN / SAC" value={item.hsnOrSac ?? "—"} />
              <Field label="Default Tax" value={taxName} />
            </div>

            <div className="mb-5 grid grid-cols-2 gap-6 border-t pt-5">
              <div>
                <h3 className="mb-2 text-[13px] font-bold">Sales Information</h3>
                <div className="space-y-3">
                  <Field label="Selling Price" value={item.sellingPrice ? formatMoney(item.sellingPrice) : "—"} />
                  <Field label="Sales Account" value={acctName(item.salesAccountId) === "—" ? "Sales Revenue (default)" : acctName(item.salesAccountId)} />
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-[13px] font-bold">Purchase Information</h3>
                <div className="space-y-3">
                  <Field label="Cost Price" value={item.costPrice ? formatMoney(item.costPrice) : "—"} />
                  <Field label="Purchase Account" value={acctName(item.purchaseAccountId)} />
                </div>
              </div>
            </div>

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
    </div>
  );
}
