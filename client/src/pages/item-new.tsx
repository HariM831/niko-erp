import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  PRODUCE_CATEGORIES,
} from "@shared/item-categories";
import { uploadPending } from "../components/pending-attachments";
import { ImagePlus, Search, X } from "lucide-react";

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}
interface Tax {
  id: string;
  name: string;
}
interface Contact {
  id: string;
  displayName: string;
}

const COMMON_UNITS = ["pcs", "box", "kg", "g", "ltr", "ml", "dozen", "tray", "mtr", "no's", "bag"];

export function ItemNewPage({ editId }: { editId?: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    type: "goods",
    name: "",
    sku: "",
    category: "",
    aliases: "",
    unit: "pcs",
    hsnOrSac: "",
    taxId: "",
    isSold: true,
    sellingPrice: "",
    salesAccountId: "",
    salesDescription: "",
    isPurchased: true,
    costPrice: "",
    purchaseAccountId: "",
    purchaseDescription: "",
    preferredVendorId: "",
    trackInventory: false,
    inventoryAccountId: "",
    openingStock: "",
    reorderLevel: "",
  });
  const [error, setError] = useState<string | null>(null);
  /** Set when the server said "looks like X" — resubmitting confirms intent. */
  const [nearDuplicateOf, setNearDuplicateOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [existingImageId, setExistingImageId] = useState<string | null>(null);

  const { data: existing } = useQuery({
    queryKey: ["item", editId],
    queryFn: () => api<Record<string, unknown>>(`/api/items/${editId}`),
    enabled: !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      type: (existing.type as string) ?? "goods",
      name: (existing.name as string) ?? "",
      sku: (existing.sku as string) ?? "",
      unit: (existing.unit as string) ?? "pcs",
      category: (existing.category as string) ?? "",
      aliases: ((existing.aliases as string[]) ?? []).join("\n"),
      hsnOrSac: (existing.hsnOrSac as string) ?? "",
      taxId: (existing.taxId as string) ?? "",
      isSold: existing.isSold !== false,
      sellingPrice: existing.sellingPrice ? String(Number(existing.sellingPrice)) : "",
      salesAccountId: (existing.salesAccountId as string) ?? "",
      salesDescription: (existing.salesDescription as string) ?? "",
      isPurchased: existing.isPurchased !== false,
      costPrice: existing.costPrice ? String(Number(existing.costPrice)) : "",
      purchaseAccountId: (existing.purchaseAccountId as string) ?? "",
      purchaseDescription: (existing.purchaseDescription as string) ?? "",
      preferredVendorId: (existing.preferredVendorId as string) ?? "",
      trackInventory: Boolean(existing.trackInventory),
      inventoryAccountId: (existing.inventoryAccountId as string) ?? "",
      openingStock: existing.openingStock && Number(existing.openingStock) > 0 ? String(Number(existing.openingStock)) : "",
      reorderLevel: existing.reorderLevel ? String(Number(existing.reorderLevel)) : "",
    });
  }, [existing]);

  const { data: existingFiles } = useQuery({
    queryKey: ["attachments", "item", editId],
    queryFn: () => api<Array<{ id: string; mimeType: string }>>(`/api/attachments?entityType=item&entityId=${editId}`),
    enabled: !!editId,
  });
  useEffect(() => {
    const img = existingFiles?.find((f) => f.mimeType.startsWith("image/"));
    setExistingImageId(img?.id ?? null);
  }, [existingFiles]);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const { data: taxes } = useQuery({
    queryKey: ["taxes"],
    queryFn: () => api<Tax[]>("/api/taxes"),
  });
  const { data: vendors } = useQuery({
    queryKey: ["contacts", "vendor"],
    queryFn: () => api<Contact[]>("/api/contacts?type=vendor&isActive=true"),
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const canSave =
    form.name.trim() &&
    (!form.trackInventory || form.inventoryAccountId) &&
    (!form.isSold || form.sellingPrice.trim()) &&
    (!form.isPurchased || form.costPrice.trim());

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = (await api(editId ? `/api/items/${editId}` : "/api/items", {
        method: editId ? "PATCH" : "POST",
        body: {
          type: form.type,
          name: form.name,
          sku: form.sku || undefined,
          unit: form.unit || undefined,
          category: form.category || null,
          confirmNotDuplicate: nearDuplicateOf != null || undefined,
          aliases: form.aliases
            .split(/[\n,]/)
            .map((a) => a.trim())
            .filter(Boolean),
          hsnOrSac: form.hsnOrSac || undefined,
          taxId: form.taxId || undefined,
          isSold: form.isSold,
          sellingPrice: form.isSold && form.sellingPrice ? Number(form.sellingPrice).toFixed(2) : undefined,
          salesAccountId: form.isSold ? form.salesAccountId || undefined : undefined,
          salesDescription: form.isSold ? form.salesDescription || undefined : undefined,
          isPurchased: form.isPurchased,
          costPrice: form.isPurchased && form.costPrice ? Number(form.costPrice).toFixed(2) : undefined,
          purchaseAccountId: form.isPurchased ? form.purchaseAccountId || undefined : undefined,
          purchaseDescription: form.isPurchased ? form.purchaseDescription || undefined : undefined,
          preferredVendorId: form.isPurchased ? form.preferredVendorId || undefined : undefined,
          trackInventory: form.trackInventory,
          inventoryAccountId: form.trackInventory ? form.inventoryAccountId || undefined : undefined,
          openingStock: form.trackInventory && form.openingStock ? Number(form.openingStock).toFixed(3) : undefined,
          reorderLevel: form.trackInventory && form.reorderLevel ? Number(form.reorderLevel).toFixed(3) : undefined,
        },
      })) as { id: string };
      const itemId = editId ?? created?.id;
      if (image && itemId) {
        const failed = await uploadPending("item", itemId, [image]);
        if (failed.length) setError("Item saved, but the image failed to upload");
      }
      await qc.invalidateQueries();
      navigate(editId ? `/items/${editId}` : "/items");
    } catch (err) {
      // A near-name refusal carries requiresConfirmation; saving again then
      // resubmits with the confirmation set, and intent is on the record.
      const data = err instanceof ApiError ? err.data : undefined;
      if (data?.requiresConfirmation) {
        setNearDuplicateOf((data.similarTo as { name: string } | undefined)?.name ?? "an existing item");
      }
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  /** Only what the farm produces is sold; everything else is bought to use. */
  const sellable = (PRODUCE_CATEGORIES as readonly string[]).includes(form.category);

  const inputCls = "input";
  const label = "label";
  const previewSrc = image
    ? URL.createObjectURL(image)
    : existingImageId
      ? `/api/attachments/${existingImageId}/download`
      : null;

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">{editId ? "Edit Item" : "New Item"}</h1>
        <button onClick={() => navigate(editId ? `/items/${editId}` : "/items")} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-3xl grid-cols-3 gap-6">
          {/* Left: core fields — right: image, mirroring Zoho's New Item layout */}
          <div className="col-span-2 space-y-4">
            <div>
              <label className="label-required">Name *</label>
              <input value={form.name} onChange={set("name")} className={inputCls} autoFocus />
            </div>

            <div>
              <div className={label}>Type</div>
              <div className="flex items-center gap-5 py-1">
                {(["goods", "service"] as const).map((t) => (
                  <label key={t} className="flex cursor-pointer items-center gap-1.5 text-[13px]">
                    <input
                      type="radio"
                      name="itemType"
                      checked={form.type === t}
                      onChange={() => setForm((f) => ({ ...f, type: t }))}
                      className="accent-brand-500"
                    />
                    <span className="capitalize">{t}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={label}>SKU</label>
                <input value={form.sku} onChange={set("sku")} className={inputCls} />
              </div>
              <div>
                {/* Fixed options, not a custom field: the formulator and the
                    Farm Store gate on these values. */}
                <label className={label}>Category</label>
                <select value={form.category} onChange={set("category")} className={inputCls}>
                  <option value="">—</option>
                  {ITEM_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{ITEM_CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Unit</label>
                <select value={form.unit} onChange={set("unit")} className={inputCls}>
                  {COMMON_UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                  {!COMMON_UNITS.includes(form.unit) && form.unit && (
                    <option value={form.unit}>{form.unit}</option>
                  )}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className={label}>Also known as</label>
                <textarea
                  value={form.aliases}
                  onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))}
                  rows={2}
                  placeholder={"One per line — the names vendors' bills use, e.g.\nGN De-Oiled-Cake 50%"}
                  className={`${inputCls} h-auto py-1.5 text-[12px]`}
                />
                <p className="mt-0.5 text-[11px] text-gray-400">
                  Bill matching at the office gate resolves these names to this item.
                </p>
              </div>
              <div>
                <label className={label}>HSN / SAC Code</label>
                <div className="relative">
                  <input value={form.hsnOrSac} onChange={set("hsnOrSac")} className={`${inputCls} pr-8`} />
                  <Search size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                </div>
              </div>
              <div>
                <label className={label}>Tax Rate</label>
                <select value={form.taxId} onChange={set("taxId")} className={inputCls}>
                  <option value="">Not Taxable</option>
                  {taxes?.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div>
            <label className={label}>Item Image</label>
            {previewSrc ? (
              <div className="relative inline-block">
                <img
                  src={previewSrc}
                  alt="Item preview"
                  className="h-32 w-32 rounded-xl border border-gray-200 object-cover shadow-sm"
                />
                <button
                  type="button"
                  onClick={() => {
                    setImage(null);
                    setExistingImageId(null);
                  }}
                  className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-white text-gray-500 shadow-md hover:text-red-500"
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <label className="grid h-32 w-32 cursor-pointer place-items-center rounded-xl border border-dashed border-gray-300 bg-gray-50/60 text-gray-400 transition-colors hover:border-brand-400 hover:bg-brand-50/40 hover:text-brand-500">
                <span className="grid place-items-center gap-1 text-center px-2">
                  <ImagePlus size={20} />
                  <span className="text-[11px] font-medium leading-tight">Drag image or Browse</span>
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => setImage(e.target.files?.[0] ?? null)}
                />
              </label>
            )}
          </div>
        </div>

        {/* Sales Information — only Produce is sold; the server clamps too. */}
        <div className="mt-6 max-w-3xl border-t pt-5">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              disabled={!sellable}
              checked={sellable && form.isSold}
              onChange={(e) => setForm((f) => ({ ...f, isSold: e.target.checked }))}
              className="h-4 w-4 accent-brand-500"
            />
            <span className="text-[13px] font-bold">Sales Information</span>
          </label>
          {!sellable && (
            <p className="mb-2 text-[11px] text-gray-400">
              Only the farm's own output is sold — eggs, birds, manure. Set the category to one of
              those to price a sale.
            </p>
          )}
          {sellable && form.isSold && (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <label className="label-required">Selling Price *</label>
                <div className="flex overflow-hidden rounded-lg border border-gray-200 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100">
                  <span className="flex items-center bg-gray-50 px-2.5 text-[13px] text-gray-500">INR</span>
                  <input
                    value={form.sellingPrice}
                    onChange={set("sellingPrice")}
                    placeholder="0.00"
                    className="w-full border-0 px-2.5 py-1.5 text-[13px] focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="label-required">Account *</label>
                <select value={form.salesAccountId} onChange={set("salesAccountId")} className={inputCls}>
                  <option value="">Sales (default)</option>
                  {accounts
                    ?.filter((a) => a.type === "income")
                    .map((a) => (
                      <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                    ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className={label}>Description</label>
                <textarea value={form.salesDescription} onChange={set("salesDescription")} rows={2} className={inputCls} />
              </div>
            </div>
          )}
        </div>

        {/* Purchase Information */}
        <div className="mt-5 max-w-3xl border-t pt-5">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={form.isPurchased}
              onChange={(e) => setForm((f) => ({ ...f, isPurchased: e.target.checked }))}
              className="h-4 w-4 accent-brand-500"
            />
            <span className="text-[13px] font-bold">Purchase Information</span>
          </label>
          {form.isPurchased && (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <label className="label-required">Cost Price *</label>
                <div className="flex overflow-hidden rounded-lg border border-gray-200 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100">
                  <span className="flex items-center bg-gray-50 px-2.5 text-[13px] text-gray-500">INR</span>
                  <input
                    value={form.costPrice}
                    onChange={set("costPrice")}
                    placeholder="0.00"
                    className="w-full border-0 px-2.5 py-1.5 text-[13px] focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="label-required">Account *</label>
                <select value={form.purchaseAccountId} onChange={set("purchaseAccountId")} className={inputCls}>
                  <option value="">Cost of Goods Sold (default)</option>
                  {accounts
                    ?.filter((a) => a.type === "expense" || a.type === "asset")
                    .map((a) => (
                      <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                    ))}
                </select>
              </div>
              <div>
                <label className={label}>Description</label>
                <textarea value={form.purchaseDescription} onChange={set("purchaseDescription")} rows={2} className={inputCls} />
              </div>
              <div>
                <label className={label}>Preferred Vendor</label>
                <select value={form.preferredVendorId} onChange={set("preferredVendorId")} className={inputCls}>
                  <option value="">None</option>
                  {vendors?.map((v) => (
                    <option key={v.id} value={v.id}>{v.displayName}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Inventory */}
        <div className="mt-5 max-w-3xl border-t pt-5">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={form.trackInventory}
              onChange={(e) => setForm((f) => ({ ...f, trackInventory: e.target.checked }))}
              className="h-4 w-4 accent-brand-500"
            />
            <span className="text-[13px] font-bold">Track Inventory for this item</span>
          </label>
          <p className="ml-6 mt-0.5 text-xs text-gray-500">
            Stock levels are maintained and an inventory asset account is required.
          </p>
          {form.trackInventory && (
            <div className="ml-6 mt-3 grid grid-cols-3 gap-4">
              <div>
                <label className="label-required">Inventory Account *</label>
                <select value={form.inventoryAccountId} onChange={set("inventoryAccountId")} className={inputCls}>
                  <option value="">Select an account</option>
                  {accounts
                    ?.filter((a) => a.type === "asset")
                    .map((a) => (
                      <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">Opening Stock</label>
                <input value={form.openingStock} onChange={set("openingStock")} placeholder="0" className={inputCls} />
              </div>
              <div>
                <label className="label">Reorder Level</label>
                <input value={form.reorderLevel} onChange={set("reorderLevel")} placeholder="0" className={inputCls} />
              </div>
            </div>
          )}
        </div>

        {error && <p className="mt-4 max-w-3xl text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !canSave}
          className="btn-primary"
        >
          {nearDuplicateOf ? "Create anyway — it is a different material" : "Save"}
        </button>
        {nearDuplicateOf && (
          <span className="text-[12px] text-amber-700">
            Looks like “{nearDuplicateOf}”. If it is the same material, use that item instead.
          </span>
        )}
        <button onClick={() => navigate(editId ? `/items/${editId}` : "/items")} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
