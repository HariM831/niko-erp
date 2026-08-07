import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";
import { StatusBadge } from "../components/list-page";

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(config.listPath)} className="text-gray-400 hover:text-gray-700">
            ←
          </button>
          <h1 className="text-lg font-semibold">
            {config.titlePrefix} {doc.number}
          </h1>
          <StatusBadge status={doc.status} />
        </div>
        <div className="flex items-center gap-2">
          {visibleActions.map((a) => (
            <button
              key={a.label}
              disabled={busy}
              onClick={() => void runAction(a)}
              className={`rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-50 ${
                a.danger
                  ? "border border-red-200 text-red-600 hover:bg-red-50"
                  : "bg-brand-500 text-white hover:bg-brand-600"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="border-b bg-red-50 px-6 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl rounded-lg border bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-start justify-between">
            <div>
              <div className="text-xl font-semibold">{config.titlePrefix}</div>
              <div className="text-sm text-gray-500"># {doc.number}</div>
            </div>
            <div className="text-right text-sm">
              <div className="text-gray-500">Date</div>
              <div className="font-medium">{formatDate(doc[config.dateField] as string)}</div>
              {doc.dueDate ? (
                <>
                  <div className="mt-1 text-gray-500">Due Date</div>
                  <div className="font-medium">{formatDate(doc.dueDate as string)}</div>
                </>
              ) : null}
            </div>
          </div>

          <table className="mb-4 w-full text-[13px]">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="border-y px-3 py-2">#</th>
                <th className="border-y px-3 py-2">Item & Description</th>
                <th className="border-y px-3 py-2 text-right">Qty</th>
                <th className="border-y px-3 py-2 text-right">Rate</th>
                <th className="border-y px-3 py-2 text-right">Disc %</th>
                <th className="border-y px-3 py-2 text-right">Tax</th>
                <th className="border-y px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={l.id} className="border-b">
                  <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{l.name}</div>
                    {l.description && <div className="text-xs text-gray-500">{l.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {Number(l.quantity)} {l.unit ?? ""}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.rate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{Number(l.discountPercent)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.taxAmount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="ml-auto w-72 text-[13px]">
            <div className="mb-1 flex justify-between">
              <span>Sub Total</span>
              <span className="tabular-nums">{formatMoney(doc.subTotal)}</span>
            </div>
            {Number(doc.discountTotal) > 0 && (
              <div className="mb-1 flex justify-between text-gray-600">
                <span>Discount</span>
                <span className="tabular-nums">− {formatMoney(doc.discountTotal)}</span>
              </div>
            )}
            {Number(doc.cgst) > 0 && (
              <div className="mb-1 flex justify-between">
                <span>CGST</span>
                <span className="tabular-nums">{formatMoney(doc.cgst)}</span>
              </div>
            )}
            {Number(doc.sgst) > 0 && (
              <div className="mb-1 flex justify-between">
                <span>SGST</span>
                <span className="tabular-nums">{formatMoney(doc.sgst)}</span>
              </div>
            )}
            {Number(doc.igst) > 0 && (
              <div className="mb-1 flex justify-between">
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
            <div className="flex justify-between border-t pt-2 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(doc.total)}</span>
            </div>
            {balance !== undefined && (
              <div className="mt-1 flex justify-between font-medium text-amber-700">
                <span>Balance</span>
                <span className="tabular-nums">{formatMoney(balance)}</span>
              </div>
            )}
          </div>

          {!!doc.payments?.length && (
            <div className="mt-8">
              <h3 className="mb-2 text-sm font-semibold">Payments</h3>
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
  );
}
