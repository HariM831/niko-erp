import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { amountInWords, api, formatDate, formatMoney } from "../api";
import { StatusBadge } from "../components/list-page";
import { AttachmentsButton } from "../components/attachments";
import { CommentsButton } from "../components/comments";
import { JournalSection } from "../components/journal-section";

/** Route kind → journal_entries.source_type; kinds that never post a journal are omitted. */
const JOURNAL_SOURCE_TYPE: Record<string, string> = {
  invoice: "invoice",
  "credit-note": "credit_note",
  bill: "bill",
  "vendor-credit": "vendor_credit",
};

/** Route kind → attachments entity_type. */
const ENTITY_TYPE: Record<string, string> = {
  invoice: "invoice",
  "credit-note": "credit_note",
  bill: "bill",
  "purchase-order": "purchase_order",
  "vendor-credit": "vendor_credit",
};

interface DetailLine {
  id: string;
  name: string;
  description?: string;
  quantity: string;
  unit?: string;
  rate: string;
  discountPercent: string;
  taxAmount: string;
  amount: string;
  allocatedFreight?: string;
  landedUnitCost?: string;
  tags?: Array<{ tagName: string; optionName: string }>;
}

interface DetailDoc {
  id: string;
  number: string;
  status: string;
  subTotal: string;
  discountTotal: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  total: string;
  balanceDue?: string;
  balance?: string;
  reference?: string;
  lines: DetailLine[];
  payments?: Array<{ paymentId: string; paymentNumber: string; paymentDate: string; amountApplied: string }>;
  applications?: Array<{ invoiceNumber: string; amountApplied: string }>;
  [k: string]: unknown;
}

interface ActionDef {
  label: string;
  /** Statuses in which this action is shown. */
  when: string[];
  danger?: boolean;
  run: (doc: DetailDoc, helpers: ActionHelpers) => Promise<void> | void;
}

interface ActionHelpers {
  post: (path: string, body?: unknown) => Promise<unknown>;
  navigate: (path: string) => void;
  refresh: () => Promise<void>;
}

interface DetailConfig {
  titlePrefix: string;
  endpoint: string;
  listPath: string;
  dateField: string;
  contactNameOf?: (doc: DetailDoc) => string;
  actions: ActionDef[];
}

const today = () => new Date().toISOString().slice(0, 10);

/** Integer paise, so money comparisons never hit float drift. */
const toPaise = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/** Plain Indian-locale number, no currency symbol — Zoho only puts ₹ on Total and Balance Due. */
const formatNum = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** GST state code → state name, for "Place Of Supply : Assam (18)". */
const GST_STATES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan",
  "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
  "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
  "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
  "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
  "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh",
};

function placeOfSupply(code?: string | null): string | null {
  if (!code) return null;
  const padded = code.padStart(2, "0");
  const name = GST_STATES[padded];
  return name ? `${name} (${padded})` : padded;
}

/** dd/mm/yyyy, the format Zoho prints on documents. */
const slashDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

function termsLabel(docDate?: string, dueDate?: string): string | null {
  if (!docDate || !dueDate) return null;
  const days = Math.round(
    (new Date(`${dueDate}T00:00:00Z`).getTime() - new Date(`${docDate}T00:00:00Z`).getTime()) / 86_400_000,
  );
  return days <= 0 ? "Due on Receipt" : `Net ${days}`;
}

