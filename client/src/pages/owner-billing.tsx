import { DateInput, MonthInput } from "../components/date-input";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, formatDate, formatMoney } from "../api";
import { CommentsTimeline } from "../components/comments";
import { AttachmentsButton } from "../components/attachments";
import { SearchSelect } from "../components/search-select";
import { Modal } from "../components/settings-ui";
import { OverviewTab, StatementTab, TransactionsTab } from "./contact-detail";
import { localYmd } from "../lib/utils";

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
  return localYmd(d).slice(0, 7);
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
      navigate(`/accountant/group-companies?owner=${owners[0]!.id}`, { replace: true });
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
        net?: string | null;
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
      <header className="page-header px-4 pt-3 sm:px-6">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* The picker stands where the contact page puts the name. There
                are a handful of owners and moving between them IS the job. */}
            <SearchSelect
              value={ownerId || null}
              onChange={(id) => id && navigate(`/accountant/group-companies?owner=${id}`)}
              options={owners.map((o) => ({ id: o.id, label: o.name }))}
              allowClear={false}
              className="w-72"
              buttonClassName="rounded-md border border-gray-200 bg-white px-2 py-1 text-lg font-semibold text-gray-900"
            />
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {contact.type}
            </span>
            <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-brand-600">
              Group company
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
            <EggSpread ownerId={contact.id} />
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

interface Agreement {
  id: string;
  effectiveFrom: string;
  eggSpreadPerEgg: string;
}

/**
 * The egg spread: what Amino pays over the day's benchmark for each egg.
 *
 * Dated, because a spread agreed in March must not restate January — so a new
 * spread is a new row from a date, and the history stays readable underneath.
 * Before this there was nowhere to set it, and a month with no spread could not
 * be closed (17 Oct 2026).
 */
