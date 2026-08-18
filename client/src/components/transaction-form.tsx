import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, formatMoney } from "../api";
import { PendingAttachments, uploadPending } from "./pending-attachments";
import { CustomFieldsBlock, type CustomFieldValues } from "./custom-fields";

interface Contact {
  id: string;
  displayName: string;
  paymentTermsDays: number;
}
interface Item {
  id: string;
  name: string;
  unit: string;
  sellingPrice?: string;
  costPrice?: string;
  taxId?: string;
  hsnOrSac?: string;
}
interface Tax {
  id: string;
  name: string;
  rate: string;
}
interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  isGroup: boolean;
  isActive: boolean;
}

export interface FormLine {
  itemId?: string;
  accountId?: string;
  name: string;
  quantity: string;
  unit?: string;
  rate: string;
  discountPercent: string;
  taxId?: string;
  /** Chosen option per tag. One column per tag keeps "one option per tag" true
      by construction — there is nowhere to put a second vehicle. */
  tags?: Record<string, string>;
}

interface TagOption {
  id: string;
  name: string;
  isActive: boolean;
}
interface ReportingTag {
  id: string;
  name: string;
  isActive: boolean;
  options: TagOption[];
}

const emptyLine = (): FormLine => ({ name: "", quantity: "1", rate: "0", discountPercent: "0", tags: {} });

export interface TransactionFormConfig {
  title: string;
  endpoint: string;
  listPath: string;
  /** attachments entity_type for files queued on this form. */
  entityType: string;
  contactType: "customer" | "vendor";
  contactLabel: string;
  dateField: string;
  dateLabel: string;
  /** Show per-line expense account column (bills, vendor credits). */
  withAccountColumn?: boolean;
  /** Reporting tag columns — only where the server stores them. */
  withTags?: boolean;
  /** Offer "Save and Send" (invoices) in addition to draft. */
  withSend?: boolean;
  /** Capture the vendor's own bill number (bills). */
  withVendorBillNumber?: boolean;
  /** Capture freight and capitalise it into line costs (bills). */
  withFreight?: boolean;
  /** Expected delivery date (purchase orders). */
  withDeliveryDate?: boolean;
  /**
   * Show the tax column and tax the totals.
   *
   * On the purchase side this is TRUE ONLY FOR ORDERS. A purchase order is a
   * document that goes to the vendor, who charges GST, so it has to be able to
   * say ₹50.30 plus 5% rather than a rate with the tax already buried in it.
   * A bill or an expense is our own record, and with no GST input to claim the
   * tax is simply part of what the material cost — so those carry the rate
   * inclusive of tax and no tax line at all. Offering a tax column there would
   * invite a double count.
   */
  withTax?: boolean;
  extraBody?: Record<string, unknown>;
}

