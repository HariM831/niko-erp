import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";
import { StatusBadge } from "../components/list-page";
import { AttachmentsButton } from "../components/attachments";

/** Route kind → attachments entity_type. */
const ENTITY_TYPE: Record<string, string> = {
  invoice: "invoice",
  estimate: "estimate",
  "sales-order": "sales_order",
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
  payments?: Array<{ paymentNumber: string; paymentDate: string; amountApplied: string }>;
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

const CONFIGS: Record<string, DetailConfig> = {
  invoice: {
    titlePrefix: "Invoice",
    endpoint: "/api/sales/invoices",
    listPath: "/sales/invoices",
    dateField: "invoiceDate",
    actions: [
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
        run: (_doc, h) => h.navigate("/sales/payments/new"),
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
  estimate: {
    titlePrefix: "Estimate",
    endpoint: "/api/sales/estimates",
    listPath: "/sales/estimates",
    dateField: "estimateDate",
    actions: [
      {
        label: "Mark as Sent",
        when: ["draft"],
        run: async (doc, h) => {
          await h.post(`/api/sales/estimates/${doc.id}/status`, { status: "sent" });
          await h.refresh();
        },
      },
      {
        label: "Mark Accepted",
        when: ["sent"],
        run: async (doc, h) => {
          await h.post(`/api/sales/estimates/${doc.id}/status`, { status: "accepted" });
          await h.refresh();
        },
      },
      {
        label: "Mark Declined",
        when: ["sent"],
        danger: true,
        run: async (doc, h) => {
          await h.post(`/api/sales/estimates/${doc.id}/status`, { status: "declined" });
          await h.refresh();
        },
      },
      {
        label: "Convert to Sales Order",
        when: ["accepted"],
        run: async (doc, h) => {
          await h.post(`/api/sales/estimates/${doc.id}/convert-to-sales-order`);
          h.navigate("/sales/sales-orders");
        },
      },
    ],
  },
  "sales-order": {
    titlePrefix: "Sales Order",
    endpoint: "/api/sales/sales-orders",
    listPath: "/sales/sales-orders",
    dateField: "orderDate",
    actions: [
      {
        label: "Confirm",
        when: ["draft"],
        run: async (doc, h) => {
          await h.post(`/api/sales/sales-orders/${doc.id}/status`, { status: "confirmed" });
          await h.refresh();
        },
      },
      {
        label: "Close",
        when: ["confirmed"],
        run: async (doc, h) => {
          await h.post(`/api/sales/sales-orders/${doc.id}/status`, { status: "closed" });
          await h.refresh();
        },
      },
      {
        label: "Void",
        when: ["draft", "confirmed"],
        danger: true,
        run: async (doc, h) => {
          if (!confirm(`Void ${doc.number}?`)) return;
          await h.post(`/api/sales/sales-orders/${doc.id}/status`, { status: "void" });
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
        label: "Record Payment",
        when: ["open", "partially_paid"],
        run: (_doc, h) => h.navigate("/purchases/payments/new"),
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
    actions: [],
  },
};

export function DocumentDetailPage({ kind, id }: { kind: string; id: string }) {
  const config = CONFIGS[kind];
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        addresses: Array<{ kind: string; line1?: string; city?: string; state?: string; pincode?: string }>;
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

  const docTitle =
    kind === "invoice" ? "TAX INVOICE" : config.titlePrefix.toUpperCase();
  const billingAddr = contact?.addresses?.find((a) => a.kind === "billing");
  const isSales = ["invoice", "estimate", "sales-order", "credit-note"].includes(kind);

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
            onClick={() => navigate("/sales/payments/new")}
            className="rounded-md bg-brand-500 px-3 py-1.5 font-medium text-white hover:bg-brand-600"
          >
            Record Payment
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto bg-gray-100 p-6 print:bg-white print:p-0">
        <div className="relative mx-auto max-w-3xl overflow-hidden border bg-white shadow-sm print:border-0 print:shadow-none">
          <div
            className={`absolute -left-10 top-5 w-36 -rotate-45 py-1 text-center text-[11px] font-semibold uppercase tracking-wider text-white print:hidden ${
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

          <div className="p-10">
            <div className="mb-8 flex items-start justify-between">
              <div className="text-[13px]">
                <div className="text-base font-bold">{org?.name || "Your Business"}</div>
                {org?.address && <div className="text-gray-600">{org.address}</div>}
                <div className="text-gray-600">
                  {[org?.city, org?.state, org?.pincode].filter(Boolean).join(", ")}
                </div>
                {org?.gstin && <div className="text-gray-600">GSTIN {org.gstin}</div>}
                {org?.phone && <div className="text-gray-600">{org.phone}</div>}
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold tracking-wide text-gray-800">{docTitle}</div>
                <div className="mt-1 text-[13px] text-gray-500"># {doc.number}</div>
                <div className="mt-4 text-[13px]">
                  <span className="text-gray-500">Balance Due</span>
                  <div className="text-lg font-bold tabular-nums">
                    {formatMoney(balance ?? doc.total)}
                  </div>
                </div>
              </div>
            </div>

            <div className="mb-8 flex items-end justify-between text-[13px]">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {isSales ? "Bill To" : "Vendor"}
                </div>
                <div className="font-semibold text-brand-700">{contact?.displayName ?? "—"}</div>
                {billingAddr?.line1 && <div className="text-gray-600">{billingAddr.line1}</div>}
                <div className="text-gray-600">
                  {[billingAddr?.city, billingAddr?.state, billingAddr?.pincode].filter(Boolean).join(", ")}
                </div>
                {contact?.gstin && <div className="text-gray-600">GSTIN {contact.gstin}</div>}
              </div>
              <table className="text-right text-[13px]">
                <tbody>
                  <tr>
                    <td className="pr-4 text-gray-500">{config.titlePrefix} Date :</td>
                    <td className="font-medium">{formatDate(doc[config.dateField] as string)}</td>
                  </tr>
                  {doc.dueDate ? (
                    <tr>
                      <td className="pr-4 text-gray-500">Due Date :</td>
                      <td className="font-medium">{formatDate(doc.dueDate as string)}</td>
                    </tr>
                  ) : null}
                  {doc.reference ? (
                    <tr>
                      <td className="pr-4 text-gray-500">Reference :</td>
                      <td className="font-medium">{doc.reference}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <table className="mb-6 w-full text-[13px]">
              <thead>
                <tr className="bg-gray-800 text-left text-xs uppercase tracking-wide text-white">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Item &amp; Description</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Rate</th>
                  <th className="px-3 py-2 text-right font-medium">Tax</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((l, i) => (
                  <tr key={l.id} className="border-b">
                    <td className="px-3 py-2.5 text-gray-500">{i + 1}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{l.name}</div>
                      {l.description && <div className="text-xs text-gray-500">{l.description}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {Number(l.quantity)} {l.unit ?? ""}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(l.rate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(l.taxAmount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="ml-auto w-72 text-[13px]">
              <div className="mb-1 flex justify-between">
                <span className="text-gray-600">Sub Total</span>
                <span className="tabular-nums">{formatMoney(doc.subTotal)}</span>
              </div>
              {Number(doc.discountTotal) > 0 && (
                <div className="mb-1 flex justify-between text-gray-600">
                  <span>Discount</span>
                  <span className="tabular-nums">− {formatMoney(doc.discountTotal)}</span>
                </div>
              )}
              {Number(doc.cgst) > 0 && (
                <div className="mb-1 flex justify-between text-gray-600">
                  <span>CGST</span>
                  <span className="tabular-nums">{formatMoney(doc.cgst)}</span>
                </div>
              )}
              {Number(doc.sgst) > 0 && (
                <div className="mb-1 flex justify-between text-gray-600">
                  <span>SGST</span>
                  <span className="tabular-nums">{formatMoney(doc.sgst)}</span>
                </div>
              )}
              {Number(doc.igst) > 0 && (
                <div className="mb-1 flex justify-between text-gray-600">
                  <span>IGST</span>
                  <span className="tabular-nums">{formatMoney(doc.igst)}</span>
                </div>
              )}
              {Number(doc.roundOff) !== 0 && (
                <div className="mb-1 flex justify-between text-gray-600">
                  <span>Round Off</span>
                  <span className="tabular-nums">{formatMoney(doc.roundOff)}</span>
                </div>
              )}
              <div className="mt-2 flex justify-between border-t-2 border-gray-800 pt-2 text-sm font-bold">
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(doc.total)}</span>
              </div>
              {balance !== undefined && (
                <div className="mt-1 flex justify-between rounded bg-gray-100 px-2 py-1.5 font-semibold">
                  <span>Balance Due</span>
                  <span className="tabular-nums">{formatMoney(balance)}</span>
                </div>
              )}
            </div>

            {!!doc.payments?.length && (
              <div className="mt-10 print:hidden">
                <h3 className="mb-2 text-sm font-semibold">Payments Received</h3>
                <table className="w-full text-[13px]">
                  <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="border-y px-3 py-2">Payment #</th>
                      <th className="border-y px-3 py-2">Date</th>
                      <th className="border-y px-3 py-2 text-right">Amount Applied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.payments.map((p, i) => (
                      <tr key={i} className="border-b">
                        <td className="px-3 py-2 font-medium text-brand-600">{p.paymentNumber}</td>
                        <td className="px-3 py-2">{formatDate(p.paymentDate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.amountApplied)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