function EggSpread({ ownerId }: { ownerId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(`${localYmd(new Date()).slice(0, 7)}-01`);
  const [spread, setSpread] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["owner-agreements", ownerId],
    queryFn: () => api<{ agreements: Agreement[] }>(`/api/owner-billing/agreements/${ownerId}`),
  });
  const rows = data?.agreements ?? [];
  const today = localYmd(new Date());
  const current = rows.find((r) => r.effectiveFrom <= today) ?? null;

  const save = useMutation({
    mutationFn: () =>
      api("/api/owner-billing/agreements", {
        method: "POST",
        body: { contactId: ownerId, effectiveFrom: from, eggSpreadPerEgg: Number(spread) },
      }),
    onSuccess: () => {
      setError(null);
      setSpread("");
      void qc.invalidateQueries({ queryKey: ["owner-agreements", ownerId] });
      void qc.invalidateQueries({ queryKey: ["owner-billing", ownerId] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save the spread."),
  });

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="btn-secondary">
        Egg spread {current ? formatMoney(current.eggSpreadPerEgg) : "not set"} ▾
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-20 w-80 rounded-lg border bg-white p-4 text-[13px] shadow-lg">
          <p className="mb-3 text-gray-500">
            Paid per egg over that day's benchmark. A new spread runs from its date until the next.
          </p>
          {rows.length > 0 ? (
            <table className="mb-3 w-full">
              <thead className="table-head">
                <tr>
                  <th className="px-2 py-1.5">From</th>
                  <th className="px-2 py-1.5 text-right">Spread / egg</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#ece3d5]">
                    <td className="px-2 py-1.5">{formatDate(r.effectiveFrom)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(r.eggSpreadPerEgg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-amber-800">
              No spread set — eggs cannot be priced until one is.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">From</label>
              <DateInput value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">Spread / egg (₹)</label>
              <input
                value={spread}
                onChange={(e) => setSpread(e.target.value)}
                placeholder="0.50"
                inputMode="decimal"
                className="input text-right tabular-nums"
              />
            </div>
          </div>
          <button
            onClick={() => save.mutate()}
            disabled={!from || spread.trim() === "" || Number.isNaN(Number(spread)) || save.isPending}
            className="btn-primary mt-3 w-full"
          >
            {save.isPending ? "Saving…" : "Save spread"}
          </button>
          {error && <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</div>}
        </div>
      )}
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
  const [working, setWorking] = useState<"feed" | "birds" | "eggs" | null>(null);

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
        <div className="absolute right-0 top-10 z-20 w-[560px] max-w-[calc(100vw-2rem)] rounded-lg border bg-white p-4 text-[13px] shadow-lg">
          <label className="label">Month</label>
          <MonthInput
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="input mb-3"
          />

          {isLoading && <p className="text-gray-500">Reading the month…</p>}

          {d && (
            <>
              {/* Each figure with its working: the document's lines beneath it,
                  and the total itself opens the day-by-day rows the attached
                  statement is printed from (the user, 17 Oct 2026). */}
              <div className="mb-3 max-h-[55vh] space-y-3 overflow-y-auto">
                {(
                  [
                    ["feed", "Feed", d.feedTotal, "invoice", d.feedLines],
                    ["birds", "Pullets", d.birdTotal, "invoice", d.birdLines],
                    ["eggs", "Eggs", d.eggTotal, "bill", d.eggLines],
                  ] as const
                ).map(([kind, label, value, doc, lines]) => (
                  <div key={label}>
                    <div className="flex justify-between gap-3">
                      <span className="text-gray-500">
                        {label} <span className="text-gray-400">· {doc}</span>
                      </span>
                      {value > 0 ? (
                        <button
                          onClick={() => setWorking(kind)}
                          className="s-link font-medium tabular-nums"
                          title="Day-by-day working"
                        >
                          {formatMoney(value)}
                        </button>
                      ) : (
                        <span className="tabular-nums text-gray-300">—</span>
                      )}
                    </div>
                    {lines.length > 0 && (
                      <table className="mt-1 w-full text-[12px] text-gray-600">
                        <tbody>
                          {lines.map((l, i) => (
                            <tr key={i} className={l.problem ? "text-amber-700" : ""}>
                              <td className="py-0.5 pr-2">{l.description}</td>
                              <td className="whitespace-nowrap py-0.5 text-right tabular-nums">
                                {l.qty.toLocaleString("en-IN")} {l.unit} ×{" "}
                                {l.rate == null ? "—" : formatMoney(l.rate)}
                              </td>
                              <td className="whitespace-nowrap py-0.5 pl-2 text-right tabular-nums">
                                {l.amount == null ? "unpriced" : formatMoney(l.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
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
      {working && (
        <DayWorking ownerId={ownerId} period={period} kind={working} onClose={() => setWorking(null)} />
      )}
    </div>
  );
}

const WORKING_TITLE = { feed: "Feed supplied", birds: "Pullets supplied", eggs: "Eggs bought" } as const;
/** Where the quantity sits, and where the right-aligned figures start, in each kind's rows. */
const QTY_COL = { feed: 4, birds: 4, eggs: 3 } as const;
const FIGURES_FROM = { feed: 4, birds: 3, eggs: 3 } as const;

/**
 * The month's figure taken apart, a row per day: the statement that will be
 * attached to the document, shown before anything is raised. Its total is the
 * figure in the popover, so a row that looks wrong can be found here first.
 */
function DayWorking({
  ownerId,
  period,
  kind,
  onClose,
}: {
  ownerId: string;
  period: string;
  kind: "feed" | "birds" | "eggs";
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["owner-working", ownerId, period, kind],
    queryFn: () =>
      api<{
        columns: string[];
        rows: Array<Array<string | number>>;
        totals: { qty: number; value: number };
        note: string | null;
      }>(`/api/owner-billing/statements/${ownerId}?period=${period}&kind=${kind}`),
  });
  // Columns: date first, rate and value always the last two.
  const n = data?.columns.length ?? 0;
  const cell = (v: string | number, i: number) => {
    if (i === 0) return formatDate(String(v));
    if (v === "") return "—";
    if (i === n - 1) return formatMoney(Number(v));
    if (i === n - 2) return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
    if (typeof v === "number") return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    return v;
  };

  return (
    <Modal
      title={`${WORKING_TITLE[kind]} — ${monthLabel(period)}`}
      onClose={onClose}
      width="w-[860px] max-w-[calc(100vw-2rem)]"
      footer={
        <button onClick={onClose} className="btn-secondary">
          Close
        </button>
      }
    >
      {isLoading && <p className="text-[13px] text-gray-500">Reading the month…</p>}
      {error && <p className="text-[13px] text-red-600">{(error as Error).message}</p>}
      {data && (
        <>
          {data.note && <p className="mb-2 text-[12px] text-gray-500">{data.note}</p>}
          <table className="w-full text-[13px]">
            <thead className="table-head sticky top-0">
              <tr>
                {data.columns.map((c, i) => (
                  <th key={c} className={`border-b border-[#ece3d5] px-2 py-1.5 ${i >= FIGURES_FROM[kind] ? "text-right" : ""}`}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, ri) => (
                <tr key={ri} className="border-b border-[#ece3d5]">
                  {r.map((v, i) => (
                    <td
                      key={i}
                      className={`px-2 py-1 ${i >= FIGURES_FROM[kind] ? "text-right tabular-nums" : ""} ${i === 0 ? "whitespace-nowrap" : ""}`}
                    >
                      {cell(v, i)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="px-2 py-2" colSpan={QTY_COL[kind]}>
                  Total · {data.rows.length} rows
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {data.totals.qty.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                </td>
                <td colSpan={n - QTY_COL[kind] - 2} />
                <td className="px-2 py-2 text-right tabular-nums">{formatMoney(data.totals.value)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </Modal>
  );
}
