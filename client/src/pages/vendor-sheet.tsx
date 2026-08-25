import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatMoney } from "../api";
import { SummaryBanner } from "../components/summary-banner";
import { shortDate } from "./documents";

/**
 * Vendor Sheet — the one screen that answers "what do we owe, and what goes to
 * the bank today".
 *
 * Bills and unpaid expenses sit in one list because they are the same thing to
 * whoever is paying: money owed to a vendor with a date on it. Tick the rows,
 * press Send to bank, and the selection comes back as the bank's own upload
 * sheet.
 *
 * Sending is not paying. The file is an instruction; the bank can still reject
 * a line, so nothing here touches the ledger. What it does do is remember what
 * went out, so the rows drop off this list and the same bill is not paid twice
 * on Tuesday and again on Wednesday. The payment itself is recorded when the
 * bank confirms it — a vendor payment against the bill, or the paid-through
 * account filled in on the expense.
 */

interface Payable {
  kind: "bill" | "expense";
  id: string;
  number: string;
  billNumber: string;
  vendorId: string;
  vendorName: string;
  description: string | null;
  amount: string;
  deliveryDate: string | null;
  dueDate: string | null;
  overdueDays: number;
  notes: string | null;
  beneficiaryName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  sentBatchId: string | null;
  sentBatchNumber: string | null;
  sentBatchDate: string | null;
  sentAmount: string | null;
}

interface PayerAccount {
  id: string;
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  bankCustomerCode: string | null;
}

const rowKey = (r: Payable) => `${r.kind}:${r.id}`;
const hasBank = (r: Payable) => !!(r.beneficiaryName && r.bankAccountNumber && r.bankIfsc);
const docPath = (r: Payable) =>
  r.kind === "bill" ? `/purchases/bills/${r.id}` : `/purchases/expenses/${r.id}`;

