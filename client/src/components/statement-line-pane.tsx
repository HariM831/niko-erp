import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Filter, X } from "lucide-react";
import { api, formatDate, formatMoney } from "../api";
import { AccountSelect, bankNodes, type AccountNode } from "./account-select";
import { SearchSelect } from "./search-select";
import { DateInput } from "./date-input";

export interface StatementLine {
  id: string;
  bankAccountId?: string;
  txnDate: string;
  direction: "debit" | "credit";
  amount: string;
  utr?: string | null;
  description?: string | null;
  counterparty?: string | null;
  matchStatus: string;
  matchFound?: boolean;
}

interface Candidate {
  journalEntryId: string;
  entryNumber: string;
  date: string;
  typeLabel: string;
  docPath: string;
  party: string | null;
  narration: string;
  reference: string | null;
  direction: "credit" | "debit";
  amount: string;
  exact: boolean;
  sharedRef: boolean;
  sameParty: boolean;
  /** The line names a different customer or vendor. */
  otherParty: boolean;
}
interface Contact {
  id: string;
  displayName: string;
}
interface Suggestion {
  id: string;
  displayName: string;
  reason: string;
}
interface OpenDoc {
  id: string;
  number: string;
  balanceDue: string;
  status: string;
  invoiceDate?: string;
  billDate?: string;
  dueDate?: string;
}
interface BankAccount {
  id: string;
  name: string;
  kind?: string | null;
  accountNumber?: string | null;
  isActive?: boolean;
}

const paise = (v: string | number) => Math.round(Number(v || 0) * 100);

/**
 * The bank's own reference, where the narration carries one: the RTGS UTR,
 * the IMPS or UPI number, or the bank's transfer reference.
 */
export function statementReference(line: { utr?: string | null; description?: string | null }) {
  // A reference is one unbroken code; "TRANSFER FROM 99509044300 /" is the PDF's column, not one.
  const utr = (line.utr ?? "").replace(/^[\s/]+|[\s/]+$/g, "");
  if (/^[A-Z0-9/-]{6,}$/i.test(utr)) return utr;
  const d = line.description ?? "";
  const m =
    /UTR\s*NO:?\s*([A-Z0-9]{8,})/i.exec(d) ??
    /\b(?:IMPS|UPI\/(?:CR|DR))\/(\d{8,})/i.exec(d) ??
    /NEFT\*.*?\*([A-Z]{4,5}\d{8,})/i.exec(d) ??
    /\b(CMP(?:IFT|NEFT)\/[A-Z0-9]+)/i.exec(d) ??
    /\b(SBI[A-Z]?\d{10,})/i.exec(d);
  return m?.[1] ?? "";
}
const rupees = (p: number) => (p / 100).toFixed(2);

/**
 * Zoho's Categorize Manually types. Each says what it makes: a payment or
 * expense in its own module, a transfer, or a journal to a head of the kind
 * the type names.
 */
type Kind = "customer_advance" | "customer_payment" | "vendor_advance" | "vendor_payment" | "expense" | "transfer" | "card_payment" | "account";
interface TxnType {
  id: string;
  label: string;
  kind: Kind;
  /** For an "account" type: the heads it may post to. */
  heads?: (a: AccountNode) => boolean;
}
const MONEY_IN: TxnType[] = [
  { id: "customer_advance", label: "Customer Advance", kind: "customer_advance" },
  { id: "customer_payment", label: "Customer Payment", kind: "customer_payment" },
  { id: "transfer_in", label: "Transfer From Another Account", kind: "transfer" },
  { id: "interest_income", label: "Interest Income", kind: "account", heads: (a) => a.type === "income" },
  { id: "other_income", label: "Other Income", kind: "account", heads: (a) => a.type === "income" },
  { id: "expense_refund", label: "Expense Refund", kind: "account", heads: (a) => a.type === "expense" },
  { id: "owners_contribution", label: "Owner's Contribution", kind: "account", heads: (a) => a.type === "equity" },
];
const MONEY_OUT: TxnType[] = [
  { id: "expense", label: "Expense", kind: "expense" },
  { id: "vendor_advance", label: "Vendor Advance", kind: "vendor_advance" },
  { id: "vendor_payment", label: "Vendor Payment", kind: "vendor_payment" },
  { id: "transfer_out", label: "Transfer To Another Account", kind: "transfer" },
  { id: "card_payment", label: "Card Payment", kind: "card_payment" },
  { id: "owner_drawings", label: "Owner Drawings", kind: "account", heads: (a) => a.type === "equity" },
  { id: "employee_reimbursement", label: "Employee Reimbursement", kind: "account", heads: (a) => a.type === "expense" || a.type === "liability" },
];
const MODES = ["bank_transfer", "cash", "upi", "cheque", "card"] as const;

