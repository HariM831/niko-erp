import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, formatMoney } from "../api";
import { StatusBadge } from "../components/list-page";
import { AttachmentsButton } from "../components/attachments";
import { CommentsButton } from "../components/comments";
import { shortDate } from "./documents";

function DetailShell({
  backPath,
  title,
  status,
  toolbar,
  children,
}: {
  backPath: string;
  title: string;
  status?: string;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [, navigate] = useLocation();
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-2.5 print:hidden">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(backPath)} className="text-gray-400 hover:text-gray-700">
            ←
          </button>
          <h1 className="text-base font-semibold">{title}</h1>
          {status && <StatusBadge status={status} />}
        </div>
        <div className="flex items-center gap-1">{toolbar}</div>
      </header>
      <div className="flex-1 overflow-y-auto bg-surface p-6 print:bg-white print:p-0">
        <div className="card mx-auto max-w-3xl p-8 print:border-0 print:shadow-none">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-0.5 text-[13px] font-medium">{children}</div>
    </div>
  );
}

// ============================ Payment detail ============================

interface PaymentDoc {
  id: string;
  number: string;
  paymentDate: string;
  amount: string;
  unappliedAmount: string;
  tdsAmount?: string;
  mode: string;
  reference?: string;
  notes?: string;
  contactName: string | null;
  customerId?: string;
  vendorId?: string;
  applications: Array<{
    invoiceId?: string;
    billId?: string;
    invoiceNumber?: string;
    billNumber?: string;
    invoiceDate?: string;
    billDate?: string;
    invoiceTotal?: string;
    billTotal?: string;
    amountApplied: string;
  }>;
}

