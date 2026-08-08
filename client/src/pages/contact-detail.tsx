import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";
import { StatusBadge } from "../components/list-page";
import { CommentsTimeline } from "../components/comments";
import { AttachmentsButton } from "../components/attachments";

interface Contact {
  id: string;
  type: "customer" | "vendor";
  displayName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  gstTreatment: string;
  gstin?: string;
  pan?: string;
  paymentTermsDays: number;
  openingBalance: string;
  persons: Array<{ id: string; firstName: string; lastName?: string; email?: string; phone?: string }>;
  addresses: Array<{ id: string; kind: string; line1?: string; line2?: string; city?: string; state?: string; pincode?: string }>;
}

interface DocRow {
  id: string;
  number: string;
  status: string;
  total?: string;
  amount?: string;
  balanceDue?: string;
  balance?: string;
  [k: string]: unknown;
}

type Tab = "overview" | "comments" | "transactions" | "statement";

export function ContactDetailPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("overview");
  const [newTxnOpen, setNewTxnOpen] = useState(false);

  const { data: contact, isLoading } = useQuery({
    queryKey: ["contact", id],
    queryFn: () => api<Contact>(`/api/contacts/${id}`),
  });
  const { data: summary } = useQuery({
    queryKey: ["contact-summary", id],
    queryFn: () => api<{ outstanding: string; unusedCredits: string }>(`/api/contacts/${id}/summary`),
  });

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!contact) return <div className="p-8 text-sm text-red-600">Contact not found.</div>;

  const isCustomer = contact.type === "customer";
  const listPath = isCustomer ? "/sales/customers" : "/purchases/vendors";
  const newTxnItems = isCustomer
    ? [
        { label: "Invoice", path: "/sales/invoices/new" },
        { label: "Estimate", path: "/sales/estimates/new" },
        { label: "Sales Order", path: "/sales/sales-orders/new" },
        { label: "Payment", path: "/sales/payments/new" },
        { label: "Credit Note", path: "/sales/credit-notes/new" },
      ]
    : [
        { label: "Bill", path: "/purchases/bills/new" },
        { label: "Purchase Order", path: "/purchases/orders/new" },
        { label: "Payment", path: "/purchases/payments/new" },
        { label: "Vendor Credit", path: "/purchases/vendor-credits/new" },
        { label: "Expense", path: "/purchases/expenses/new" },
      ];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-6 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(listPath)} className="text-gray-400 hover:text-gray-700">←</button>
            <h1 className="text-lg font-semibold">{contact.displayName}</h1>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {contact.type}
            </span>
          </div>
          <div className="relative flex items-center gap-2">
            <AttachmentsButton entityType="contact" entityId={contact.id} />
            <button
              onClick={() => setNewTxnOpen((o) => !o)}
              className="rounded-md bg-brand-500 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-brand-600"
            >
              New Transaction ▾
            </button>
            {newTxnOpen && (
              <div className="absolute right-0 top-10 z-20 w-44 rounded-lg border bg-white py-1 shadow-lg">
                {newTxnItems.map((it) => (
                  <button
                    key={it.path}
                    onClick={() => navigate(it.path)}
                    className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-brand-50"
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <nav className="flex gap-5 text-[13px]">
          {(["overview", "comments", "transactions", "statement"] as Tab[]).map((t) => (
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

      <div className="flex-1 overflow-y-auto">
        {tab === "overview" && <OverviewTab contact={contact} summary={summary} isCustomer={isCustomer} />}
        {tab === "comments" && (
          <div className="mx-auto flex h-full max-w-2xl flex-col py-4">
            <CommentsTimeline entityType="contact" entityId={contact.id} />
          </div>
        )}
        {tab === "transactions" && <TransactionsTab id={id} isCustomer={isCustomer} navigate={navigate} />}
        {tab === "statement" && <StatementTab id={id} />}
      </div>
    </div>
  );
}

function OverviewTab({
  contact,
  summary,
  isCustomer,
}: {
  contact: Contact;
  summary?: { outstanding: string; unusedCredits: string };
  isCustomer: boolean;
}) {
  const billing = contact.addresses.find((a) => a.kind === "billing");
  return (
    <div className="flex gap-0">
      <aside className="w-72 shrink-0 border-r bg-white p-5 text-[13px]">
        <div className="mb-4">
          <div className="text-sm font-semibold">{contact.displayName}</div>
          {contact.companyName && <div className="text-gray-500">{contact.companyName}</div>}
          {contact.email && <div className="mt-1 text-gray-600">{contact.email}</div>}
          {contact.phone && <div className="text-gray-600">📞 {contact.phone}</div>}
        </div>
        <div className="mb-4 border-t pt-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Address</div>
          {billing ? (
            <div className="text-gray-700">
              {billing.line1 && <div>{billing.line1}</div>}
              {billing.line2 && <div>{billing.line2}</div>}
              <div>
                {[billing.city, billing.state, billing.pincode].filter(Boolean).join(", ") || "—"}
              </div>
            </div>
          ) : (
            <div className="text-gray-400">No address recorded</div>
          )}
        </div>
        <div className="border-t pt-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Tax</div>
          <div className="capitalize text-gray-700">{contact.gstTreatment.replace(/_/g, " ")}</div>
          {contact.gstin && <div className="text-gray-700">GSTIN: {contact.gstin}</div>}
          {contact.pan && <div className="text-gray-700">PAN: {contact.pan}</div>}
        </div>
      </aside>

      <div className="flex-1 p-6">
        <div className="mb-5 text-[13px]">
          <div className="text-gray-500">Payment due period</div>
          <div className="font-medium">
            {contact.paymentTermsDays === 0 ? "Due on Receipt" : `Net ${contact.paymentTermsDays} days`}
          </div>
        </div>

        <h3 className="mb-2 text-sm font-semibold">{isCustomer ? "Receivables" : "Payables"}</h3>
        <table className="w-full max-w-lg text-[13px]">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="border-y px-3 py-2">Currency</th>
              <th className="border-y px-3 py-2 text-right">
                Outstanding {isCustomer ? "Receivables" : "Payables"}
              </th>
              <th className="border-y px-3 py-2 text-right">Unused Credits</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="px-3 py-2.5">INR — Indian Rupee</td>
              <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                {formatMoney(summary?.outstanding ?? 0)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(summary?.unusedCredits ?? 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TXN_SECTIONS: Record<
  string,
  Array<{ key: string; label: string; dateKey: string; basePath: string; balanceKey?: string; amountKey?: string }>
> = {
  customer: [
    { key: "invoices", label: "Invoices", dateKey: "invoiceDate", basePath: "/sales/invoices", balanceKey: "balanceDue" },
    { key: "payments", label: "Payments Received", dateKey: "paymentDate", basePath: "/sales/payments", amountKey: "amount" },
    { key: "creditNotes", label: "Credit Notes", dateKey: "creditNoteDate", basePath: "/sales/credit-notes", balanceKey: "balance" },
    { key: "salesOrders", label: "Sales Orders", dateKey: "orderDate", basePath: "/sales/sales-orders" },
    { key: "estimates", label: "Estimates", dateKey: "estimateDate", basePath: "/sales/estimates" },
  ],
  vendor: [
    { key: "bills", label: "Bills", dateKey: "billDate", basePath: "/purchases/bills", balanceKey: "balanceDue" },
    { key: "payments", label: "Payments Made", dateKey: "paymentDate", basePath: "/purchases/payments", amountKey: "amount" },
    { key: "vendorCredits", label: "Vendor Credits", dateKey: "creditDate", basePath: "/purchases/vendor-credits", balanceKey: "balance" },
  ],
};

function TransactionsTab({
  id,
  isCustomer,
  navigate,
}: {
  id: string;
  isCustomer: boolean;
  navigate: (p: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ["contact-txns", id],
    queryFn: () => api<Record<string, DocRow[]>>(`/api/contacts/${id}/transactions`),
  });
  const sections = TXN_SECTIONS[isCustomer ? "customer" : "vendor"]!;

  return (
    <div className="p-6">
      {sections.map((s) => {
        const rows = data?.[s.key] ?? [];
        return (
          <div key={s.key} className="mb-7">
            <h3 className="mb-2 text-sm font-semibold">{s.label}</h3>
            {!rows.length ? (
              <p className="rounded border border-dashed px-4 py-3 text-[13px] text-gray-400">
                No {s.label.toLowerCase()} yet.
              </p>
            ) : (
              <table className="w-full max-w-4xl text-[13px]">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="border-y px-3 py-2">Date</th>
                    <th className="border-y px-3 py-2">Number</th>
                    <th className="border-y px-3 py-2">Status</th>
                    <th className="border-y px-3 py-2 text-right">Amount</th>
                    {s.balanceKey && <th className="border-y px-3 py-2 text-right">Balance</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`${s.basePath}/${r.id}`)}
                      className="cursor-pointer border-b hover:bg-brand-50/40"
                    >
                      <td className="px-3 py-2">{formatDate(r[s.dateKey] as string)}</td>
                      <td className="px-3 py-2 font-medium text-brand-600">{r.number}</td>
                      <td className="px-3 py-2">
                        {r.status ? <StatusBadge status={r.status} /> : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMoney((r[s.amountKey ?? "total"] as string) ?? 0)}
                      </td>
                      {s.balanceKey && (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMoney((r[s.balanceKey] as string) ?? 0)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

const STATEMENT_PATHS: Record<string, string> = {
  Invoice: "/sales/invoices",
  "Payment Received": "/sales/payments",
  "Credit Note": "/sales/credit-notes",
  Bill: "/purchases/bills",
  "Payment Made": "/purchases/payments",
  "Vendor Credit": "/purchases/vendor-credits",
};

function StatementTab({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const fyStart = () => {
    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${year}-04-01`;
  };
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));

  const { data } = useQuery({
    queryKey: ["contact-statement", id, from, to],
    queryFn: () =>
      api<{
        openingBalance: string;
        closingBalance: string;
        rows: Array<{ id: string; date: string; type: string; number: string; debit: number; credit: number; balance: string }>;
      }>(`/api/contacts/${id}/statement?from=${from}&to=${to}`),
  });

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <h3 className="text-sm font-semibold">Statement of Account</h3>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border px-2 py-1 text-[13px]" />
        <span className="text-gray-400">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border px-2 py-1 text-[13px]" />
        <button onClick={() => window.print()} className="ml-auto rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-gray-50 print:hidden">
          Print / PDF
        </button>
      </div>
      <table className="w-full max-w-4xl text-[13px]">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="border-y px-3 py-2">Date</th>
            <th className="border-y px-3 py-2">Transaction</th>
            <th className="border-y px-3 py-2">Number</th>
            <th className="border-y px-3 py-2 text-right">Debit</th>
            <th className="border-y px-3 py-2 text-right">Credit</th>
            <th className="border-y px-3 py-2 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b bg-gray-50/60">
            <td className="px-3 py-2 text-gray-500">{formatDate(from)}</td>
            <td colSpan={4} className="px-3 py-2 font-medium">Opening Balance</td>
            <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(data?.openingBalance ?? 0)}</td>
          </tr>
          {data?.rows.map((r, i) => (
            <tr key={i} className="border-b">
              <td className="px-3 py-2">{formatDate(r.date)}</td>
              <td className="px-3 py-2">{r.type}</td>
              <td className="px-3 py-2">
                {STATEMENT_PATHS[r.type] && !r.type.startsWith("Payment") ? (
                  <button
                    onClick={() => navigate(`${STATEMENT_PATHS[r.type]}/${r.id}`)}
                    className="font-medium text-brand-600 hover:underline"
                  >
                    {r.number}
                  </button>
                ) : (
                  <span className="font-medium">{r.number}</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.debit ? formatMoney(r.debit) : ""}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.credit ? formatMoney(r.credit) : ""}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.balance)}</td>
            </tr>
          ))}
          <tr className="bg-gray-50/60 font-semibold">
            <td className="px-3 py-2">{formatDate(to)}</td>
            <td colSpan={4} className="px-3 py-2">Closing Balance</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(data?.closingBalance ?? 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