/** Books-style transaction entry: header, line-item grid, totals panel. Handles create and edit. */
export function TransactionForm({ config, editId }: { config: TransactionFormConfig; editId?: string }) {
  const [, navigate] = useLocation();
  const uploadFirst = new URLSearchParams(useSearch()).get("upload") === "1";
  const qc = useQueryClient();
  const [contactId, setContactId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [seriesId, setSeriesId] = useState("");
  const [vendorBillNumber, setVendorBillNumber] = useState("");
  const [freightAmount, setFreightAmount] = useState("");
  const [freightVendorId, setFreightVendorId] = useState("");
  const [freightAccountId, setFreightAccountId] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);
  /** Zoho's Adjustment: a typed correction with its own label and account. */
  const [adjustment, setAdjustment] = useState({ amount: "", accountId: "", description: "" });
  /** Tax withheld from the vendor. Purchases only — nobody withholds from us. */
  const [tds, setTds] = useState({ amount: "", section: "" });
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldValues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: existing } = useQuery({
    queryKey: ["doc-edit", config.endpoint, editId],
    queryFn: () =>
      api<Record<string, unknown> & { lines: Array<Record<string, unknown>> }>(
        `${config.endpoint}/${editId}`,
      ),
    enabled: !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    setContactId((existing.customerId ?? existing.vendorId ?? "") as string);
    setDate((existing[config.dateField] as string) ?? date);
    setReference((existing.reference as string) ?? "");
    setVendorBillNumber((existing.vendorBillNumber as string) ?? "");
    setFreightAmount(
      existing.freightAmount && Number(existing.freightAmount) !== 0 ? String(Number(existing.freightAmount)) : "",
    );
    setFreightVendorId((existing.freightVendorId as string) ?? "");
    setFreightAccountId((existing.freightAccountId as string) ?? "");
    setDeliveryDate((existing.expectedDeliveryDate as string) ?? "");
    setNotes((existing.customerNotes as string) ?? "");
    setTds({
      amount:
        existing.tdsAmount && Number(existing.tdsAmount) !== 0
          ? String(Number(existing.tdsAmount))
          : "",
      section: (existing.tdsSection as string) ?? "",
    });
    setAdjustment({
      amount:
        existing.adjustment && Number(existing.adjustment) !== 0
          ? String(Number(existing.adjustment))
          : "",
      accountId: (existing.adjustmentAccountId as string) ?? "",
      description: (existing.adjustmentDescription as string) ?? "",
    });
    setCustomFields(
      Object.fromEntries(
        ((existing.customFieldValues ?? []) as Array<{ fieldId: string; raw: unknown }>).map((v) => [
          v.fieldId,
          v.raw,
        ]),
      ),
    );
    if (existing.lines?.length) {
      setLines(
        existing.lines.map((l) => ({
          itemId: (l.itemId as string) ?? undefined,
          accountId: (l.accountId as string) ?? undefined,
          name: l.name as string,
          quantity: String(Number(l.quantity)),
          unit: (l.unit as string) ?? undefined,
          rate: String(Number(l.rate)),
          discountPercent: String(Number(l.discountPercent ?? 0)),
          taxId: (l.taxId as string) ?? undefined,
          // Rebuild the per-tag map from what the document came back with, so
          // editing a bill keeps the tags it was saved with.
          tags: Object.fromEntries(
            ((l.tags ?? []) as Array<{ tagId: string; optionId: string }>).map((t) => [
              t.tagId,
              t.optionId,
            ]),
          ),
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing]);

  const { data: contacts } = useQuery({
    queryKey: ["contacts", config.contactType],
    queryFn: () => api<Contact[]>(`/api/contacts?type=${config.contactType}&isActive=true`),
  });
  const { data: items } = useQuery({
    queryKey: ["items-active"],
    queryFn: () => api<Item[]>("/api/items?isActive=true"),
  });
  const { data: taxes } = useQuery({
    queryKey: ["taxes"],
    queryFn: () => api<Tax[]>("/api/taxes"),
  });
  // Only offered on create, and only when the org actually runs more than one.
  const { data: allSeries } = useQuery({
    queryKey: ["series"],
    queryFn: () =>
      api<Array<{ id: string; name: string; isDefault: boolean; isActive: boolean }>>(
        "/api/settings/series",
      ),
    enabled: !editId,
  });
  const series = (allSeries ?? []).filter((s) => s.isActive);
  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const { data: allTags } = useQuery({
    queryKey: ["reporting-tags"],
    queryFn: () => api<ReportingTag[]>("/api/reporting-tags"),
    enabled: !!config.withTags,
  });
  // A tag with no usable options would only add an empty column.
  const tags = !config.withTags
    ? []
    : (allTags ?? [])
        .filter((t) => t.isActive)
        .map((t) => ({ ...t, options: t.options.filter((o) => o.isActive) }))
        .filter((t) => t.options.length > 0);

  // A sale credits income; a purchase debits an expense or capitalises an asset.
  // Headings can't be posted to, so they never appear here.
  const lineAccounts = useMemo(() => {
    const wanted =
      config.contactType === "customer" ? ["income"] : ["expense", "asset"];
    return (accounts ?? []).filter(
      (a) => a.isActive && !a.isGroup && wanted.includes(a.type),
    );
  }, [accounts, config.contactType]);

  const taxRate = (id?: string) => Number(taxes?.find((t) => t.id === id)?.rate ?? 0);

  /** Client-side preview only — the server recomputes authoritatively. */
  const totals = useMemo(() => {
    let sub = 0;
    let disc = 0;
    let tax = 0;
    for (const l of lines) {
      const gross = Number(l.quantity || 0) * Number(l.rate || 0);
      const d = (gross * Number(l.discountPercent || 0)) / 100;
      sub += gross;
      disc += d;
      tax += ((gross - d) * taxRate(l.taxId)) / 100;
    }
    // The adjustment lands before rounding, the order the server uses, so the
    // figure that gets rounded is the one the customer actually pays.
    const raw = sub - disc + tax + Number(adjustment.amount || 0);
    const rounded = Math.round(raw);
    // TDS comes off after rounding: it is withheld from what the vendor is
    // paid, not part of what the purchase cost.
    const withheld = Number(tds.amount || 0);
    return { sub, disc, tax, roundOff: rounded - raw, withheld, total: rounded - withheld };
  }, [lines, taxes, adjustment.amount, tds.amount]);

  const updateLine = (i: number, patch: Partial<FormLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const pickItem = (i: number, itemId: string) => {
    const item = items?.find((it) => it.id === itemId);
    if (!item) return updateLine(i, { itemId: undefined });
    updateLine(i, {
      itemId,
      name: item.name,
      unit: item.unit,
      rate:
        (config.contactType === "customer" ? item.sellingPrice : item.costPrice) ??
        item.sellingPrice ??
        "0",
      // Where the document carries no tax, the item's rate is already inclusive
      // of it; attaching the item's tax would charge it a second time.
      taxId: config.withTax ? item.taxId : undefined,
    });
  };

  const save = async (saveAs?: "draft" | "sent") => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        [config.contactType === "customer" ? "customerId" : "vendorId"]: contactId,
        [config.dateField]: date,
        reference: reference || undefined,
        // Only meaningful on create — an existing document keeps the number it was issued.
        seriesId: editId ? undefined : seriesId || undefined,
        lines: lines
          .filter((l) => l.name.trim())
          .map((l) => ({
            itemId: l.itemId || undefined,
            accountId: l.accountId || undefined,
            name: l.name,
            quantity: l.quantity,
            unit: l.unit || undefined,
            rate: l.rate,
            discountPercent: l.discountPercent || undefined,
            taxId: (config.withTax && l.taxId) || undefined,
            ...(config.withTags
              ? { tagOptionIds: Object.values(l.tags ?? {}).filter(Boolean) }
              : {}),
          })),
        customFields,
        ...config.extraBody,
      };
      if (notes) body.customerNotes = notes;
      if (Number(tds.amount || 0) !== 0) {
        body.tdsAmount = Number(tds.amount).toFixed(2);
        if (tds.section) body.tdsSection = tds.section;
      }
      if (Number(adjustment.amount || 0) !== 0) {
        body.adjustment = {
          amount: Number(adjustment.amount).toFixed(2),
          accountId: adjustment.accountId,
          description: adjustment.description || undefined,
        };
      }
      if (config.withVendorBillNumber && vendorBillNumber) body.vendorBillNumber = vendorBillNumber;
      if (config.withFreight && Number(freightAmount) > 0) {
        body.freightAmount = Number(freightAmount).toFixed(2);
        if (freightVendorId) body.freightVendorId = freightVendorId;
        if (freightAccountId) body.freightAccountId = freightAccountId;
      }
      if (config.withDeliveryDate && deliveryDate) body.expectedDeliveryDate = deliveryDate;
      let savedId: string;
      if (editId) {
        await api(`${config.endpoint}/${editId}`, { method: "PATCH", body });
        savedId = editId;
      } else {
        if (saveAs) body.saveAs = saveAs;
        const created = (await api(config.endpoint, { method: "POST", body })) as { id: string };
        savedId = created.id;
      }
      if (pendingFiles.length && savedId) {
        const failed = await uploadPending(config.entityType, savedId, pendingFiles);
        if (failed.length) {
          setError(`Saved, but these files failed to upload: ${failed.join(", ")}`);
        }
      }
      await qc.invalidateQueries();
      navigate(editId ? `${config.listPath}/${savedId}` : config.listPath);
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setError(err.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
      } else {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";

  // Freight can't post without somewhere to charge it, so don't let Save promise otherwise.
  const freightNeedsAccount = config.withFreight && Number(freightAmount) > 0 && !freightAccountId;
  const cannotSave = busy || !contactId || !date || freightNeedsAccount;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">{editId ? config.title.replace("New", "Edit") : config.title}</h1>
        <button onClick={() => navigate(config.listPath)} className="text-xl text-gray-400 hover:text-gray-700">
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {uploadFirst && (
          <div className="mb-5 max-w-3xl rounded-xl border border-brand-200 bg-brand-50/50 p-4">
            <h2 className="mb-1 text-sm font-semibold">Upload the vendor&apos;s bill</h2>
            <p className="mb-3 text-xs text-gray-600">
              Attach the scan or PDF, then key in the details below. The file stays on the bill for your records.
            </p>
            <PendingAttachments files={pendingFiles} onChange={setPendingFiles} label="Upload Bill File(s)" />
          </div>
        )}

        <div className="mb-5 grid max-w-3xl grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className="label-required">
              {config.contactLabel} *
            </label>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={inputCls}>
              <option value="">Select {config.contactLabel.toLowerCase()}…</option>
              {contacts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-required">{config.dateLabel} *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="label">Reference</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
          </div>
          {series.length > 1 && (
            <div>
              <label className="label">Number Series</label>
              <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)} className={inputCls}>
                {series.map((s) => (
                  <option key={s.id} value={s.isDefault ? "" : s.id}>
                    {s.name}
                    {s.isDefault ? " (Default)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          {config.withVendorBillNumber && (
            <div>
              <label className="label">Bill# (vendor&apos;s own)</label>
              <input
                value={vendorBillNumber}
                onChange={(e) => setVendorBillNumber(e.target.value)}
                className={inputCls}
              />
            </div>
          )}
          {config.withDeliveryDate && (
            <div>
              <label className="label">Expected Delivery Date</label>
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className={inputCls}
              />
            </div>
          )}
          {config.withFreight && (
            <>
              <div>
                <label className="label">Freight / Transport</label>
                <input
                  value={freightAmount}
                  onChange={(e) => setFreightAmount(e.target.value)}
                  placeholder="0.00"
                  className={inputCls}
                />
              </div>
              {Number(freightAmount) > 0 && (
                <>
                  <div>
                    <label className="label">Transporter</label>
                    <select
                      value={freightVendorId}
                      onChange={(e) => setFreightVendorId(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">Select transporter…</option>
                      {contacts?.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label-required">Freight Expense Account *</label>
                    <select
                      value={freightAccountId}
                      onChange={(e) => setFreightAccountId(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">Select account…</option>
                      {accounts
                        ?.filter((a) => a.type === "expense")
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="col-span-3 -mt-1">
                    <p className="text-[11px] text-gray-500">
                      The transporter is billed separately — freight gets its own journal entry and never touches this
                      vendor&apos;s payable. It is only shared across the lines to show each item&apos;s true landed cost.
                    </p>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <CustomFieldsBlock
          entity={config.entityType}
          value={customFields}
          onChange={setCustomFields}
        />

        <table className="mb-3 w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="w-56 border border-[#ebeaf2] px-2 py-2">Item</th>
              <th className="border border-[#ebeaf2] px-2 py-2">Details</th>
              {config.withAccountColumn && <th className="w-44 border border-[#ebeaf2] px-2 py-2">Account</th>}
              <th className="w-20 border border-[#ebeaf2] px-2 py-2">Qty</th>
              <th className="w-28 border border-[#ebeaf2] px-2 py-2">Rate</th>
              <th className="w-20 border border-[#ebeaf2] px-2 py-2">Disc %</th>
              {config.withTax && <th className="w-32 border border-[#ebeaf2] px-2 py-2">Tax</th>}
              {tags.map((t) => (
                <th key={t.id} className="w-40 border border-[#ebeaf2] px-2 py-2 whitespace-nowrap">
                  {t.name}
                </th>
              ))}
              <th className="w-28 border border-[#ebeaf2] px-2 py-2 text-right">Amount</th>
              <th className="w-8 border border-[#ebeaf2]" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const gross = Number(l.quantity || 0) * Number(l.rate || 0);
              const net = gross - (gross * Number(l.discountPercent || 0)) / 100;
              return (
                <tr key={i}>
                  <td className="border border-[#ebeaf2] px-1 py-1">
                    <select value={l.itemId ?? ""} onChange={(e) => pickItem(i, e.target.value)} className={inputCls}>
                      <option value="">— manual —</option>
                      {items?.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-[#ebeaf2] px-1 py-1">
                    <input
                      value={l.name}
                      onChange={(e) => updateLine(i, { name: e.target.value })}
                      placeholder="Description"
                      className={inputCls}
                    />
                  </td>
                  {config.withAccountColumn && (
                    <td className="border border-[#ebeaf2] px-1 py-1">
                      <select
                        value={l.accountId ?? ""}
                        onChange={(e) => updateLine(i, { accountId: e.target.value || undefined })}
                        className={inputCls}
                      >
                        <option value="">Item default</option>
                        {lineAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  <td className="border border-[#ebeaf2] px-1 py-1">
                    <input value={l.quantity} onChange={(e) => updateLine(i, { quantity: e.target.value })} className={inputCls} />
                  </td>
                  <td className="border border-[#ebeaf2] px-1 py-1">
                    <input value={l.rate} onChange={(e) => updateLine(i, { rate: e.target.value })} className={inputCls} />
                  </td>
                  <td className="border border-[#ebeaf2] px-1 py-1">
                    <input
                      value={l.discountPercent}
                      onChange={(e) => updateLine(i, { discountPercent: e.target.value })}
                      className={inputCls}
                    />
                  </td>
                  {config.withTax && (
                    <td className="border border-[#ebeaf2] px-1 py-1">
                      <select value={l.taxId ?? ""} onChange={(e) => updateLine(i, { taxId: e.target.value || undefined })} className={inputCls}>
                        <option value="">No tax</option>
                        {taxes?.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  {tags.map((t) => (
                    <td key={t.id} className="border border-[#ebeaf2] px-1 py-1">
                      <select
                        value={l.tags?.[t.id] ?? ""}
                        onChange={(e) =>
                          updateLine(i, { tags: { ...(l.tags ?? {}), [t.id]: e.target.value } })
                        }
                        className={inputCls}
                      >
                        <option value="">—</option>
                        {t.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                  <td className="border border-[#ebeaf2] px-2 py-1 text-right tabular-nums">{formatMoney(net)}</td>
                  <td className="border border-[#ebeaf2] text-center">
                    {lines.length > 1 && (
                      <button
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                        className="text-gray-400 hover:text-red-600"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button
          onClick={() => setLines((ls) => [...ls, emptyLine()])}
          className="mb-6 text-[13px] font-medium text-brand-600 hover:underline"
        >
          + Add another line
        </button>

        <div className="flex max-w-5xl items-start justify-between gap-8">
          <div className="flex-1 space-y-4">
            <div>
              <label className="label">Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputCls} />
            </div>
            {!uploadFirst && (
              <PendingAttachments
                files={pendingFiles}
                onChange={setPendingFiles}
                label={`Attach File(s) to ${config.title.replace("New ", "")}`}
              />
            )}
          </div>
          <div className="w-80 rounded-xl border border-gray-200/80 bg-gray-50/80 p-5 text-[13px] shadow-[0_1px_3px_rgba(16,24,40,0.05)]">
            <div className="mb-1.5 flex justify-between">
              <span>Sub Total</span>
              <span className="tabular-nums">{formatMoney(totals.sub)}</span>
            </div>
            {totals.disc > 0 && (
              <div className="mb-1.5 flex justify-between text-gray-600">
                <span>Discount</span>
                <span className="tabular-nums">− {formatMoney(totals.disc)}</span>
              </div>
            )}
            {config.withTax && (
              <div className="mb-1.5 flex justify-between">
                <span>Tax</span>
                <span className="tabular-nums">{formatMoney(totals.tax)}</span>
              </div>
            )}
            {/* Zoho puts the adjustment here, between tax and the total, with
                an editable label. It needs an account of its own — it is a real
                posting, not a rounding artefact. */}
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <input
                value={adjustment.description}
                onChange={(e) => setAdjustment((a) => ({ ...a, description: e.target.value }))}
                placeholder="Adjustment"
                className="w-24 border-b border-dashed border-gray-300 bg-transparent text-[13px] outline-none focus:border-brand-400"
              />
              <select
                value={adjustment.accountId}
                onChange={(e) => setAdjustment((a) => ({ ...a, accountId: e.target.value }))}
                className="min-w-0 flex-1 border-b border-dashed border-gray-300 bg-transparent text-[12px] text-gray-500 outline-none focus:border-brand-400"
              >
                <option value="">account…</option>
                {(accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
              <input
                value={adjustment.amount}
                onChange={(e) => setAdjustment((a) => ({ ...a, amount: e.target.value }))}
                placeholder="0.00"
                inputMode="decimal"
                className="w-20 border-b border-dashed border-gray-300 bg-transparent text-right text-[13px] tabular-nums outline-none focus:border-brand-400"
              />
            </div>
            <div className="mb-2 flex justify-between text-gray-600">
              <span>Round Off</span>
              <span className="tabular-nums">{totals.roundOff >= 0 ? "" : "− "}{formatMoney(Math.abs(totals.roundOff))}</span>
            </div>
            {config.contactType === "vendor" && (
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-gray-600">TDS</span>
                <input
                  value={tds.section}
                  onChange={(e) => setTds((t) => ({ ...t, section: e.target.value }))}
                  placeholder="section"
                  className="w-20 border-b border-dashed border-gray-300 bg-transparent text-[12px] text-gray-500 outline-none focus:border-brand-400"
                />
                <input
                  value={tds.amount}
                  onChange={(e) => setTds((t) => ({ ...t, amount: e.target.value }))}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="w-20 border-b border-dashed border-gray-300 bg-transparent text-right text-[13px] tabular-nums outline-none focus:border-brand-400"
                />
              </div>
            )}
            <div className="flex justify-between border-t pt-2 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(totals.total)}</span>
            </div>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>

      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save(config.withSend && !editId ? "draft" : undefined)}
          disabled={cannotSave}
          className={editId ? "btn-primary" : "btn-secondary"}
        >
          {editId ? "Save Changes" : "Save as Draft"}
        </button>
        {config.withSend && !editId && (
          <button
            onClick={() => void save("sent")}
            disabled={cannotSave}
            className="btn-primary"
          >
            Save and Send
          </button>
        )}
        <button onClick={() => navigate(config.listPath)} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
