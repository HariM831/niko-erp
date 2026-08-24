import { useEffect, useRef, useState } from "react";
import { ItemNutrientProfile } from "../components/item-nutrient-profile";
import { ItemQualitySpec } from "../components/item-quality-spec";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Package } from "lucide-react";
import { api, formatMoney } from "../api";
import { AttachmentsButton } from "../components/attachments";
import { CommentsButton } from "../components/comments";
import { StatusBadge } from "../components/list-page";
import { shortDate } from "./documents";
import { ITEM_CATEGORY_LABELS, type ItemCategory } from "@shared/item-categories";

interface Item {
  id: string;
  type: string;
  category: ItemCategory | null;
  aliases: string[];
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
  purchaseOrders: TxnRow[];
}

const TXN_SECTIONS: Array<{ key: keyof Transactions; label: string; basePath: string }> = [
  { key: "invoices", label: "Invoices", basePath: "/sales/invoices" },
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
  const [tab, setTab] = useState<"overview" | "transactions" | "quality" | "nutrition">("overview");
  const [moreOpen, setMoreOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeError, setMergeError] = useState<string | null>(null);
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
  const { data: mergeCandidates } = useQuery({
    queryKey: ["merge-candidates", id],
    queryFn: () => api<Array<{ id: string; name: string }>>("/api/items?isActive=true&limit=500"),
    enabled: merging,
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

  const merge = async () => {
    setMergeError(null);
    try {
      const summary = await api<{ formulaLinesMoved: number; nutrientsCopied: number; aliasesCarried: number }>(
        `/api/items/${id}/merge`,
        { method: "POST", body: { targetId: mergeTarget } },
      );
      // The survivor is now the item of record; land the user on it.
      alert(
        `Merged. ${summary.aliasesCarried} name(s) carried as aliases, ` +
          `${summary.formulaLinesMoved} formula line(s) repointed, ` +
          `${summary.nutrientsCopied} nutrient(s) copied.`,
      );
      navigate(`/items/${mergeTarget}`);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : "Merge refused");
    }
  };

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
            {item.category && (
              <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700">
                {ITEM_CATEGORY_LABELS[item.category]}
              </span>
            )}
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
                  <button
                    onClick={() => {
                      setMerging(true);
                      setMoreOpen(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-gray-50"
                  >
                    Merge into another item…
                  </button>
                </div>
              )}
            </div>
            <CommentsButton entityType="item" entityId={id} />
            <AttachmentsButton entityType="item" entityId={id} />
          </div>
        </div>
        <nav className="flex gap-5 text-[13px]">
          {/* Quality only where it means something: a spec judges a material
              arriving on a lorry, and cement does not arrive that way. */}
          {(["overview", "transactions", ...(item.category === "feed" ? (["quality", "nutrition"] as const) : [])] as const).map((t) => (
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

      {merging && (
        <div className="border-b bg-amber-50 px-6 py-3">
          <div className="mb-1 text-[13px] font-medium text-amber-900">
            Merge “{item.name}” into another item
          </div>
          <p className="mb-2 max-w-2xl text-[12px] text-amber-800">
            Recipes are repointed, missing analysis copied, and every name this item answers to —
            including “{item.name}” itself — becomes an alias of the survivor, so future bills land
            there. Posted bills and receipts stay exactly where they are. This item is then retired.
          </p>
          {mergeError && <p className="mb-2 text-[12px] font-medium text-red-700">{mergeError}</p>}
          <div className="flex items-center gap-2">
            <select
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
              className="input h-8 w-80 text-[13px]"
            >
              <option value="">Choose the surviving item…</option>
              {mergeCandidates
                ?.filter((c) => c.id !== id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <button onClick={() => void merge()} disabled={!mergeTarget} className="btn-primary h-8">
              Merge
            </button>
            <button onClick={() => setMerging(false)} className="btn-secondary h-8">
              Cancel
            </button>
          </div>
        </div>
      )}

      {tab === "nutrition" ? (
        <div className="flex-1 overflow-y-auto bg-surface p-6">
          <div className="mx-auto max-w-3xl">
            <ItemNutrientProfile itemId={id} />
          </div>
        </div>
      ) : tab === "quality" ? (
        <div className="flex-1 overflow-y-auto bg-surface p-6">
          <div className="mx-auto max-w-3xl">
            <ItemQualitySpec itemId={id} />
          </div>
        </div>
      ) : tab === "overview" ? (
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
              {item.aliases?.length > 0 && (
                <div className="mb-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    Also known as
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {item.aliases.map((a) => (
                      <span key={a} className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] text-gray-600">
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}
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
                        <th className="border-b border-[#ece3d5] px-3 py-2">Date</th>
                        <th className="border-b border-[#ece3d5] px-3 py-2">Number</th>
                        <th className="border-b border-[#ece3d5] px-3 py-2">Name</th>
                        <th className="border-b border-[#ece3d5] px-3 py-2">Status</th>
                        <th className="border-b border-[#ece3d5] px-3 py-2 text-right">Quantity</th>
                        <th className="border-b border-[#ece3d5] px-3 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr
                          key={r.id + r.number}
                          onClick={() => navigate(`${s.basePath}/${r.id}`)}
                          className="row-hover cursor-pointer border-b border-[#ece3d5]"
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