/**
 * The pane an uncategorized statement line opens, as in Zoho: Match
 * Transactions (pair it with what is already in the books) or Categorize
 * Manually (make the transaction from the line). Date, amount and bank come
 * from the line and cannot be changed here.
 */
export function StatementLinePane({
  line,
  bankAccountId,
  onClose,
  onDone,
}: {
  line: StatementLine;
  bankAccountId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  // Most deposits are a customer's advance with nothing in the books yet: a
  // line without a match opens where it will be categorized.
  const [tab, setTab] = useState<"match" | "categorize">(line.matchFound ? "match" : "categorize");
  const isIn = line.direction === "credit";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-[560px] flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b px-5 pb-0 pt-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-gray-500">
                {formatDate(line.txnDate)} · {isIn ? "Deposit" : "Withdrawal"}
              </div>
              <div className={`text-xl font-semibold tabular-nums ${isIn ? "text-green-700" : ""}`}>{formatMoney(line.amount)}</div>
              <div className="mt-1 break-words text-[12px] text-gray-600">{line.description ?? line.counterparty ?? "—"}</div>
              {line.utr && <div className="mt-0.5 text-[11px] text-gray-400">Ref: {line.utr}</div>}
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700" title="Close">
              <X size={18} />
            </button>
          </div>
          <nav className="flex gap-6 text-[13px]">
            {(["match", "categorize"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`border-b-2 pb-2 ${tab === t ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-gray-500"}`}
              >
                {t === "match" ? "Match Transactions" : "Categorize Manually"}
              </button>
            ))}
          </nav>
        </header>
        <div className="flex-1 overflow-y-auto">
          {tab === "match" ? (
            <MatchTab line={line} onDone={onDone} />
          ) : (
            <CategorizeTab line={line} bankAccountId={bankAccountId} onDone={onDone} />
          )}
        </div>
        <footer className="flex justify-end border-t px-5 py-2.5">
          <ExcludeButton line={line} onDone={onDone} />
        </footer>
      </aside>
    </div>
  );
}