const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function VendorSheetPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [showSent, setShowSent] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/purchases/payables", showSent],
    queryFn: () =>
      api<Payable[]>(`/api/purchases/payables${showSent ? "?includeSent=1" : ""}`),
  });

  const rows = useMemo(
    () => (showSent ? (data ?? []).filter((r) => r.sentBatchId) : (data ?? [])),
    [data, showSent],
  );

  const chosen = useMemo(
    () => rows.filter((r) => selected.has(rowKey(r))),
    [rows, selected],
  );
  const selectedTotal = chosen.reduce((sum, r) => sum + Number(r.amount), 0);
  const totalPayable = rows.reduce((sum, r) => sum + Number(r.amount), 0);
  const overdueTotal = rows
    .filter((r) => r.overdueDays > 0)
    .reduce((sum, r) => sum + Number(r.amount), 0);

  // Only a row we can actually pay is selectable: a vendor with no account
  // number cannot go in the file, and letting it be ticked only moves the
  // disappointment to the end of the run.
  const payable = rows.filter((r) => hasBank(r) && !r.sentBatchId);
  const allSelected = payable.length > 0 && payable.every((r) => selected.has(rowKey(r)));

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(payable.map(rowKey)));
  const toggleOne = (k: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const missingBank = rows.filter((r) => !hasBank(r) && !r.sentBatchId);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-800">Vendor Sheet</h1>
          <div className="flex rounded-md border border-gray-200 p-0.5 text-[12px]">
            {[
              { label: "To pay", value: false },
              { label: "Sent to bank", value: true },
            ].map((tab) => (
              <button
                key={tab.label}
                onClick={() => {
                  setShowSent(tab.value);
                  setSelected(new Set());
                }}
                className={`rounded px-2.5 py-1 ${
                  showSent === tab.value
                    ? "bg-brand-50 font-medium text-brand-700"
                    : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <span className="text-[13px] text-gray-500">
              {selected.size} selected · {formatMoney(selectedTotal)}
            </span>
          )}
          <button
            onClick={() => setDialogOpen(true)}
            disabled={selected.size === 0}
            className="btn-primary"
          >
            Send to bank
          </button>
        </div>
      </header>

      <SummaryBanner
        primary={{
          label: showSent ? "Sent to the bank" : "To pay",
          value: formatMoney(totalPayable),
        }}
        secondary={[
          { label: "Documents", value: String(rows.length) },
          { label: "Overdue", value: formatMoney(overdueTotal), alert: overdueTotal > 0 },
          { label: "Selected", value: formatMoney(selectedTotal) },
        ]}
      />

      {missingBank.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[12.5px] text-amber-800">
          {missingBank.length === 1 ? "One payable is" : `${missingBank.length} payables are`} owed
          to {[...new Set(missingBank.map((r) => r.vendorName))].join(", ")}, who
          {missingBank.length === 1 ? " has" : " have"} no bank details on file. Add the
          beneficiary name, account number and IFSC on the vendor to include{" "}
          {missingBank.length === 1 ? "it" : "them"}.
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </div>
        ) : !rows.length ? (
          <div className="p-12 text-center text-sm text-gray-500">
            {showSent ? "Nothing has been sent to the bank yet." : "Nothing is unpaid."}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="table-head sticky top-0 z-10">
              <tr>
                <th className="w-9 border-b border-[#ece3d5] px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={payable.length === 0}
                    onChange={toggleAll}
                    className="accent-brand-500"
                  />
                </th>
                <th className="border-b border-[#ece3d5] px-3 py-2 font-semibold">Vendor</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 font-semibold">Item &amp; Desc</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 text-right font-semibold">Amount</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 font-semibold">Bill No</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 font-semibold">Delivery Date</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 font-semibold">Due Date</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 text-right font-semibold">Overdue Days</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const k = rowKey(r);
                const selectable = hasBank(r) && !r.sentBatchId;
                return (
                  <tr
                    key={k}
                    onClick={() => navigate(docPath(r))}
                    className="cursor-pointer bg-white transition-colors duration-100 hover:bg-gray-50"
                  >
                    <td
                      className="border-b border-[#ece3d5] px-3 py-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(k)}
                        disabled={!selectable}
                        title={
                          r.sentBatchId
                            ? `Already sent in ${r.sentBatchNumber}`
                            : selectable
                              ? undefined
                              : `${r.vendorName} has no bank details on file`
                        }
                        onChange={() => toggleOne(k)}
                        className="accent-brand-500 disabled:opacity-40"
                      />
                    </td>
                    <td className="border-b border-[#ece3d5] px-3 py-2">
                      <div className="text-gray-800">{r.vendorName}</div>
                      <div className="text-[11px] text-gray-400">
                        {r.kind === "bill" ? "Bill" : "Expense"} · {r.number}
                      </div>
                      {!hasBank(r) && (
                        <div className="text-[11px] text-amber-600">no bank details</div>
                      )}
                      {r.sentBatchNumber && (
                        <div className="text-[11px] text-brand-600">
                          sent {r.sentBatchNumber} · {shortDate(r.sentBatchDate)}
                        </div>
                      )}
                    </td>
                    <td className="max-w-xs border-b border-[#ece3d5] px-3 py-2">
                      <div className="truncate text-gray-700" title={r.description ?? ""}>
                        {r.description || "—"}
                      </div>
                    </td>
                    <td className="border-b border-[#ece3d5] px-3 py-2 text-right tabular-nums">
                      {formatMoney(r.amount)}
                    </td>
                    <td className="border-b border-[#ece3d5] px-3 py-2 text-gray-600">
                      {r.billNumber}
                    </td>
                    <td className="border-b border-[#ece3d5] px-3 py-2">
                      {shortDate(r.deliveryDate)}
                    </td>
                    <td className="border-b border-[#ece3d5] px-3 py-2">{shortDate(r.dueDate)}</td>
                    <td className="border-b border-[#ece3d5] px-3 py-2 text-right tabular-nums">
                      {r.overdueDays > 0 ? (
                        <span className="text-red-600">{r.overdueDays}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="max-w-[16rem] border-b border-[#ece3d5] px-3 py-2 text-gray-600">
                      <div className="truncate" title={r.notes ?? ""}>
                        {r.notes || "—"}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {dialogOpen && (
        <SendToBankDialog
          rows={chosen}
          onClose={() => setDialogOpen(false)}
          onSent={async () => {
            setDialogOpen(false);
            setSelected(new Set());
            await qc.invalidateQueries({ queryKey: ["/api/purchases/payables"] });
          }}
        />
      )}
    </div>
  );
}

/**
 * The one dialog before money leaves: which account the bank debits, what value
 * date to put on it, and one last look at the total.
 */
function SendToBankDialog({
  rows,
  onClose,
  onSent,
}: {
  rows: Payable[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [bankAccountId, setBankAccountId] = useState("");
  const [batchDate, setBatchDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const { data: accounts } = useQuery({
    queryKey: ["/api/purchases/payment-batches/accounts"],
    queryFn: () => api<PayerAccount[]>("/api/purchases/payment-batches/accounts"),
  });
  // With one bank account there is no choice to make, so don't ask for one.
  useEffect(() => {
    if (accounts?.length === 1) setBankAccountId(accounts[0]!.id);
  }, [accounts]);
  // Escape closes, like every other dialog — but once the file is raised it
  // closes through onSent, or dismissing would leave sent rows on the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (done ? onSent : onClose)();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [done, onClose, onSent]);
  const account = accounts?.find((a) => a.id === bankAccountId);
  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/purchases/payment-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          bankAccountId,
          batchDate,
          notes: notes || undefined,
          items: rows.map((r) => ({ kind: r.kind, id: r.id })),
        }),
      });
      if (!res.ok) {
        let message = res.statusText;
        try {
          message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }
      const number = res.headers.get("X-Payment-Batch-Number") ?? "payments";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${number}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setDone(number);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not raise the file");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={done ? onSent : onClose} />
      <div className="relative z-10 w-full max-w-md rounded-lg border bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-gray-800">Send to bank</h2>
        {done ? (
          <>
            <p className="mt-3 text-[13px] text-gray-600">
              <span className="font-medium text-gray-800">{done}</span> is downloaded, with{" "}
              {rows.length} {rows.length === 1 ? "transfer" : "transfers"} totalling{" "}
              {formatMoney(total)}. Upload it to the bank as it is.
            </p>
            <p className="mt-2 text-[12.5px] text-gray-500">
              These documents are still unpaid in the books — record the payment once the bank
              confirms the transfer.
            </p>
            <div className="mt-5 flex justify-end">
              <button onClick={onSent} className="btn-primary">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-[12.5px] text-gray-500">
              {rows.length} {rows.length === 1 ? "transfer" : "transfers"} · {formatMoney(total)}
            </p>
            <div className="mt-4 grid gap-3">
              <div>
                <label className="label-required">Pay from *</label>
                <select
                  value={bankAccountId}
                  onChange={(e) => setBankAccountId(e.target.value)}
                  className="input"
                >
                  <option value="">Select account…</option>
                  {accounts?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.bankName ? ` · ${a.bankName}` : ""}
                    </option>
                  ))}
                </select>
                {account && !account.bankCustomerCode && (
                  <p className="mt-1 text-[12px] text-amber-700">
                    This account has no customer code from the bank. Add it under Banking, or the
                    bank will reject the file.
                  </p>
                )}
              </div>
              <div>
                <label className="label-required">Value date *</label>
                <input
                  type="date"
                  value={batchDate}
                  onChange={(e) => setBatchDate(e.target.value)}
                  className="input"
                />
              </div>
              <div>
                <label className="label">Notes</label>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What this run is for"
                  className="input"
                />
              </div>
            </div>
            {error && <p className="mt-3 text-[12.5px] text-red-600">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} className="btn-secondary">
                Cancel
              </button>
              <button
                onClick={send}
                disabled={busy || !bankAccountId || !batchDate}
                className="btn-primary"
              >
                {busy ? "Preparing…" : "Generate file"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
