import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, formatMoney } from "../api";
import { CommentsTimeline } from "../components/comments";
import { AttachmentsButton } from "../components/attachments";
import { OverviewTab, StatementTab, TransactionsTab } from "./contact-detail";

/**
 * A shed owner's account.
 *
 * The same page a customer or a vendor gets, because an owner is both: Amino
 * sells them feed and pullets and buys their eggs back. It reuses the contact
 * page's own tabs rather than growing a second version that would drift — the
 * overview, the transactions and the statement here are literally the
 * components that render on a contact.
 *
 * What it adds is a picker, since there are only ever a handful of owners and
 * moving between them is the job, and one action: closing a month, which turns
 * its feed, pullets and eggs into documents that then read in the Statement
 * like any other transaction on the account.
 */

interface Owner {
  id: string;
  name: string;
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
  persons: Array<{
    id: string;
    firstName: string;
    lastName?: string;
    email?: string;
    phone?: string;
    isPrimary?: boolean;
  }>;
  addresses: Array<{
    id: string;
    kind: string;
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    pincode?: string;
  }>;
}

interface DraftLine {
  kind: "feed" | "birds" | "eggs";
  date: string;
  description: string;
  qty: number;
  unit: string;
  rate: number | null;
  amount: number | null;
  problem?: string;
}

interface Draft {
  owner: { id: string; name: string };
  period: string;
  from: string;
  to: string;
  feedLines: DraftLine[];
  birdLines: DraftLine[];
  eggLines: DraftLine[];
  feedTotal: number;
  birdTotal: number;
  eggTotal: number;
  billed: {
    feedInvoiceId: string | null;
    birdInvoiceId: string | null;
    billId: string | null;
    at: string;
  } | null;
  problems: string[];
}

/**
 * No "farm billing" tab.
 *
 * The month's feed, pullets and eggs are debits and credits on this owner's
 * account like anything else, so they belong in the Statement with the payments
 * against them — one ledger, one running balance. A separate tab showing the
 * same trade a second time was two versions of the truth and no balance at all.
 *
 * Raising the month is an ACTION rather than a page, so it sits in the header.
 */
type Tab = "overview" | "comments" | "transactions" | "statement";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "comments", label: "Comments" },
  { key: "transactions", label: "Transactions" },
  { key: "statement", label: "Statement" },
];

const monthLabel = (p: string) =>
  new Date(`${p}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

/** Last month, since that is the one that gets billed. */
function lastMonth() {
  const d = new Date();
  d.setDate(0);
  return d.toISOString().slice(0, 7);
}

export function OwnerBillingPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const [tab, setTab] = useState<Tab>("overview");

  const { data: ownerData } = useQuery({
    queryKey: ["farm-owners"],
    queryFn: () => api<{ owners: Owner[] }>("/api/owner-billing/owners"),
  });
  const owners = ownerData?.owners ?? [];

  // The chosen owner lives in the URL, so a link to one owner's account opens
  // on that owner rather than on whoever happens to sort first.
  const chosen = new URLSearchParams(search).get("owner");
  const ownerId = chosen ?? owners[0]?.id ?? "";
  useEffect(() => {
    if (!chosen && owners.length) {
      navigate(`/farms/owner-billing?owner=${owners[0]!.id}`, { replace: true });
    }
  }, [chosen, owners, navigate]);

  const { data: contact, isLoading } = useQuery({
    queryKey: ["contact", ownerId],
    queryFn: () => api<Contact>(`/api/contacts/${ownerId}`),
    enabled: !!ownerId,
  });
  const { data: summary } = useQuery({
    queryKey: ["contact-summary", ownerId],
    queryFn: () =>
      api<{
        outstanding: string;
        unusedCredits: string;
        receivable?: string;
        receivableCredits?: string;
        payable?: string;
        payableCredits?: string;
        showBoth?: boolean;
      }>(`/api/contacts/${ownerId}/summary`),
    enabled: !!ownerId,
  });

  if (ownerData && !owners.length) {
    return (
      <div className="p-8">
        <div className="table-surface p-6 text-center">
          <p className="text-[14px] font-medium text-gray-900">No shed has an owner yet.</p>
          <p className="mt-1 text-[13px] text-gray-500">
            Set an owner on a house under Farms → Houses and its account will appear here.
          </p>
        </div>
      </div>
    );
  }
  if (isLoading || !contact) return <div className="p-8 text-sm text-gray-500">Loading…</div>;

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b bg-white px-6 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* The picker stands where the contact page puts the name. There
                are a handful of owners and moving between them IS the job. */}
            <select
              value={ownerId}
              onChange={(e) => navigate(`/farms/owner-billing?owner=${e.target.value}`)}
              className="rounded-md border border-gray-200 bg-white px-2 py-1 text-lg font-semibold text-gray-900"
            >
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {contact.type}
            </span>
            <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-brand-600">
              Shed owner
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(`/purchases/vendors/${contact.id}/edit`)}
              className="btn-secondary"
            >
              Edit
            </button>
            <AttachmentsButton entityType="contact" entityId={contact.id} />
            <RaiseMonth ownerId={contact.id} onDone={() => setTab("statement")} />
          </div>
        </div>
        <nav className="flex gap-5 text-[13px]">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`border-b-2 pb-2 ${
                tab === t.key
                  ? "border-brand-500 font-medium text-brand-700"
                  : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1">
        {tab === "overview" && (
          <OverviewTab
            contact={contact}
            summary={summary}
            isCustomer={contact.type === "customer"}
            navigate={navigate}
          />
        )}
        {tab === "comments" && (
          <div className="mx-auto flex max-w-2xl flex-col py-4">
            <CommentsTimeline entityType="contact" entityId={contact.id} />
          </div>
        )}
        {tab === "transactions" && (
          <TransactionsTab id={contact.id} kind={contact.type} navigate={navigate} />
        )}
        {tab === "statement" && <StatementTab id={contact.id} />}
      </div>
    </div>
  );
}