function ExcludeButton({ line, onDone }: { line: StatementLine; onDone: (m: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        onClick={async () => {
          try {
            await api(`/api/banking/transactions/${line.id}/exclude`, { method: "POST" });
            onDone("Statement line excluded.");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Exclude failed");
          }
        }}
        className="text-[13px] text-gray-500 hover:underline"
      >
        Exclude this transaction
      </button>
    </div>
  );
}

// ============================ Match Transactions ============================

function MatchTab({ line, onDone }: { line: StatementLine; onDone: (m: string) => void }) {
  const [showFilter, setShowFilter] = useState(false);
  const [draft, setDraft] = useState({ from: "", to: "", min: "", max: "", contact: "", reference: "", includeOpposite: false });
  const [filter, setFilter] = useState(draft);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.min) params.set("min", filter.min);
  if (filter.max) params.set("max", filter.max);
  if (filter.contact) params.set("contact", filter.contact);
  if (filter.reference) params.set("reference", filter.reference);
  if (filter.includeOpposite) params.set("includeOpposite", "true");
  const { data } = useQuery({
    queryKey: ["possible-matches", line.id, params.toString()],
    queryFn: () => api<{ from: string; to: string; candidates: Candidate[] }>(`/api/banking/transactions/${line.id}/possible-matches?${params}`),
  });
  const candidates = data?.candidates ?? [];

  // Money in counts up, money out down; the selection must land on the line.
  const signed = (c: { direction: "credit" | "debit"; amount: string }) => (c.direction === "credit" ? 1 : -1) * paise(c.amount);
  const wantP = signed(line);
  const byId = new Map(candidates.map((c) => [c.journalEntryId, c]));
  const gotP = selected.reduce((s, id) => s + (byId.get(id) ? signed(byId.get(id)!) : 0), 0);
  const diffP = Math.abs(wantP) - Math.abs(gotP);

  const match = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/banking/transactions/${line.id}/match`, { method: "POST", body: { journalEntryIds: selected } });
      onDone(`Matched to ${selected.length === 1 ? byId.get(selected[0]!)?.entryNumber ?? "1 transaction" : `${selected.length} transactions`}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Match failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">Possible Matches</h3>
        <button onClick={() => setShowFilter((s) => !s)} className="btn-ghost p-1.5" title="Filter">
          <Filter size={14} />
        </button>
      </div>
      {data && (
        <p className="mb-2 text-[11px] text-gray-400">
          {formatDate(data.from)} – {formatDate(data.to)}, {isInLabel(line)} up to {formatMoney(filter.max || line.amount)}
        </p>
      )}

      {showFilter && (
        <div className="mb-3 grid grid-cols-2 gap-2 rounded border bg-gray-50 p-3 text-[13px]">
          <div>
            <label className="label">Amount from</label>
            <input value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} className="input" placeholder="0.00" />
          </div>
          <div>
            <label className="label">Amount to</label>
            <input value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} className="input" placeholder={line.amount} />
          </div>
          <div>
            <label className="label">Date from</label>
            <DateInput value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className="input" />
          </div>
          <div>
            <label className="label">Date to</label>
            <DateInput value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className="input" />
          </div>
          <div>
            <label className="label">Customer/Vendor</label>
            <input value={draft.contact} onChange={(e) => setDraft({ ...draft, contact: e.target.value })} className="input" />
          </div>
          <div>
            <label className="label">Reference#</label>
            <input value={draft.reference} onChange={(e) => setDraft({ ...draft, reference: e.target.value })} className="input" />
          </div>
          <label className="col-span-2 flex items-center gap-1.5 text-[12px] text-gray-600">
            <input
              type="checkbox"
              checked={draft.includeOpposite}
              onChange={(e) => setDraft({ ...draft, includeOpposite: e.target.checked })}
            />
            Include {line.direction === "credit" ? "withdrawals" : "deposits"}
          </label>
          <div className="col-span-2 flex gap-2">
            <button onClick={() => setFilter(draft)} className="btn-primary">Search</button>
            <button
              onClick={() => {
                const blank = { from: "", to: "", min: "", max: "", contact: "", reference: "", includeOpposite: false };
                setDraft(blank);
                setFilter(blank);
              }}
              className="btn-secondary"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {!data ? (
        <p className="py-6 text-center text-sm text-gray-400">Looking…</p>
      ) : !candidates.length ? (
        <p className="py-6 text-center text-sm text-gray-500">
          No transactions in the books fit this line. Widen the filter, or categorize it manually.
        </p>
      ) : (
        <ul className="divide-y rounded border">
          {candidates.map((c) => {
            const on = selected.includes(c.journalEntryId);
            return (
              <li key={c.journalEntryId} className={`flex items-start gap-3 px-3 py-2.5 text-[13px] ${on ? "bg-brand-50" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{c.typeLabel}</span>
                    <a href={c.docPath} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                      {c.entryNumber}
                    </a>
                    {c.exact && !c.otherParty && (
                      <span className="rounded bg-green-100 px-1.5 text-[10px] font-semibold uppercase text-green-700">Best match</span>
                    )}
                    {c.sameParty && <span className="rounded bg-green-50 px-1.5 text-[10px] font-semibold uppercase text-green-700">Same party</span>}
                    {c.otherParty && (
                      <span className="rounded bg-amber-100 px-1.5 text-[10px] font-semibold uppercase text-amber-700" title="The statement line names someone else">
                        Different party
                      </span>
                    )}
                    {c.sharedRef && <span className="rounded bg-blue-100 px-1.5 text-[10px] font-semibold uppercase text-blue-700">Same ref</span>}
                  </div>
                  <div className="text-[12px] text-gray-500">
                    {formatDate(c.date)}
                    {c.party ? ` · ${c.party}` : ""}
                    {c.reference ? ` · ${c.reference}` : ""}
                  </div>
                </div>
                <div className="text-right tabular-nums">
                  <div>{formatMoney(c.amount)}</div>
                  <div className="text-[11px] text-gray-400">{c.direction === "credit" ? "Deposit" : "Withdrawal"}</div>
                </div>
                <button
                  onClick={() => setSelected((s) => (on ? s.filter((x) => x !== c.journalEntryId) : [...s, c.journalEntryId]))}
                  className={on ? "btn-primary" : "btn-secondary"}
                >
                  {on ? "Unselect" : "Select"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected.length > 0 && (
        <div className="mt-3 rounded border bg-gray-50 px-3 py-2 text-[13px]">
          <div className="flex justify-between">
            <span>Total selected ({selected.length})</span>
            <span className="tabular-nums">{formatMoney(rupees(Math.abs(gotP)))}</span>
          </div>
          <div className={`flex justify-between ${diffP === 0 ? "text-green-700" : "text-red-600"}`}>
            <span>Difference</span>
            <span className="tabular-nums">{formatMoney(rupees(diffP))}</span>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3">
        <button onClick={() => void match()} disabled={busy || !selected.length || gotP !== wantP} className="btn-primary">
          Match
        </button>
      </div>
    </div>
  );
}

const isInLabel = (line: StatementLine) => (line.direction === "credit" ? "deposits" : "withdrawals");

// ============================ Categorize Manually ============================

function CategorizeTab({
  line,
  bankAccountId,
  onDone,
}: {
  line: StatementLine;
  bankAccountId: string;
  onDone: (m: string) => void;
}) {
  const isIn = line.direction === "credit";
  const types = isIn ? MONEY_IN : MONEY_OUT;
  const [typeId, setTypeId] = useState(types[0]!.id);
  const type = types.find((t) => t.id === typeId)!;
  const qc = useQueryClient();

  // A cash deposit is cash received; everything else on a statement arrived by transfer.
  const cashy = /cash\s*deposit/i.test(line.description ?? "");
  const [contactId, setContactId] = useState("");
  const [mode, setMode] = useState<string>(cashy ? "cash" : "bank_transfer");
  const [reference, setReference] = useState(statementReference(line));
  const [notes, setNotes] = useState(line.description ?? "");
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [tds, setTds] = useState("");
  const [accountId, setAccountId] = useState("");
  const [otherBankId, setOtherBankId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const side = type.kind.startsWith("customer") ? "customer" : type.kind.startsWith("vendor") ? "vendor" : null;
  const withDocs = type.kind === "customer_payment" || type.kind === "vendor_payment";

  useEffect(() => {
    setContactId("");
    setApplied({});
    setAccountId("");
    setOtherBankId("");
  }, [typeId]);
  useEffect(() => setApplied({}), [contactId]);

  const { data: contacts } = useQuery({
    queryKey: ["contacts", side],
    queryFn: () => api<Contact[]>(`/api/contacts?type=${side}&isActive=true`),
    enabled: !!side,
  });
  const { data: vendors } = useQuery({
    queryKey: ["contacts", "vendor"],
    queryFn: () => api<Contact[]>(`/api/contacts?type=vendor&isActive=true`),
    enabled: type.kind === "expense",
  });
  const { data: suggestions } = useQuery({
    queryKey: ["party-suggestions", line.id, side ?? "vendor"],
    queryFn: () => api<Suggestion[]>(`/api/banking/transactions/${line.id}/party-suggestions?side=${side ?? "vendor"}`),
    enabled: !!side || type.kind === "expense",
  });
  // One name on the statement that the books hold: filled in, for the person
  // saving to see and change. Two or more, or none, and nothing is filled.
  useEffect(() => {
    if (side && suggestions?.length === 1) setContactId(suggestions[0]!.id);
    if (type.kind === "expense" && suggestions?.length === 1) setVendorId(suggestions[0]!.id);
  }, [suggestions, side, type.kind]);

  const { data: docs } = useQuery({
    queryKey: ["open-docs", side, contactId],
    queryFn: () =>
      api<OpenDoc[]>(side === "customer" ? `/api/sales/invoices?customerId=${contactId}` : `/api/purchases/bills?vendorId=${contactId}`),
    enabled: withDocs && !!contactId,
  });
  const openDocs = (docs ?? []).filter((d) =>
    side === "customer" ? d.status === "sent" || d.status === "partially_paid" : d.status === "open" || d.status === "partially_paid",
  );
  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<AccountNode[]>("/api/accounting/accounts"),
    enabled: type.kind === "account" || type.kind === "expense",
  });
  const { data: banks } = useQuery({
    queryKey: ["bank-accounts"],
    queryFn: () => api<BankAccount[]>("/api/banking/accounts"),
    enabled: type.kind === "transfer" || type.kind === "card_payment",
  });
  const otherBanks = (banks ?? []).filter(
    (b) => b.id !== bankAccountId && b.isActive !== false && (type.kind !== "card_payment" || b.kind === "card"),
  );

  // A vendor payment is gross of TDS: the bank paid the line, the vendor is settled for the line plus the tax held back.
  const tdsP = side === "vendor" ? paise(tds) : 0;
  const grossP = paise(line.amount) + tdsP;
  const appliedP = Object.values(applied).reduce((s, v) => s + paise(v), 0);
  const leftP = grossP - appliedP;

  const autoApply = () => {
    let remaining = grossP;
    const next: Record<string, string> = {};
    for (const d of openDocs) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, paise(d.balanceDue));
      next[d.id] = rupees(take);
      remaining -= take;
    }
    setApplied(next);
  };

  const pinned = suggestions?.length
    ? {
        heading: "From the statement",
        ids: suggestions.map((s) => s.id),
        meta: (id: string) => {
          const s = suggestions.find((x) => x.id === id);
          return s ? `matches ${s.reason}` : null;
        },
      }
    : undefined;

  const ready =
    type.kind === "account"
      ? !!accountId
      : type.kind === "expense"
        ? !!accountId
        : type.kind === "transfer" || type.kind === "card_payment"
          ? !!otherBankId
          : !!contactId && appliedP <= grossP && (side !== "vendor" || tdsP < grossP);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let message = "";
      if (side) {
        const applications = withDocs
          ? Object.entries(applied)
              .filter(([, v]) => paise(v) > 0)
              .map(([id, v]) => ({ [side === "customer" ? "invoiceId" : "billId"]: id, amount: rupees(paise(v)) }))
          : [];
        const body: Record<string, unknown> = {
          [side === "customer" ? "customerId" : "vendorId"]: contactId,
          paymentDate: line.txnDate,
          amount: rupees(grossP),
          mode,
          bankAccountId,
          reference: reference || undefined,
          notes: notes || undefined,
          applications,
          bankTransactionId: line.id,
        };
        if (tdsP > 0) body.tdsAmount = rupees(tdsP);
        const saved = await api<{ number: string }>(side === "customer" ? "/api/sales/payments" : "/api/purchases/payments", {
          method: "POST",
          body,
        });
        message = `${type.label} ${saved.number} recorded and the line categorized.`;
      } else if (type.kind === "expense") {
        const saved = await api<{ number: string }>("/api/purchases/expenses", {
          method: "POST",
          body: {
            expenseDate: line.txnDate,
            expenseAccountId: accountId,
            paidThroughId: bankAccountId,
            vendorId: vendorId || undefined,
            amount: line.amount,
            reference: reference || undefined,
            notes: notes || undefined,
            bankTransactionId: line.id,
          },
        });
        message = `Expense ${saved.number} recorded and the line categorized.`;
      } else if (type.kind === "transfer" || type.kind === "card_payment") {
        await api("/api/banking/transfer", {
          method: "POST",
          body: {
            fromBankAccountId: isIn ? otherBankId : bankAccountId,
            toBankAccountId: isIn ? bankAccountId : otherBankId,
            amount: line.amount,
            date: line.txnDate,
            reference: reference || undefined,
            bankTransactionId: line.id,
          },
        });
        message = "Transfer recorded and the line categorized.";
      } else {
        await api(`/api/banking/transactions/${line.id}/categorize`, {
          method: "POST",
          body: { accountId, narration: `${type.label}: ${notes || line.description || line.utr || "bank transaction"}` },
        });
        message = `Categorized as ${type.label}.`;
      }
      await qc.invalidateQueries();
      onDone(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const typeOptions = useMemo(() => types.map((t) => ({ id: t.id, label: t.label })), [types]);

  return (
    <div className="space-y-3 px-5 py-4 text-[13px]">
      <div>
        <label className="label-required">Category *</label>
        <SearchSelect value={typeId} onChange={(id) => id && setTypeId(id)} options={typeOptions} allowClear={false} keepOrder />
        <p className="mt-1 text-[11px] text-gray-400">{isIn ? "Money In" : "Money Out"}</p>
      </div>

      {side && (
        <div>
          <label className="label-required">{side === "customer" ? "Customer" : "Vendor"} *</label>
          <SearchSelect
            value={contactId || null}
            onChange={(id) => setContactId(id ?? "")}
            options={(contacts ?? []).map((c) => ({ id: c.id, label: c.displayName }))}
            pinned={pinned}
            placeholder={`Select ${side === "customer" ? "Customer" : "Vendor"}`}
          />
        </div>
      )}

      {(type.kind === "expense" || type.kind === "account") && (
        <div>
          <label className="label-required">{type.kind === "expense" ? "Expense Account" : "Account"} *</label>
          <AccountSelect
            value={accountId}
            onChange={setAccountId}
            accounts={accounts}
            include={type.kind === "expense" ? (a) => a.type === "expense" : type.heads!}
          />
        </div>
      )}

      {type.kind === "expense" && (
        <div>
          <label className="label">Vendor</label>
          <SearchSelect
            value={vendorId || null}
            onChange={(id) => setVendorId(id ?? "")}
            options={(vendors ?? []).map((c) => ({ id: c.id, label: c.displayName }))}
            pinned={pinned}
            placeholder="Select Vendor"
          />
        </div>
      )}

      {(type.kind === "transfer" || type.kind === "card_payment") && (
        <div>
          <label className="label-required">{isIn ? "From Account" : type.kind === "card_payment" ? "Card" : "To Account"} *</label>
          <AccountSelect value={otherBankId} onChange={setOtherBankId} accounts={bankNodes(otherBanks)} include={() => true} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{side === "customer" ? "Amount Received" : "Amount"}</label>
          <input value={formatMoney(line.amount)} disabled className="input bg-gray-50" />
        </div>
        <div>
          <label className="label">Date</label>
          <input value={formatDate(line.txnDate)} disabled className="input bg-gray-50" />
        </div>
        {side === "vendor" && (
          <div>
            <label className="label">TDS deducted</label>
            <input value={tds} onChange={(e) => setTds(e.target.value)} className="input" placeholder="0.00" />
          </div>
        )}
        {side && (
          <div>
            <label className="label">{side === "customer" ? "Received Via" : "Paid Via"}</label>
            <SearchSelect
              value={mode}
              onChange={(id) => id && setMode(id)}
              options={MODES.map((m) => ({ id: m, label: m.replace(/_/g, " ") }))}
              allowClear={false}
              keepOrder
            />
          </div>
        )}
        <div className={side === "vendor" ? "col-span-2" : side ? "" : "col-span-2"}>
          <label className="label">Reference#</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} className="input" />
        </div>
      </div>

      <div>
        <label className="label">Description</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input" maxLength={500} />
      </div>

      {withDocs && contactId && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <h4 className="font-semibold">{side === "customer" ? "Unpaid Invoices" : "Unpaid Bills"}</h4>
            {openDocs.length > 0 && (
              <button onClick={autoApply} className="text-[12px] text-brand-600 hover:underline">
                Apply oldest first
              </button>
            )}
          </div>
          {!docs ? (
            <p className="text-gray-400">Loading…</p>
          ) : !openDocs.length ? (
            <p className="text-gray-500">
              There are no unpaid {side === "customer" ? "invoices associated with this customer" : "bills from this vendor"}.
            </p>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="table-head">
                <tr>
                  <th className="px-2 py-1.5">{side === "customer" ? "Invoice#" : "Bill#"}</th>
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5 text-right">Due</th>
                  <th className="px-2 py-1.5 text-right">Payment</th>
                </tr>
              </thead>
              <tbody>
                {openDocs.map((d) => (
                  <tr key={d.id} className="border-b border-[#ece3d5]">
                    <td className="px-2 py-1.5">{d.number}</td>
                    <td className="px-2 py-1.5">{formatDate(d.invoiceDate ?? d.billDate ?? d.dueDate ?? "")}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(d.balanceDue)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        value={applied[d.id] ?? ""}
                        onChange={(e) => setApplied((a) => ({ ...a, [d.id]: e.target.value }))}
                        className="input w-28 text-right"
                        placeholder="0.00"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {side && (
        <div className="rounded border bg-gray-50 px-3 py-2">
          {side === "vendor" && tdsP > 0 && (
            <div className="flex justify-between text-gray-500">
              <span>Settled with the vendor (paid + TDS)</span>
              <span className="tabular-nums">{formatMoney(rupees(grossP))}</span>
            </div>
          )}
          {withDocs && (
            <div className="flex justify-between">
              <span>Applied</span>
              <span className="tabular-nums">{formatMoney(rupees(appliedP))}</span>
            </div>
          )}
          <div className={`flex justify-between ${leftP < 0 ? "text-red-600" : ""}`}>
            <span>
              {leftP < 0
                ? "Applied is more than the payment"
                : side === "customer"
                  ? "Held as Customer Advance"
                  : "Held as Vendor Advance"}
            </span>
            <span className="tabular-nums">{formatMoney(rupees(Math.abs(leftP)))}</span>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button onClick={() => void save()} disabled={busy || !ready} className="btn-primary">
          Save
        </button>
      </div>
    </div>
  );
}
