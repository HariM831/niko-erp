import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";
import { CustomFieldsDisplay } from "../components/custom-fields";
import { StatusBadge } from "../components/list-page";
import { CommentsTimeline } from "../components/comments";
import { AttachmentsButton } from "../components/attachments";

interface ContactRailRow {
  id: string;
  displayName: string;
  outstanding: string;
}

/** Books-style split view: compact "name + balance" rail on the left, full record on the right. */
function ContactSplitView({
  type,
  activeId,
  children,
}: {
  type: "customer" | "vendor" | "both";
  activeId: string;
  children: React.ReactNode;
}) {
  const [, navigate] = useLocation();
  const listPath = type === "customer" ? "/sales/customers" : "/purchases/vendors";
  const newPath = `${listPath}/new`;
  const { data: rows } = useQuery({
    queryKey: ["contacts", type, "rail"],
    queryFn: () => api<ContactRailRow[]>(`/api/contacts?type=${type}`),
  });

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-white lg:flex print:hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <button
            onClick={() => navigate(listPath)}
            className="flex items-center gap-1 text-[15px] font-semibold text-gray-800 hover:text-brand-700"
          >
            All {type === "customer" ? "Customers" : "Vendors"} <span className="text-[10px] text-brand-500">▼</span>
          </button>
          <button
            onClick={() => navigate(newPath)}
            className="rounded-md bg-brand-500 px-2.5 py-1 text-[13px] font-medium text-white hover:bg-brand-600"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {rows?.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`${listPath}/${r.id}`)}
              className={`block w-full border-b border-gray-100 px-4 py-2.5 text-left ${
                r.id === activeId ? "border-l-2 border-l-brand-500 bg-brand-50" : "hover:bg-gray-50"
              }`}
            >
              <div className="truncate text-[13px] font-medium text-gray-800">{r.displayName}</div>
              <div className="text-xs tabular-nums text-gray-500">{formatMoney(r.outstanding)}</div>
            </button>
          ))}
          {!rows?.length && <p className="p-4 text-[13px] text-gray-400">No records.</p>}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

interface Contact {
  id: string;
  type: "customer" | "vendor" | "both";
  displayName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  gstTreatment: string;
  gstin?: string;
  pan?: string;
  placeOfSupplyState?: string;
  paymentTermsDays: number;
  openingBalance: string;
  isActive: boolean;
  persons: Array<{ id: string; firstName: string; lastName?: string; email?: string; phone?: string; isPrimary?: boolean }>;
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
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [newTxnOpen, setNewTxnOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const { data: contact, isLoading } = useQuery({
    queryKey: ["contact", id],
    queryFn: () => api<Contact>(`/api/contacts/${id}`),
  });
  const { data: summary } = useQuery({
    queryKey: ["contact-summary", id],
    queryFn: () =>
      api<{
        outstanding: string;
        unusedCredits: string;
        receivable?: string;
        receivableCredits?: string;
        payable?: string;
        payableCredits?: string;
        showBoth?: boolean;
      }>(`/api/contacts/${id}/summary`),
  });

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!contact) return <div className="p-8 text-sm text-red-600">Contact not found.</div>;

  const isCustomer = contact.type === "customer";
  const listPath = isCustomer ? "/sales/customers" : "/purchases/vendors";