/**
 * Close a month: turn its feed, pullets and eggs into documents.
 *
 * An action, not a page. Once raised, the invoices and the bill are ordinary
 * transactions on this owner's account and read in the Statement beside every
 * payment against them — which is why there is no separate screen restating
 * them, and no second balance to disagree with the first.
 *
 * The draft is fetched before anything is raised so the button can say what it
 * is about to do, and refuse with a reason when the month is not billable.
 */
function RaiseMonth({ ownerId, onDone }: { ownerId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState(lastMonth());
  const [error, setError] = useState<string | null>(null);

  const { data: d, isLoading } = useQuery({
    queryKey: ["owner-billing", ownerId, period],
    queryFn: () => api<Draft>(`/api/owner-billing/drafts/${ownerId}?period=${period}`),
    enabled: open,
  });

  const raise = useMutation({
    mutationFn: () =>
      // `api` stringifies for us — passing a string here double-encodes it,
      // and express.json() is strict enough to refuse a bare JSON string.
      api("/api/owner-billing/raise", { method: "POST", body: { contactId: ownerId, period } }),
    onSuccess: () => {
      setError(null);
      setOpen(false);
      void qc.invalidateQueries();
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not raise the documents."),
  });

  const blocked = (d?.problems.length ?? 0) > 0;
  const nothing = !d?.feedLines.length && !d?.birdLines.length && !d?.eggLines.length;
  const total = (d?.feedTotal ?? 0) + (d?.birdTotal ?? 0) + (d?.eggTotal ?? 0);

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="btn-primary">
        Close a month ▾
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-20 w-96 rounded-lg border bg-white p-4 text-[13px] shadow-lg">
          <label className="label">Month</label>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="input mb-3"
          />

          {isLoading && <p className="text-gray-500">Reading the month…</p>}

          {d && (
            <>
              <div className="mb-3 space-y-1">
                {(
                  [
                    ["Feed", d.feedTotal, "invoice"],
                    ["Pullets", d.birdTotal, "invoice"],
                    ["Eggs", d.eggTotal, "bill"],
                  ] as const
                ).map(([label, value, doc]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <span className="text-gray-500">
                      {label} <span className="text-gray-400">· {doc}</span>
                    </span>
                    <span className={value > 0 ? "font-medium tabular-nums" : "tabular-nums text-gray-300"}>
                      {value > 0 ? formatMoney(value) : "—"}
                    </span>
                  </div>
                ))}
              </div>

              {d.billed ? (
                <div className="rounded-md bg-green-50 px-3 py-2 text-green-800">
                  {monthLabel(period)} is already billed.{" "}
                  <span className="flex gap-2 pt-1">
                    {d.billed.feedInvoiceId && (
                      <Link href={`/sales/invoices/${d.billed.feedInvoiceId}`} className="s-link">
                        Feed
                      </Link>
                    )}
                    {d.billed.birdInvoiceId && (
                      <Link href={`/sales/invoices/${d.billed.birdInvoiceId}`} className="s-link">
                        Pullets
                      </Link>
                    )}
                    {d.billed.billId && (
                      <Link href={`/purchases/bills/${d.billed.billId}`} className="s-link">
                        Eggs
                      </Link>
                    )}
                  </span>
                </div>
              ) : nothing ? (
                <p className="text-gray-500">Nothing passed between the two in {monthLabel(period)}.</p>
              ) : (
                <>
                  {blocked && (
                    <div className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-amber-800">
                      {d.problems.map((p) => (
                        <div key={p}>· {p}</div>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={() => raise.mutate()}
                    disabled={blocked || raise.isPending}
                    className="btn-primary w-full"
                  >
                    {raise.isPending
                      ? "Raising…"
                      : `Raise ${monthLabel(period)} — ${formatMoney(total)}`}
                  </button>
                </>
              )}
            </>
          )}

          {error && (
            <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