const CONFIGS: Record<string, DetailConfig> = {
  invoice: {
    titlePrefix: "Invoice",
    endpoint: "/api/sales/invoices",
    listPath: "/sales/invoices",
    dateField: "invoiceDate",
    actions: [
      {
        label: "Edit",
        when: ["draft"],
        run: (doc, h) => h.navigate(`/sales/invoices/${doc.id}/edit`),
      },
      {
        label: "Mark as Sent",
        when: ["draft"],
        run: async (doc, h) => {
          await h.post(`/api/sales/invoices/${doc.id}/send`);
          await h.refresh();
        },
      },
      {
        label: "Record Payment",
        when: ["sent", "partially_paid"],
        run: (doc, h) => h.navigate(`/sales/payments/new?contactId=${doc.customerId}&docId=${doc.id}`),
      },
      {
        label: "Void",
        when: ["draft", "sent"],
        danger: true,
        run: async (doc, h) => {
          if (!confirm(`Void ${doc.number}? Its journal entry will be reversed.`)) return;
          await h.post(`/api/sales/invoices/${doc.id}/void`, { voidDate: today() });
          await h.refresh();
        },
      },
    ],
  },
  "credit-note": {
    titlePrefix: "Credit Note",
    endpoint: "/api/sales/credit-notes",
    listPath: "/sales/credit-notes",
    dateField: "creditNoteDate",
    actions: [
      {
        label: "Edit",
        when: ["open", "closed"],
        run: (doc, h) => {
          if (doc.status !== "open" || toPaise(doc.balance) !== toPaise(doc.total)) {
            alert(
              `${doc.number} is applied to an invoice, so its amounts are locked.\n\nUnapply it first to make changes.`,
            );
            return;
          }
          h.navigate(`/sales/credit-notes/${doc.id}/edit`);
        },
      },
      {
        label: "Void",
        when: ["open"],
        danger: true,
        run: async (doc, h) => {
          if (!confirm(`Void ${doc.number}? Its journal entry will be reversed.`)) return;
          await h.post(`/api/sales/credit-notes/${doc.id}/void`, { voidDate: today() });
          await h.refresh();
        },
      },
    ],
  },
  bill: {
    titlePrefix: "Bill",
    endpoint: "/api/purchases/bills",
    listPath: "/purchases/bills",
    dateField: "billDate",
    actions: [
      {
        // Re-states the bill: old journals reversed, new ones posted. Stays visible
        // once paid so the reason it's unavailable is explained, not just missing.
        label: "Edit",
        when: ["open", "partially_paid", "paid"],
        run: (doc, h) => {
          if (doc.status !== "open") {
            alert(
              `${doc.number} has payments applied, so its amounts are locked.\n\nUnapply the payment first, or raise a vendor credit to adjust it.`,
            );
            return;
          }
          h.navigate(`/purchases/bills/${doc.id}/edit`);
        },
      },
      {
        label: "Record Payment",
        when: ["open", "partially_paid"],
        run: (doc, h) => h.navigate(`/purchases/payments/new?contactId=${doc.vendorId}&docId=${doc.id}`),
      },
      {
        label: "Void",
        when: ["open"],
        danger: true,
        run: async (doc, h) => {
          if (!confirm(`Void ${doc.number}? Its journal entry will be reversed.`)) return;
          await h.post(`/api/purchases/bills/${doc.id}/void`, { voidDate: today() });
          await h.refresh();
        },
      },
    ],
  },
  "purchase-order": {
    titlePrefix: "Purchase Order",
    endpoint: "/api/purchases/orders",
    listPath: "/purchases/orders",
    dateField: "orderDate",
    actions: [
      {
        label: "Edit",
        when: ["draft", "issued", "partially_billed", "billed"],
        run: (doc, h) => {
          if (doc.status === "billed" || doc.status === "partially_billed") {
            alert(`${doc.number} has already been billed.\n\nEdit the resulting bill instead.`);
            return;
          }
          h.navigate(`/purchases/orders/${doc.id}/edit`);
        },
      },
      {
        label: "Mark as Issued",
        when: ["draft"],
        run: async (doc, h) => {
          await h.post(`/api/purchases/orders/${doc.id}/status`, { status: "issued" });
          await h.refresh();
        },
      },
      {
        label: "Convert to Bill",
        when: ["issued", "partially_billed"],
        run: async (doc, h) => {
          await h.post(`/api/purchases/orders/${doc.id}/convert-to-bill`, { billDate: today() });
          h.navigate("/purchases/bills");
        },
      },
      {
        label: "Cancel",
        when: ["draft", "issued"],
        danger: true,
        run: async (doc, h) => {
          if (!confirm(`Cancel ${doc.number}?`)) return;
          await h.post(`/api/purchases/orders/${doc.id}/status`, { status: "cancelled" });
          await h.refresh();
        },
      },
    ],
  },
  "vendor-credit": {
    titlePrefix: "Vendor Credit",
    endpoint: "/api/purchases/vendor-credits",
    listPath: "/purchases/vendor-credits",
    dateField: "creditDate",
    actions: [
      {
        label: "Edit",
        when: ["open", "closed"],
        run: (doc, h) => {
          if (doc.status !== "open" || toPaise(doc.balance) !== toPaise(doc.total)) {
            alert(
              `${doc.number} is applied to a bill, so its amounts are locked.\n\nUnapply it first to make changes.`,
            );
            return;
          }
          h.navigate(`/purchases/vendor-credits/${doc.id}/edit`);
        },
      },
    ],
  },
};