export function PaymentDetailPage({ side, id }: { side: "customer" | "vendor"; id: string }) {
  const isCustomer = side === "customer";
  const endpoint = isCustomer ? "/api/sales/payments" : "/api/purchases/payments";
  const backPath = isCustomer ? "/sales/payments" : "/purchases/payments";
  const docBase = isCustomer ? "/sales/invoices" : "/purchases/bills";
  const contactBase = isCustomer ? "/sales/customers" : "/purchases/vendors";

  const { data: doc, isLoading } = useQuery({
    queryKey: ["payment", side, id],
    queryFn: () => api<PaymentDoc>(`${endpoint}/${id}`),
  });

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!doc) return <div className="p-8 text-sm text-red-600">Payment not found.</div>;

  const contactId = doc.customerId ?? doc.vendorId;
  const entityType = isCustomer ? "customer_payment" : "vendor_payment";

  return (
    <DetailShell
      backPath={backPath}
      title={doc.number}
      toolbar={
        <>
          <CommentsButton entityType={isCustomer ? "invoice" : "bill"} entityId={id} />
          <button onClick={() => window.print()} className="btn-ghost">
            PDF/Print
          </button>
        </>
      }
    >
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="text-xl font-bold">{isCustomer ? "Payment Received" : "Payment Made"}</div>
          <div className="text-[13px] text-gray-500"># {doc.number}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Amount
          </div>
          <div className="text-2xl font-bold tabular-nums text-green-600">
            {formatMoney(doc.amount)}
          </div>
        </div>
      </div>

      <div className="mb-7 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
        <Field label={isCustomer ? "Customer" : "Vendor"}>
          {contactId ? (
            <Link href={`${contactBase}/${contactId}`} className="text-brand-600 hover:underline">
              {doc.contactName ?? "—"}
            </Link>
          ) : (
            (doc.contactName ?? "—")
          )}
        </Field>
        <Field label="Payment Date">{shortDate(doc.paymentDate)}</Field>
        <Field label="Mode">
          <span className="capitalize">{doc.mode.replace(/_/g, " ")}</span>
        </Field>
        {Number(doc.tdsAmount ?? 0) > 0 && (
          <Field label="TDS Withheld">{formatMoney(doc.tdsAmount!)}</Field>
        )}
        {Number(doc.unappliedAmount) > 0 && (
          <Field label="Unused Amount">{formatMoney(doc.unappliedAmount)}</Field>
        )}
        {doc.reference && <Field label="Reference">{doc.reference}</Field>}
      </div>

      <h3 className="mb-2 text-sm font-semibold">
        Applied to {isCustomer ? "Invoices" : "Bills"}
      </h3>
      {!doc.applications.length ? (
        <p className="rounded-xl border border-dashed px-4 py-4 text-[13px] text-gray-400">
          Not applied to any document — the full amount is on account.
        </p>
      ) : (
        <table className="w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="border-b border-[#ebeaf2] px-3 py-2">Number</th>
              <th className="border-b border-[#ebeaf2] px-3 py-2">Date</th>
              <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Document Total</th>
              <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Amount Applied</th>
            </tr>
          </thead>
          <tbody>
            {doc.applications.map((a, i) => {
              const docId = a.invoiceId ?? a.billId;
              return (
                <tr key={i} className="border-b border-[#ebeaf2]">
                  <td className="px-3 py-2.5">
                    <Link href={`${docBase}/${docId}`} className="font-medium text-brand-600 hover:underline">
                      {a.invoiceNumber ?? a.billNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">{shortDate(a.invoiceDate ?? a.billDate)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatMoney(a.invoiceTotal ?? a.billTotal)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                    {formatMoney(a.amountApplied)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {doc.notes && (
        <p className="mt-5 rounded-lg bg-gray-50 px-3 py-2 text-[13px] text-gray-600">{doc.notes}</p>
      )}
      <span className="hidden">{entityType}</span>
    </DetailShell>
  );
}

// ============================ Expense detail ============================

interface ExpenseDoc {
  id: string;
  number: string;
  expenseDate: string;
  amount: string;
  taxAmount: string;
  reference?: string;
  notes?: string;
  expenseAccountName: string | null;
  paidThroughName: string | null;
  contactName: string | null;
  vendorId?: string | null;
}

export function ExpenseDetailPage({ id }: { id: string }) {
  const { data: doc, isLoading } = useQuery({
    queryKey: ["expense", id],
    queryFn: () => api<ExpenseDoc>(`/api/purchases/expenses/${id}`),
  });

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!doc) return <div className="p-8 text-sm text-red-600">Expense not found.</div>;

  return (
    <DetailShell
      backPath="/purchases/expenses"
      title={doc.number}
      toolbar={
        <>
          <CommentsButton entityType="expense" entityId={id} />
          <AttachmentsButton entityType="expense" entityId={id} />
          <button onClick={() => window.print()} className="btn-ghost">
            PDF/Print
          </button>
        </>
      }
    >
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="text-xl font-bold">Expense</div>
          <div className="text-[13px] text-gray-500"># {doc.number}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Amount</div>
          <div className="text-2xl font-bold tabular-nums">{formatMoney(doc.amount)}</div>
          {Number(doc.taxAmount) > 0 && (
            <div className="text-[12px] text-gray-500">+ {formatMoney(doc.taxAmount)} tax</div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
        <Field label="Date">{shortDate(doc.expenseDate)}</Field>
        <Field label="Expense Account">{doc.expenseAccountName ?? "—"}</Field>
        <Field label="Paid Through">{doc.paidThroughName ?? "—"}</Field>
        <Field label="Vendor">
          {doc.vendorId ? (
            <Link href={`/purchases/vendors/${doc.vendorId}`} className="text-brand-600 hover:underline">
              {doc.contactName ?? "—"}
            </Link>
          ) : (
            "—"
          )}
        </Field>
        {doc.reference && <Field label="Reference">{doc.reference}</Field>}
      </div>
      {doc.notes && (
        <p className="mt-5 rounded-lg bg-gray-50 px-3 py-2 text-[13px] text-gray-600">{doc.notes}</p>
      )}
    </DetailShell>
  );
}

// ============================ Journal detail ============================

interface JournalDoc {
  id: string;
  entryNumber: string;
  entryDate: string;
  status: string;
  narration: string;
  reference?: string;
  sourceType: string;
  lines: Array<{
    id: string;
    accountId: string;
    debit: string;
    credit: string;
    description?: string;
  }>;
}

export function JournalDetailPage({ id }: { id: string }) {
  const { data: doc, isLoading } = useQuery({
    queryKey: ["journal", id],
    queryFn: () => api<JournalDoc>(`/api/accounting/journals/${id}`),
  });
  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Array<{ id: string; code: string; name: string }>>("/api/accounting/accounts"),
  });
  const acctName = (aid: string) => {
    const a = accounts?.find((x) => x.id === aid);
    return a ? `${a.code} · ${a.name}` : aid.slice(0, 8);
  };

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!doc) return <div className="p-8 text-sm text-red-600">Journal entry not found.</div>;

  const totalDebit = doc.lines.reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = doc.lines.reduce((s, l) => s + Number(l.credit), 0);

  return (
    <DetailShell
      backPath="/accountant/journals"
      title={doc.entryNumber}
      status={doc.status}
      toolbar={
        <>
          <CommentsButton entityType="journal_entry" entityId={id} />
          <AttachmentsButton entityType="journal_entry" entityId={id} />
          <button onClick={() => window.print()} className="btn-ghost">
            PDF/Print
          </button>
        </>
      }
    >
      <div className="mb-6">
        <div className="text-xl font-bold">Journal Entry</div>
        <div className="text-[13px] text-gray-500"># {doc.entryNumber}</div>
      </div>
      <div className="mb-7 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
        <Field label="Date">{shortDate(doc.entryDate)}</Field>
        <Field label="Source">
          <span className="capitalize">{doc.sourceType.replace(/_/g, " ")}</span>
        </Field>
        {doc.reference && <Field label="Reference">{doc.reference}</Field>}
        <div className="col-span-2 sm:col-span-3">
          <Field label="Narration">{doc.narration}</Field>
        </div>
      </div>
      <table className="w-full text-[13px]">
        <thead className="table-head">
          <tr>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Account</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2">Description</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Debit</th>
            <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Credit</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l) => (
            <tr key={l.id} className="border-b border-[#ebeaf2]">
              <td className="px-3 py-2.5">
                <Link
                  href={`/accountant/accounts/${l.accountId}`}
                  className="font-medium text-brand-600 hover:underline"
                >
                  {acctName(l.accountId)}
                </Link>
              </td>
              <td className="px-3 py-2.5 text-gray-600">{l.description ?? ""}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {Number(l.debit) > 0 ? formatMoney(l.debit) : ""}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {Number(l.credit) > 0 ? formatMoney(l.credit) : ""}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <td colSpan={2} className="px-3 py-2.5 text-right">
              Total
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(totalDebit)}</td>
            <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </DetailShell>
  );
}

// ============================ Account ledger ============================

export function AccountLedgerPage({ id }: { id: string }) {
  const fyStart = () => {
    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${year}-04-01`;
  };
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Array<{ id: string; code: string; name: string; type: string }>>("/api/accounting/accounts"),
  });
  const account = accounts?.find((a) => a.id === id);

  const { data: rows } = useQuery({
    queryKey: ["ledger", id, from, to],
    queryFn: () =>
      api<Array<{ entryId: string; entryNumber: string; entryDate: string; narration: string; debit: string; credit: string; running: string }>>(
        `/api/accounting/ledger/${id}?from=${from}&to=${to}`,
      ),
  });

  return (
    <DetailShell
      backPath="/accountant/accounts"
      title={account ? `${account.code} · ${account.name}` : "Account Ledger"}
    >
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-sm font-semibold">Account Statement</h2>
        {account && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase text-gray-500">{account.type}</span>}
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input w-auto py-1" />
        <span className="text-gray-400">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input w-auto py-1" />
      </div>
      {!rows?.length ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[13px] text-gray-400">
          No postings in this period.
        </p>
      ) : (
        <table className="w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="border-b border-[#ebeaf2] px-3 py-2">Date</th>
              <th className="border-b border-[#ebeaf2] px-3 py-2">Entry</th>
              <th className="border-b border-[#ebeaf2] px-3 py-2">Narration</th>
              <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Debit</th>
              <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Credit</th>
              <th className="border-b border-[#ebeaf2] px-3 py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[#ebeaf2]">
                <td className="px-3 py-2.5">{shortDate(r.entryDate)}</td>
                <td className="px-3 py-2.5">
                  <Link href={`/accountant/journals/${r.entryId}`} className="font-medium text-brand-600 hover:underline">
                    {r.entryNumber}
                  </Link>
                </td>
                <td className="max-w-64 truncate px-3 py-2.5 text-gray-600">{r.narration}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {Number(r.debit) > 0 ? formatMoney(r.debit) : ""}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {Number(r.credit) > 0 ? formatMoney(r.credit) : ""}
                </td>
                <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatMoney(r.running)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailShell>
  );
}