  const toggleActive = async () => {
    setMoreOpen(false);
    if (contact.isActive) {
      await api(`/api/contacts/${contact.id}`, { method: "DELETE" });
    } else {
      await api(`/api/contacts/${contact.id}`, { method: "PATCH", body: { isActive: true } });
    }
    await qc.invalidateQueries();
  };
  const sales = [
    { label: "Invoice", path: "/sales/invoices/new" },
    { label: "Payment", path: "/sales/payments/new" },
    { label: "Credit Note", path: "/sales/credit-notes/new" },
  ];
  const newTxnItems = contact.type === "both"
    ? [
        ...sales,
        { label: "Bill", path: "/purchases/bills/new" },
        { label: "Payment Made", path: "/purchases/payments/new" },
        { label: "Vendor Credit", path: "/purchases/vendor-credits/new" },
      ]
    : isCustomer
    ? [
        { label: "Invoice", path: "/sales/invoices/new" },
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
    <ContactSplitView type={contact.type} activeId={contact.id}>
    <div className="flex min-h-full flex-col">
      <header className="border-b bg-white px-6 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(listPath)} className="text-gray-400 hover:text-gray-700">←</button>
            <h1 className="text-lg font-semibold">{contact.displayName}</h1>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {contact.type}
            </span>
            {!contact.isActive && (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-red-500">
                Inactive
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(`${listPath}/${contact.id}/edit`)}
              className="btn-secondary"
            >
              Edit
            </button>
            <AttachmentsButton entityType="contact" entityId={contact.id} />
            <div className="relative">
              <button
                onClick={() => setNewTxnOpen((o) => !o)}
                className="btn-primary"
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
            <div className="relative">
              <button onClick={() => setMoreOpen((o) => !o)} className="btn-secondary">
                More ▾
              </button>
              {moreOpen && (
                <div className="absolute right-0 top-10 z-20 w-44 rounded-lg border bg-white py-1 shadow-lg">
                  <button
                    onClick={() => void toggleActive()}
                    className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-brand-50"
                  >
                    {contact.isActive ? "Mark as Inactive" : "Mark as Active"}
                  </button>
                </div>
              )}
            </div>
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

      <div className="flex-1">
        {tab === "overview" && <OverviewTab contact={contact} summary={summary} isCustomer={isCustomer} navigate={navigate} />}
        {tab === "comments" && (
          <div className="mx-auto flex max-w-2xl flex-col py-4">
            <CommentsTimeline entityType="contact" entityId={contact.id} />
          </div>
        )}
        {tab === "transactions" && <TransactionsTab id={id} kind={contact.type} navigate={navigate} />}
        {tab === "statement" && <StatementTab id={id} />}
      </div>
    </div>
    </ContactSplitView>
  );
}

export function OverviewTab({
  contact,
  summary,
  isCustomer,
  navigate,
}: {
  contact: Contact;
  summary?: {
    outstanding: string;
    unusedCredits: string;
    receivable?: string;
    receivableCredits?: string;
    payable?: string;
    payableCredits?: string;
    showBoth?: boolean;
  };
  isCustomer: boolean;
  navigate: (p: string) => void;
}) {
  const billing = contact.addresses.find((a) => a.kind === "billing");
  const shipping = contact.addresses.find((a) => a.kind === "shipping");
  const renderAddress = (a?: Contact["addresses"][number]) =>
    a ? (
      <div className="text-gray-700">
        {a.line1 && <div>{a.line1}</div>}
        {a.line2 && <div>{a.line2}</div>}
        <div>{[a.city, a.state, a.pincode].filter(Boolean).join(", ") || "—"}</div>
      </div>
    ) : (
      <div className="text-gray-400">No address recorded</div>
    );

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
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Billing Address</div>
          {renderAddress(billing)}
        </div>
        <div className="mb-4 border-t pt-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Shipping Address</div>
          {renderAddress(shipping)}
        </div>

        <div className="mb-4 border-t pt-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Other Details</div>
          <dl className="space-y-1.5 text-gray-700">
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">GST Treatment</dt>
              <dd className="text-right capitalize">{contact.gstTreatment.replace(/_/g, " ")}</dd>
            </div>
            {contact.gstin && (
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">GSTIN</dt>
                <dd className="text-right">{contact.gstin}</dd>
              </div>
            )}
            {contact.pan && (
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">PAN</dt>
                <dd className="text-right">{contact.pan}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Place of Supply</dt>
              <dd className="text-right">{contact.placeOfSupplyState || "—"}</dd>
            </div>
          </dl>
        </div>

        {contact.persons.length > 0 && (
          <div className="border-t pt-4">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Contact Persons</div>
            <ul className="space-y-2">
              {contact.persons.map((p) => (
                <li key={p.id}>
                  <div className="text-gray-800">
                    {p.firstName} {p.lastName ?? ""}
                    {p.isPrimary && <span className="ml-1.5 rounded bg-gray-100 px-1 py-0.5 text-[10px] font-medium text-gray-500">PRIMARY</span>}
                  </div>
                  {p.email && <div className="text-xs text-gray-500">{p.email}</div>}
                  {p.phone && <div className="text-xs text-gray-500">{p.phone}</div>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      <div className="flex-1 p-6">
        <div className="mb-5 text-[13px]">
          <div className="text-gray-500">Payment due period</div>
          <div className="font-medium">
            {contact.paymentTermsDays === 0 ? "Due on Receipt" : `Net ${contact.paymentTermsDays} days`}
          </div>
        </div>

        {/* A contact that trades both ways gets both tables. One heading would
            have to pick a side, and the side it picked would be wrong half the
            time — a shed owner owes Amino for feed AND is owed for eggs. */}
        {(summary?.showBoth
          ? ([
              ["Receivables", summary.receivable, summary.receivableCredits],
              ["Payables", summary.payable, summary.payableCredits],
            ] as const)
          : ([
              [
                isCustomer ? "Receivables" : "Payables",
                summary?.outstanding ?? 0,
                summary?.unusedCredits ?? 0,
              ],
            ] as const)
        ).map(([heading, outstanding, credits]) => (
          <div key={heading} className="mb-5">
            <h3 className="mb-2 text-sm font-semibold">{heading}</h3>
            <table className="w-full max-w-lg text-[13px]">
              <thead className="table-head">
                <tr>
                  <th className="border-b border-[#ebeaf2] px-3 py-2">Currency</th>
                  <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">
                    Outstanding {heading}
                  </th>
                  <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Unused Credits</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[#ebeaf2]">
                  <td className="px-3 py-2.5">INR — Indian Rupee</td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                    {formatMoney(outstanding)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(credits)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
        <div className="mt-2">
          <button
            onClick={() => navigate(`${isCustomer ? "/sales/customers" : "/purchases/vendors"}/${contact.id}/edit`)}
            className="text-[13px] font-medium text-brand-600 hover:underline"
          >
            Opening Balance: {formatMoney(contact.openingBalance)} · Edit
          </button>
        </div>

        <CustomFieldsDisplay
          values={
            (contact as unknown as {
              customFieldValues?: Array<{ fieldId: string; label: string; display: string }>;
            }).customFieldValues
          }
        />

        <IncomeChart contactId={contact.id} label={isCustomer ? "Income" : "Expense"} />
      </div>
    </div>
  );
}

function compactMoney(v: number) {
  const abs = Math.abs(v);
  if (abs >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
  if (abs >= 100000) return `${(v / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${(v / 1000).toFixed(0)}K`;
  return v.toFixed(0);
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The month-by-month bar chart.
 *
 * A contact that both buys and sells gets TWO bars a month rather than one —
 * what they were invoiced beside what they billed — because a single series
 * would have to pick a side and would then describe half the relationship. An
 * owner of a shed is exactly that case: Amino sells them feed and pullets, and
 * buys their eggs back.
 *
 * Paired rather than stacked. Stacking would add a receivable to a payable and
 * draw a total that means nothing.
 */
export function IncomeChart({ contactId, label }: { contactId: string; label: string }) {
  const [basis, setBasis] = useState<"accrual" | "cash">("accrual");
  const [months, setMonths] = useState(6);
  const { data } = useQuery({
    queryKey: ["contact-income-chart", contactId, basis, months],
    queryFn: () =>
      api<{
        periods: Array<{ month: string; total: number; debit: number; credit: number }>;
        total: number;
        debitTotal: number;
        creditTotal: number;
        showBoth: boolean;
        label: string;
      }>(`/api/contacts/${contactId}/income-chart?basis=${basis}&months=${months}`),
  });

  const width = 480;
  const height = 160;
  const padL = 44;
  const padB = 18;
  const periods = data?.periods ?? [];
  const both = data?.showBoth ?? false;
  const heading = data?.label ?? label;

  const max = Math.max(
    ...periods.map((p) => (both ? Math.max(p.debit, p.credit) : p.total)),
    1,
  );
  const slot = periods.length ? (width - padL - 10) / periods.length : 0;

  const DEBIT = "#4f8ef7";
  const CREDIT = "#65c366";

  return (
    <div className="mt-8 max-w-2xl">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{heading}</h3>
        <div className="flex items-center gap-2 text-[13px]">
          <select value={basis} onChange={(e) => setBasis(e.target.value as "accrual" | "cash")} className="input w-auto py-1">
            <option value="accrual">Accrual</option>
            <option value="cash">Cash</option>
          </select>
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))} className="input w-auto py-1">
            <option value={6}>Last 6 Months</option>
            <option value={12}>Last 12 Months</option>
          </select>
        </div>
      </div>
      <p className="mb-2 text-xs text-gray-400">This chart is displayed in the organization's base currency.</p>

      {both && (
        <div className="mb-1 flex items-center gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: DEBIT }} />
            Invoiced to them (debit)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CREDIT }} />
            Billed by them (credit)
          </span>
        </div>
      )}

      <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={width} y1={height - padB - f * (height - padB - 10)} y2={height - padB - f * (height - padB - 10)} stroke="#ebeaf2" strokeWidth={1} />
            <text x={0} y={height - padB - f * (height - padB - 10) + 3} fontSize={10} fill="#9ca3af">
              {compactMoney(max * f)}
            </text>
          </g>
        ))}
        {periods.map((p, i) => {
          const plot = height - padB - 10;
          const [y = "", m = "1"] = p.month.split("-");
          const label = `${MONTHS_SHORT[Number(m) - 1]}${y.slice(2)}`;
          const x0 = padL + i * slot;

          if (!both) {
            const h = (p.total / max) * plot;
            return (
              <g key={p.month}>
                <rect x={x0 + slot * 0.2} y={height - padB - h} width={slot * 0.6} height={h} fill={CREDIT} rx={2} />
                <text x={x0 + slot / 2} y={height - 4} fontSize={9} fill="#9ca3af" textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          }

          // Two bars sharing the month's slot, with a hair of air between them.
          const barW = slot * 0.32;
          const dh = (p.debit / max) * plot;
          const ch = (p.credit / max) * plot;
          return (
            <g key={p.month}>
              <rect x={x0 + slot * 0.13} y={height - padB - dh} width={barW} height={dh} fill={DEBIT} rx={2}>
                <title>{`${label} invoiced ${formatMoney(p.debit)}`}</title>
              </rect>
              <rect x={x0 + slot * 0.13 + barW + slot * 0.04} y={height - padB - ch} width={barW} height={ch} fill={CREDIT} rx={2}>
                <title>{`${label} billed ${formatMoney(p.credit)}`}</title>
              </rect>
              <text x={x0 + slot / 2} y={height - 4} fontSize={9} fill="#9ca3af" textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
      </svg>

      {both ? (
        <p className="mt-1 text-[13px] text-gray-700">
          Last {months} months — invoiced{" "}
          <b>{formatMoney(data?.debitTotal ?? 0)}</b>, billed{" "}
          <b>{formatMoney(data?.creditTotal ?? 0)}</b>
        </p>
      ) : (
        <p className="mt-1 text-[13px] font-medium text-gray-700">
          Total {heading} ( Last {months} Months ) - {formatMoney(data?.total ?? 0)}
        </p>
      )}
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
  ],
  vendor: [
    { key: "bills", label: "Bills", dateKey: "billDate", basePath: "/purchases/bills", balanceKey: "balanceDue" },
    { key: "payments", label: "Payments Made", dateKey: "paymentDate", basePath: "/purchases/payments", amountKey: "amount" },
    { key: "vendorCredits", label: "Vendor Credits", dateKey: "creditDate", basePath: "/purchases/vendor-credits", balanceKey: "balance" },
  ],
  /**
   * A contact that trades both ways — a shed owner buys feed and sells eggs —
   * gets every section. The two payment lists are keyed apart, because
   * "payments" would otherwise mean whichever direction was written last.
   */
  both: [
    { key: "invoices", label: "Invoices", dateKey: "invoiceDate", basePath: "/sales/invoices", balanceKey: "balanceDue" },
    { key: "customerPayments", label: "Payments Received", dateKey: "paymentDate", basePath: "/sales/payments", amountKey: "amount" },
    { key: "creditNotes", label: "Credit Notes", dateKey: "creditNoteDate", basePath: "/sales/credit-notes", balanceKey: "balance" },
    { key: "bills", label: "Bills", dateKey: "billDate", basePath: "/purchases/bills", balanceKey: "balanceDue" },
    { key: "vendorPayments", label: "Payments Made", dateKey: "paymentDate", basePath: "/purchases/payments", amountKey: "amount" },
    { key: "vendorCredits", label: "Vendor Credits", dateKey: "creditDate", basePath: "/purchases/vendor-credits", balanceKey: "balance" },
  ],
};

export function TransactionsTab({
  id,
  kind,
  navigate,
}: {
  id: string;
  /** "customer" | "vendor" | "both" — which sections this contact has. */
  kind: string;
  navigate: (p: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ["contact-txns", id],
    queryFn: () => api<Record<string, DocRow[]>>(`/api/contacts/${id}/transactions`),
  });
  const sections = TXN_SECTIONS[kind] ?? TXN_SECTIONS.vendor!;

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
                <thead className="table-head">
                  <tr>
                    <th className="border-b border-[#ebeaf2] px-3 py-2">Date</th>
                    <th className="border-b border-[#ebeaf2] px-3 py-2">Number</th>
                    <th className="border-b border-[#ebeaf2] px-3 py-2">Status</th>
                    <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Amount</th>
                    {s.balanceKey && <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Balance</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`${s.basePath}/${r.id}`)}
                      className="cursor-pointer border-b border-[#ebeaf2] hover:bg-gray-50"
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

export function StatementTab({ id }: { id: string }) {
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
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input w-auto py-1" />
        <span className="text-gray-400">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input w-auto py-1" />
        <button onClick={() => window.print()} className="btn-secondary ml-auto print:hidden">
          Print / PDF
        </button>
      </div>
      <table className="w-full max-w-4xl text-[13px]">
        <thead className="table-head">
          <tr>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Date</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Transaction</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Number</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Debit</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Credit</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-[#ebeaf2] bg-gray-50/60">
            <td className="px-3 py-2 text-gray-500">{formatDate(from)}</td>
            <td colSpan={4} className="px-3 py-2 font-medium">Opening Balance</td>
            <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(data?.openingBalance ?? 0)}</td>
          </tr>
          {data?.rows.map((r, i) => (
            <tr key={i} className="border-b border-[#ebeaf2]">
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