export function DocumentDetailPage({ kind, id }: { kind: string; id: string }) {
  const config = CONFIGS[kind];
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: prefs } = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api<{ hideZeroValueLines: boolean }>("/api/settings/preferences"),
  });
  const { data: doc, isLoading } = useQuery({
    queryKey: ["doc", kind, id],
    queryFn: () => api<DetailDoc>(`${config!.endpoint}/${id}`),
    enabled: !!config,
  });
  const contactId = (doc?.customerId ?? doc?.vendorId) as string | undefined;
  const { data: contact } = useQuery({
    queryKey: ["contact-mini", contactId],
    queryFn: () =>
      api<{
        displayName: string;
        gstin?: string;
        placeOfSupplyState?: string;
        addresses: Array<{ kind: string; line1?: string; line2?: string; city?: string; state?: string; pincode?: string }>;
      }>(`/api/contacts/${contactId}`),
    enabled: !!contactId,
  });
  const { data: org } = useQuery({
    queryKey: ["org"],
    queryFn: () =>
      api<{
        name: string;
        address?: string;
        city?: string;
        state?: string;
        pincode?: string;
        gstin?: string;
        phone?: string;
        email?: string;
      } | null>("/api/settings/org"),
  });

  if (!config) return <div className="p-8 text-sm text-gray-500">Unknown document type.</div>;
  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!doc) return <div className="p-8 text-sm text-red-600">Document not found.</div>;

  const helpers: ActionHelpers = {
    post: (path, body) => api(path, { method: "POST", body: body ?? {} }),
    navigate,
    refresh: async () => {
      await qc.invalidateQueries();
    },
  };

  const runAction = async (a: ActionDef) => {
    setBusy(true);
    setError(null);
    try {
      await a.run(doc, helpers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const visibleActions = config.actions.filter((a) => a.when.includes(doc.status));
  const balance = doc.balanceDue ?? doc.balance;

  // Zoho prints vendor credits under the same "CREDIT NOTE" heading as customer credit notes.
  const docTitle =
    kind === "invoice" ? "TAX INVOICE" : kind === "vendor-credit" ? "CREDIT NOTE" : config.titlePrefix.toUpperCase();
  const billingAddr = contact?.addresses?.find((a) => a.kind === "billing");
  const shippingAddr = contact?.addresses?.find((a) => a.kind === "shipping") ?? billingAddr;
  const isSales = ["invoice", "credit-note"].includes(kind);
  const supply = placeOfSupply(contact?.placeOfSupplyState);
  const terms = termsLabel(doc[config.dateField] as string | undefined, doc.dueDate as string | undefined);

  const addressLines = (a?: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string }) =>
    a ? [a.line1, a.line2, a.city, [a.pincode, a.state].filter(Boolean).join(" "), "India"].filter(Boolean) as string[] : [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-2.5 print:hidden">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(config.listPath)} className="text-gray-400 hover:text-gray-700">
            ←
          </button>
          <h1 className="text-base font-semibold">{doc.number}</h1>
          <StatusBadge status={doc.status} />
        </div>
        <div className="flex items-center gap-1 text-[13px]">
          <CommentsButton
            entityType={ENTITY_TYPE[kind] ?? kind}
            entityId={id}
            history={[
              { label: `${config.titlePrefix} created`, at: doc.createdAt as string | undefined },
              ...(doc.payments?.map((p) => ({
                label: `Payment ${p.paymentNumber} applied`,
                at: p.paymentDate,
              })) ?? []),
            ]}
          />
          <AttachmentsButton entityType={ENTITY_TYPE[kind] ?? kind} entityId={id} />
          <button
            onClick={() => window.print()}
            className="rounded px-2.5 py-1.5 font-medium text-gray-700 hover:bg-gray-100"
          >
            PDF/Print
          </button>
          {visibleActions.map((a) => (
            <button
              key={a.label}
              disabled={busy}
              onClick={() => void runAction(a)}
              className={`rounded px-2.5 py-1.5 font-medium disabled:opacity-50 ${
                a.danger ? "text-red-600 hover:bg-red-50" : "text-brand-700 hover:bg-brand-50"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="border-b bg-red-50 px-6 py-2 text-sm text-red-700 print:hidden">{error}</p>}

      {doc.status === "sent" && kind === "invoice" && Number(doc.balanceDue) > 0 && (
        <div className="flex items-center justify-between border-b bg-brand-50/60 px-6 py-2.5 text-[13px] print:hidden">
          <span>
            <strong>What&apos;s next?</strong> The invoice is out — record the payment when it arrives.
          </span>
          <button
            onClick={() => navigate(`/sales/payments/new?contactId=${doc.customerId}&docId=${doc.id}`)}
            className="rounded-md bg-brand-500 px-3 py-1.5 font-medium text-white hover:bg-brand-600"
          >
            Record Payment
          </button>
        </div>
      )}

      {doc.status === "draft" && kind === "purchase-order" && (
        <div className="flex items-center justify-between border-b bg-brand-50/60 px-6 py-2.5 text-[13px] print:hidden">
          <span>
            <strong>What&apos;s next?</strong> Send this purchase order to your vendor or mark it as issued.
          </span>
          <button
            onClick={() =>
              void runAction(config.actions.find((a) => a.label === "Mark as Issued")!)
            }
            disabled={busy}
            className="rounded-md bg-brand-500 px-3 py-1.5 font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            Mark as Issued
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto bg-gray-100 p-6 print:bg-white print:p-0">
        <div className="a4-sheet relative mx-auto border bg-white shadow-sm print:border-0 print:shadow-none">
          {/* Corner ribbon: clipped to the sheet's top-left without clipping the page body. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden print:hidden">
            <div
              className={`absolute -left-10 top-5 w-36 -rotate-45 py-1 text-center text-[11px] font-semibold uppercase tracking-wider text-white ${
              doc.status === "paid" || doc.status === "closed"
                ? "bg-green-600"
                : doc.status === "void" || doc.status === "cancelled"
                  ? "bg-red-500"
                  : doc.status === "draft"
                      ? "bg-gray-400"
                      : "bg-brand-500"
              }`}
            >
              {doc.status.replace(/_/g, " ")}
            </div>
          </div>

          {/* Zoho "Spreadsheet Template": hairline #9e9e9e grid, Ubuntu-ish 8pt body. */}
          <div className="p-9 text-[11px] leading-[15px] text-black">
            <div className="flex items-stretch justify-between px-2.5 pb-2">
              <div className="w-1/2">
                <div className="mb-1.5 text-[15px] font-bold leading-none">{org?.name || "Your Business"}</div>
                <div className="whitespace-pre-line">
                  {[
                    org?.address,
                    [org?.city, org?.state, org?.pincode].filter(Boolean).join(" "),
                    "India",
                    org?.gstin ? `GSTIN ${org.gstin}` : null,
                    org?.phone,
                    org?.email,
                  ]
                    .filter(Boolean)
                    .join("\n")}
                </div>
              </div>
              <div className="flex w-2/5 items-end justify-end">
                <div className="text-[27px] leading-none">{docTitle}</div>
              </div>
            </div>

            <div className="flex border-t border-[#9e9e9e]">
              <div className="w-1/2 space-y-0.5 border-r border-[#9e9e9e] px-2.5 pb-2.5 pt-1.5">
                <div className="flex">
                  <span className="w-24 shrink-0 text-[#333]">#</span>
                  <span className="font-semibold">: {doc.number}</span>
                </div>
                <div className="flex">
                  <span className="w-24 shrink-0 text-[#333]">{config.titlePrefix} Date</span>
                  <span className="font-semibold">: {slashDate(doc[config.dateField] as string)}</span>
                </div>
                {terms && (
                  <div className="flex">
                    <span className="w-24 shrink-0 text-[#333]">Terms</span>
                    <span className="font-semibold">: {terms}</span>
                  </div>
                )}
                {doc.dueDate ? (
                  <div className="flex">
                    <span className="w-24 shrink-0 text-[#333]">Due Date</span>
                    <span className="font-semibold">: {slashDate(doc.dueDate as string)}</span>
                  </div>
                ) : null}
                {doc.reference ? (
                  <div className="flex">
                    <span className="w-24 shrink-0 text-[#333]">Reference</span>
                    <span className="font-semibold">: {doc.reference}</span>
                  </div>
                ) : null}
              </div>
              <div className="w-1/2 px-2.5 pb-2.5 pt-1.5">
                {supply && (
                  <div className="flex">
                    <span className="w-28 shrink-0 text-[#333]">Place Of Supply</span>
                    <span className="font-semibold">: {supply}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex border-t border-[#9e9e9e]">
              <div className="w-1/2 border-r border-[#9e9e9e] px-2.5 pb-2.5">
                <div className="py-1 font-bold text-[#333]">{isSales ? "Bill To" : "Vendor"}</div>
                {contactId ? (
                  <Link
                    href={`${isSales ? "/sales/customers" : "/purchases/vendors"}/${contactId}`}
                    className="text-[12px] font-bold text-brand-700 hover:underline"
                  >
                    {contact?.displayName ?? "—"}
                  </Link>
                ) : (
                  <span className="text-[12px] font-bold">{contact?.displayName ?? "—"}</span>
                )}
                {addressLines(billingAddr).map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
                {contact?.gstin && <div>GSTIN {contact.gstin}</div>}
              </div>
              <div className="w-1/2 px-2.5 pb-2.5">
                {isSales ? (
                  <>
                    <div className="py-1 font-bold text-[#333]">Ship To</div>
                    {addressLines(shippingAddr).map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </>
                ) : kind === "purchase-order" ? (
                  // Zoho prints where the vendor should deliver — our own address.
                  <>
                    <div className="py-1 font-bold text-[#333]">Deliver To</div>
                    <div className="text-[12px] font-bold">{org?.name}</div>
                    {org?.address && <div>{org.address}</div>}
                    <div>{[org?.city, org?.pincode, org?.state].filter(Boolean).join(" ")}</div>
                    <div>India</div>
                  </>
                ) : null}
              </div>
            </div>

            <table className="w-full">
              <thead>
                <tr className="bg-[#f2f3f4]">
                  <th className="w-[5%] px-1.5 pb-0.5 pt-1.5 text-center align-bottom font-bold">#</th>
                  <th className="px-2 pb-0.5 pt-1.5 text-left align-bottom font-bold">Item &amp; Description</th>
                  <th className="w-[11%] px-2 pb-0.5 pt-1.5 text-right align-bottom font-bold">Qty</th>
                  <th className="w-[11%] px-2 pb-0.5 pt-1.5 text-right align-bottom font-bold">Rate</th>
                  <th className="w-[13%] px-2 pb-0.5 pt-1.5 text-right align-bottom font-bold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {doc.lines
                  .filter((l) => !prefs?.hideZeroValueLines || Number(l.amount) !== 0)
                  .map((l, i) => (
                  <tr key={l.id} className="border-b border-[#9e9e9e]">
                    <td className="px-1.5 py-1.5 text-center align-top">{i + 1}</td>
                    <td className="px-2 py-1.5 align-top">
                      <div>{l.name}</div>
                      {l.description && (
                        <div className="whitespace-pre-wrap text-[10px] text-[#727272]">{l.description}</div>
                      )}
                      {/* Internal analysis, not something the vendor should see —
                          on screen only, never on the printed document. */}
                      {l.tags && l.tags.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-1 print:hidden">
                          {l.tags.map((t) => (
                            <span
                              key={t.tagName}
                              className="inline-flex items-center gap-1 rounded border border-[#c9c9c9] px-1 text-[9px] leading-4 text-[#4a4a4a]"
                            >
                              <span className="text-[#8a8a8a]">{t.tagName}</span>
                              {t.optionName}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right align-top tabular-nums">
                      {formatNum(l.quantity)}
                      {l.unit && <div>{l.unit}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right align-top tabular-nums">{formatNum(l.rate)}</td>
                    <td className="px-2 py-1.5 text-right align-top tabular-nums">{formatNum(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-px flex">
              <div className="w-1/2 px-2 pt-2.5">
                <div className="mb-1.5 mt-2">
                  <div className="pb-0.5 pr-2.5">Total In Words</div>
                  <span className="font-bold italic">{amountInWords(doc.total)}</span>
                </div>
                {(doc.customerNotes ?? doc.notes) ? (
                  <div className="pt-2.5">
                    <div className="text-[#333]">Notes</div>
                    <p className="whitespace-pre-wrap">{(doc.customerNotes ?? doc.notes) as string}</p>
                  </div>
                ) : null}
                {doc.termsAndConditions ? (
                  <div className="pt-2.5">
                    <div className="text-[#333]">Terms &amp; Conditions</div>
                    <p className="whitespace-pre-wrap">{doc.termsAndConditions as string}</p>
                  </div>
                ) : null}
              </div>
              <div className="ml-auto w-[43.6%]">
                <table className="w-full border-l border-[#9e9e9e]">
                  <tbody>
                    <tr>
                      <td className="py-1.5 pr-2.5 text-right align-middle">Sub Total</td>
                      <td className="w-[110px] py-1.5 pl-1.5 pr-2.5 text-right align-middle tabular-nums">
                        {formatNum(doc.subTotal)}
                      </td>
                    </tr>
                    {Number(doc.discountTotal) > 0 && (
                      <tr>
                        <td className="py-1 pr-2.5 text-right align-middle">Discount</td>
                        <td className="py-1 pl-1.5 pr-2.5 text-right align-middle tabular-nums">
                          (-) {formatNum(doc.discountTotal)}
                        </td>
                      </tr>
                    )}
                    {Number(doc.cgst) > 0 && (
                      <tr>
                        <td className="py-1 pr-2.5 text-right align-middle">CGST</td>
                        <td className="py-1 pl-1.5 pr-2.5 text-right align-middle tabular-nums">{formatNum(doc.cgst)}</td>
                      </tr>
                    )}
                    {Number(doc.sgst) > 0 && (
                      <tr>
                        <td className="py-1 pr-2.5 text-right align-middle">SGST</td>
                        <td className="py-1 pl-1.5 pr-2.5 text-right align-middle tabular-nums">{formatNum(doc.sgst)}</td>
                      </tr>
                    )}
                    {Number(doc.igst) > 0 && (
                      <tr>
                        <td className="py-1 pr-2.5 text-right align-middle">IGST</td>
                        <td className="py-1 pl-1.5 pr-2.5 text-right align-middle tabular-nums">{formatNum(doc.igst)}</td>
                      </tr>
                    )}
                    {Number(doc.roundOff) !== 0 && (
                      <tr>
                        <td className="py-1 pr-2.5 text-right align-middle">Round Off</td>
                        <td className="py-1 pl-1.5 pr-2.5 text-right align-middle tabular-nums">{formatNum(doc.roundOff)}</td>
                      </tr>
                    )}
                    <tr>
                      <td className="py-1.5 pr-2.5 text-right align-middle text-[12px] font-bold">Total</td>
                      <td className="py-1.5 pl-1.5 pr-2.5 text-right align-middle text-[12px] font-bold tabular-nums">
                        ₹{formatNum(doc.total)}
                      </td>
                    </tr>
                    {balance !== undefined && (
                      <tr>
                        <td className="py-1.5 pr-2.5 text-right align-middle text-[12px] font-bold">Balance Due</td>
                        <td className="py-1.5 pl-1.5 pr-2.5 text-right align-middle text-[12px] font-bold tabular-nums">
                          ₹{formatNum(balance)}
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td colSpan={2} className="border-b border-[#9e9e9e]"></td>
                    </tr>
                    <tr>
                      <td colSpan={2} className="pt-1.5 text-center">
                        <div className="min-h-[75px]"></div>
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={2} className="border-b border-[#9e9e9e] pb-0.5 text-center">
                        Authorized Signature
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {!!doc.payments?.length && (
              <div className="mt-10 print:hidden">
                <h3 className="mb-2 text-sm font-semibold">Payments Received</h3>
                <table className="w-full text-[13px]">
                  <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="border-b border-[#ebeaf2] px-3 py-2">Payment #</th>
                      <th className="border-b border-[#ebeaf2] px-3 py-2">Date</th>
                      <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Amount Applied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.payments.map((p, i) => (
                      <tr key={i} className="border-b border-[#ebeaf2]">
                        <td className="px-3 py-2">
                          <Link
                            href={`${isSales ? "/sales/payments" : "/purchases/payments"}/${p.paymentId}`}
                            className="font-medium text-brand-600 hover:underline"
                          >
                            {p.paymentNumber}
                          </Link>
                        </td>
                        <td className="px-3 py-2">{formatDate(p.paymentDate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.amountApplied)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {Number(doc.freightAmount ?? 0) > 0 && (
              <div className="mt-10 print:hidden">
                <h3 className="mb-1 text-sm font-semibold">Landed Cost</h3>
                <p className="mb-2 text-xs text-gray-500">
                  Costing view only. Freight of {formatMoney(doc.freightAmount as string)} is shared across lines by
                  value to show the true per-unit cost. The transporter is a separate party — their charge is
                  journalled on its own expense or bill, not against this vendor.
                </p>
                <table className="w-full max-w-3xl text-[13px]">
                  <thead className="table-head">
                    <tr>
                      <th className="border-b border-[#ebeaf2] px-3 py-2">Item</th>
                      <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Qty</th>
                      <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Line Amount</th>
                      <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">+ Freight</th>
                      <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Landed Cost</th>
                      <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Landed Unit Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.lines.map((l) => (
                      <tr key={l.id} className="border-b border-[#ebeaf2]">
                        <td className="px-3 py-2">{l.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatNum(l.quantity)} {l.unit ?? ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.amount)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.allocatedFreight ?? 0)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMoney(Number(l.amount) + Number(l.allocatedFreight ?? 0))}
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {formatMoney(l.landedUnitCost ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {JOURNAL_SOURCE_TYPE[kind] && (
              <JournalSection
                // The stored id is the *current* entry; a source lookup would find
                // the original one, which an edit has since reversed.
                entryId={(doc.journalEntryId as string) ?? undefined}
                sourceType={JOURNAL_SOURCE_TYPE[kind]}
                sourceId={doc.id}
                heading={config.titlePrefix}
                note={
                  Number(doc.freightAmount ?? 0) > 0
                    ? "Goods only — the freight is expensed on its own entry below."
                    : undefined
                }
              />
            )}

            {doc.freightJournalEntryId ? (
              <JournalSection
                entryId={doc.freightJournalEntryId as string}
                heading="Freight"
                note={`Charged to ${doc.freightVendorName ?? "the transporter"}, separate from ${contact?.displayName ?? "the goods vendor"}.`}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

