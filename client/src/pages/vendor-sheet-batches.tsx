import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatMoney } from "../api";
import { SummaryBanner } from "../components/summary-banner";
import { DateInput } from "../components/date-input";
import { useLocalSearch } from "../components/search-context";
import { matchesTerm } from "../lib/utils";
import { shortDate } from "./documents";

/**
 * Sent to bank: one row per batch (22 Oct 2026).
 *
 * Send to bank on the other tabs only makes the batch. The file is downloaded
 * here — as often as needed, by whoever uploads it — and here it is marked
 * paid once the bank confirms, which records every transfer in it as a vendor
 * payment (or the expense as paid). Clicking a batch opens it: every bill,
 * expense and advance it carries, and what went to the bank for each.
 */

type BatchStatus = "sent" | "paid" | "cancelled";

interface BatchRow {
  id: string;
  number: string;
  batchDate: string;
  bankAccountName: string | null;
  total: string;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  paidAt: string | null;
  paidOn: string | null;
  paidByName: string | null;
  lineCount: number;
  liveCount: number;
  liveTotal: string;
  vendorCount: number;
  advanceCount: number;
  status: BatchStatus;
}

interface BatchLine {
  id: string;
  kind: "bill" | "expense" | "advance";
  documentId: string;
  number: string;
  billNumber: string | null;
  description: string | null;
  documentDate: string | null;
  dueDate: string | null;
  vendorId: string;
  vendorName: string;
  amount: string;
  beneficiaryName: string;
  accountNumber: string;
  ifsc: string;
  transferMode: string;
  remarks: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  recordedAt: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  proformaNumber: string | null;
  proformaDate: string | null;
  paymentId: string | null;
  paymentNumber: string | null;
}

interface BatchDetail extends Omit<BatchRow, "lineCount" | "liveCount" | "liveTotal" | "vendorCount" | "advanceCount"> {
  cancelledByName: string | null;
  lines: BatchLine[];
}

const STATUS: Record<BatchStatus, { label: string; tone: string }> = {
  sent: { label: "Sent", tone: "bg-amber-50 text-amber-800" },
  paid: { label: "Paid", tone: "bg-green-50 text-green-700" },
  cancelled: { label: "Cancelled", tone: "bg-gray-100 text-gray-500" },
};

function StatusBadge({ status }: { status: BatchStatus }) {
  const s = STATUS[status];
  return <span className={`rounded px-1.5 py-0.5 text-[11.5px] font-medium ${s.tone}`}>{s.label}</span>;
}

/** Fetch a batch's bank file and save it under the batch number. */
async function downloadBatchFile(id: string, number: string) {
  const res = await fetch(`/api/purchases/payment-batches/${id}/file`, { credentials: "same-origin" });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${number}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

function DownloadButton({ batch, className }: { batch: { id: string; number: string }; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end">
      <button
        onClick={async (e) => {
          e.stopPropagation();
          setBusy(true);
          setError(null);
          try {
            await downloadBatchFile(batch.id, batch.number);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not download");
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className={className ?? "rounded px-2 py-1 text-[12.5px] font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50"}
      >
        {busy ? "Downloading…" : "Download file"}
      </button>
      {error && <span className="text-[11.5px] text-red-600">{error}</span>}
    </span>
  );
}

const STATUS_FILTERS: Array<{ key: BatchStatus | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "sent", label: "Sent" },
  { key: "paid", label: "Paid" },
  { key: "cancelled", label: "Cancelled" },
];

export function SentBatches() {
  const [status, setStatus] = useState<BatchStatus | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/purchases/payment-batches"],
    queryFn: () => api<BatchRow[]>("/api/purchases/payment-batches"),
  });
  const term = useLocalSearch("Vendor Sheet", "vendor-sheet");
  const batches = data ?? [];
  const shown = useMemo(
    () =>
      batches.filter(
        (b) =>
          (status === "all" || b.status === status) &&
          matchesTerm(term, [b.number, b.notes, b.bankAccountName, b.createdByName]),
      ),
    [batches, status, term],
  );
  const waiting = batches.filter((b) => b.status === "sent");
  const waitingTotal = waiting.reduce((s, b) => s + Number(b.liveTotal), 0);
  const shownTotal = shown.reduce((s, b) => s + (b.status === "cancelled" ? 0 : Number(b.liveTotal)), 0);

  return (
    <>
      <SummaryBanner
        primary={{ label: "Waiting for the bank", value: formatMoney(waitingTotal) }}
        secondary={[
          { label: "Batches waiting", value: String(waiting.length) },
          { label: "Transfers waiting", value: String(waiting.reduce((s, b) => s + b.liveCount, 0)) },
          { label: "Paid batches", value: String(batches.filter((b) => b.status === "paid").length) },
        ]}
      />
      <div className="flex items-center gap-1 border-b px-3 py-1.5 text-[12px] sm:px-5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatus(f.key)}
            className={`rounded px-2.5 py-1 ${
              status === f.key ? "bg-brand-50 font-medium text-brand-700" : "text-gray-500 hover:bg-gray-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </div>
        ) : !batches.length ? (
          <div className="p-12 text-center text-sm text-gray-500">Nothing has been sent to the bank yet.</div>
        ) : !shown.length ? (
          <div className="p-12 text-center text-sm text-gray-500">No batch matches.</div>
        ) : (
          <table className="list-table w-full border-separate border-spacing-0 text-[13px]">
            <thead className="table-head sticky top-0 z-10">
              <tr>
                <th className="border-b border-[#ece3d5] px-3 py-2 text-left font-semibold">Batch#</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 text-left font-semibold">Value Date</th>
                <th className="col-portrait-hide border-b border-[#ece3d5] px-3 py-2 text-left font-semibold">Pay From</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 text-right font-semibold">Transfers</th>
                <th className="col-portrait-hide border-b border-[#ece3d5] px-3 py-2 text-right font-semibold">Vendors</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 text-right font-semibold">Amount</th>
                <th className="col-portrait-hide border-b border-[#ece3d5] px-3 py-2 text-left font-semibold">Sent By</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 text-left font-semibold">Status</th>
                <th className="border-b border-[#ece3d5] px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => setOpenId(b.id)}
                  className={`cursor-pointer bg-white transition-colors duration-100 hover:bg-gray-50 ${
                    b.status === "cancelled" ? "text-gray-400" : ""
                  }`}
                >
                  <td className="border-b border-[#ece3d5] px-3 py-2">
                    <div className="font-medium text-brand-700">{b.number}</div>
                    {b.notes && <div className="max-w-[14rem] truncate text-[11.5px] text-gray-500">{b.notes}</div>}
                  </td>
                  <td className="border-b border-[#ece3d5] px-3 py-2">{shortDate(b.batchDate)}</td>
                  <td className="col-portrait-hide border-b border-[#ece3d5] px-3 py-2">{b.bankAccountName ?? "—"}</td>
                  <td className="border-b border-[#ece3d5] px-3 py-2 text-right tabular-nums">
                    {b.liveCount}
                    {b.liveCount !== b.lineCount && (
                      <span className="text-gray-400" title="cancelled transfers"> / {b.lineCount}</span>
                    )}
                    {b.advanceCount > 0 && (
                      <div className="text-[11px] text-gray-500">
                        {b.advanceCount} {b.advanceCount === 1 ? "advance" : "advances"}
                      </div>
                    )}
                  </td>
                  <td className="col-portrait-hide border-b border-[#ece3d5] px-3 py-2 text-right tabular-nums">{b.vendorCount}</td>
                  <td className="border-b border-[#ece3d5] px-3 py-2 text-right tabular-nums">
                    {formatMoney(b.status === "cancelled" ? b.total : b.liveTotal)}
                  </td>
                  <td className="col-portrait-hide border-b border-[#ece3d5] px-3 py-2">{b.createdByName ?? "—"}</td>
                  <td className="border-b border-[#ece3d5] px-3 py-2">
                    <StatusBadge status={b.status} />
                    {b.status === "paid" && b.paidOn && (
                      <div className="text-[11px] text-gray-500">{shortDate(b.paidOn)}</div>
                    )}
                  </td>
                  <td className="border-b border-[#ece3d5] px-3 py-1.5 text-right">
                    {b.status !== "cancelled" && b.liveCount > 0 && <DownloadButton batch={b} />}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="table-head sticky bottom-0 z-10">
              <tr>
                <td className="border-t border-[#ece3d5] px-3 py-2 font-semibold" colSpan={3}>
                  Total <span className="ml-1.5 font-normal text-gray-400">{shown.length} batches</span>
                </td>
                <td className="border-t border-[#ece3d5] px-3 py-2" />
                <td className="col-portrait-hide border-t border-[#ece3d5] px-3 py-2" />
                <td className="border-t border-[#ece3d5] px-3 py-2 text-right font-semibold tabular-nums">
                  {formatMoney(shownTotal)}
                </td>
                <td className="col-portrait-hide border-t border-[#ece3d5] px-3 py-2" colSpan={3} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      {openId && <BatchDialog id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

const kindLabel = (l: BatchLine) => (l.kind === "bill" ? "Bill" : l.kind === "expense" ? "Expense" : "Advance");
const docHref = (l: BatchLine) =>
  l.kind === "bill"
    ? `/purchases/bills/${l.documentId}`
    : l.kind === "expense"
      ? `/purchases/expenses/${l.documentId}`
      : `/purchases/orders/${l.purchaseOrderId}`;

type Step = { kind: "markPaid" } | { kind: "cancelBatch" } | { kind: "cancelLines" } | null;

/**
 * One batch, opened: everything in it, and what can still be done with it.
 */
function BatchDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: batch, isLoading, error } = useQuery({
    queryKey: ["/api/purchases/payment-batches", id],
    queryFn: () => api<BatchDetail>(`/api/purchases/payment-batches/${id}`),
  });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>(null);
  const [reason, setReason] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (step) setStep(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, onClose]);
  useEffect(() => {
    if (batch && !paymentDate) setPaymentDate(batch.batchDate);
  }, [batch, paymentDate]);

  const lines = batch?.lines ?? [];
  const live = lines.filter((l) => !l.cancelledAt);
  const liveTotal = live.reduce((s, l) => s + Number(l.amount), 0);
  const waiting = live.filter((l) => !l.recordedAt);
  // A transfer can be cancelled while it is live and not yet in the books.
  const cancellable = (l: BatchLine) => batch?.status === "sent" && !l.cancelledAt && !l.recordedAt;
  const tickedLines = lines.filter((l) => ticked.has(l.id));

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["/api/purchases/payment-batches"] });
    await qc.invalidateQueries({ queryKey: ["/api/purchases/payables"] });
  };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setActionError(null);
    try {
      const msg = await fn();
      setMessage(msg);
      setStep(null);
      setReason("");
      setTicked(new Set());
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "That did not work");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-3 py-8">
      <div className="fixed inset-0" onClick={onClose} />
      <div role="dialog" aria-label="Payment batch" className="relative z-10 w-full max-w-6xl rounded-lg bg-white shadow-2xl">
        {isLoading || !batch ? (
          <div className="p-8 text-center text-sm text-gray-500">
            {error ? (error instanceof Error ? error.message : "Failed to load") : "Loading…"}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-3 sm:px-6">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[15px] font-semibold text-gray-800">{batch.number}</h2>
                  <StatusBadge status={batch.status} />
                </div>
                <div className="mt-0.5 text-[12.5px] text-gray-500">
                  Value date {shortDate(batch.batchDate)} · from {batch.bankAccountName ?? "—"} · sent by{" "}
                  {batch.createdByName ?? "—"} on {shortDate(batch.createdAt)}
                  {batch.notes && <> · {batch.notes}</>}
                </div>
                {batch.status === "paid" && (
                  <div className="text-[12.5px] text-green-700">
                    Marked paid {shortDate(batch.paidOn)} by {batch.paidByName ?? "—"}
                  </div>
                )}
                {batch.status === "cancelled" && (
                  <div className="text-[12.5px] text-gray-500">
                    Cancelled by {batch.cancelledByName ?? "—"}: {batch.cancelReason}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[13px] text-gray-600">
                  {live.length} {live.length === 1 ? "transfer" : "transfers"} ·{" "}
                  <strong className="tabular-nums">{formatMoney(liveTotal)}</strong>
                </span>
                <button onClick={onClose} aria-label="Close" className="text-2xl leading-none text-gray-400 hover:text-gray-700">
                  ×
                </button>
              </div>
            </div>

            {message && <p className="border-b bg-green-50 px-5 py-2 text-[13px] text-green-800 sm:px-6">{message}</p>}

            <div className="overflow-x-auto px-5 py-3 sm:px-6">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="w-7 py-1.5" />
                    <th className="py-1.5 text-left font-semibold">Vendor</th>
                    <th className="py-1.5 text-left font-semibold">Document</th>
                    <th className="py-1.5 text-left font-semibold">Item &amp; Desc</th>
                    <th className="py-1.5 text-left font-semibold">Date</th>
                    <th className="py-1.5 text-right font-semibold">Amount</th>
                    <th className="py-1.5 pl-4 text-left font-semibold">Paid to</th>
                    <th className="py-1.5 text-left font-semibold">In the books</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className={`border-b border-gray-100 align-top ${l.cancelledAt ? "text-gray-400" : ""}`}>
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={ticked.has(l.id)}
                          disabled={!cancellable(l)}
                          onChange={() =>
                            setTicked((t) => {
                              const next = new Set(t);
                              if (next.has(l.id)) next.delete(l.id);
                              else next.add(l.id);
                              return next;
                            })
                          }
                          title={cancellable(l) ? "Tick to cancel this transfer" : undefined}
                          className="accent-brand-500 disabled:opacity-30"
                        />
                      </td>
                      <td className="py-2 pr-3 font-medium">{l.vendorName}</td>
                      <td className="py-2 pr-3">
                        <Link href={docHref(l)} className="text-brand-700 hover:underline">
                          {kindLabel(l)} · {l.kind === "bill" ? l.billNumber : l.number}
                        </Link>
                        {l.kind === "bill" && l.billNumber !== l.number && (
                          <div className="text-[11px] text-gray-500">{l.number}</div>
                        )}
                        {l.kind === "advance" && (
                          <div className="text-[11px] text-gray-500">
                            on {l.purchaseOrderNumber}
                            {l.proformaNumber && ` · proforma ${l.proformaNumber}`}
                          </div>
                        )}
                        {l.kind === "bill" && l.purchaseOrderNumber && (
                          <div className="text-[11px] text-gray-500">on {l.purchaseOrderNumber}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="max-w-[16rem] truncate" title={l.description ?? ""}>
                          {l.description || "—"}
                        </div>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3">
                        {shortDate(l.documentDate)}
                        {l.dueDate && <div className="text-[11px] text-gray-500">due {shortDate(l.dueDate)}</div>}
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(l.amount)}</td>
                      <td className="py-2 pl-4 pr-3">
                        <div>{l.beneficiaryName}</div>
                        <div className="text-[11px] text-gray-500">
                          {l.accountNumber} · {l.ifsc} · {l.transferMode}
                        </div>
                      </td>
                      <td className="py-2">
                        {l.cancelledAt ? (
                          <span title={l.cancelReason ?? undefined}>Cancelled{l.cancelReason ? `: ${l.cancelReason}` : ""}</span>
                        ) : l.recordedAt ? (
                          l.paymentId ? (
                            <Link href={`/purchases/payments/${l.paymentId}`} className="text-green-700 hover:underline">
                              {l.paymentNumber}
                            </Link>
                          ) : (
                            <span className="text-green-700">Expense paid</span>
                          )
                        ) : (
                          <span className="text-gray-500">Not yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {step && (
              <div className="border-t bg-gray-50 px-5 py-3 sm:px-6">
                {step.kind === "markPaid" ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <label className="label-required">Paid on *</label>
                      <DateInput value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="input" />
                    </div>
                    <p className="max-w-xl text-[12.5px] text-gray-600">
                      Records {waiting.length} {waiting.length === 1 ? "transfer" : "transfers"} as paid from{" "}
                      {batch.bankAccountName}: a payment against each bill, a payment held as an advance for each
                      advance, and each expense marked paid. Only once the bank has confirmed them.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[18rem] flex-1">
                      <label className="label-required">Reason *</label>
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Never uploaded, bounced on IFSC…"
                        className="input"
                        autoFocus
                      />
                    </div>
                    <p className="max-w-md text-[12.5px] text-gray-600">
                      {step.kind === "cancelBatch"
                        ? `Every transfer in ${batch.number} goes back to To pay or Advances.`
                        : `${tickedLines.length} ${tickedLines.length === 1 ? "transfer goes" : "transfers go"} back to To pay or Advances.`}{" "}
                      Only if the bank has not paid them — a transfer that went through, sent again, is paid twice.
                    </p>
                  </div>
                )}
              </div>
            )}

            {actionError && <p className="border-t bg-red-50 px-5 py-2 text-[13px] text-red-700 sm:px-6">{actionError}</p>}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 sm:px-6">
              <div className="flex items-center gap-2">
                {batch.status === "sent" && !step && (
                  <>
                    <button
                      onClick={() => setStep({ kind: "cancelLines" })}
                      disabled={ticked.size === 0}
                      className="btn-secondary disabled:opacity-50"
                    >
                      Cancel transfers{ticked.size ? ` (${ticked.size})` : ""}
                    </button>
                    {!live.some((l) => l.recordedAt) && (
                      <button onClick={() => setStep({ kind: "cancelBatch" })} className="btn-secondary">
                        Cancel batch
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {step ? (
                  <>
                    <button onClick={() => setStep(null)} className="btn-secondary">
                      Back
                    </button>
                    {step.kind === "markPaid" ? (
                      <button
                        disabled={busy || !paymentDate}
                        onClick={() =>
                          run(async () => {
                            const r = await api<{ recorded: number; payments: string[] }>(
                              `/api/purchases/payment-batches/${batch.id}/mark-paid`,
                              { method: "POST", body: { paymentDate } },
                            );
                            return `${batch.number} is paid: ${r.recorded} ${r.recorded === 1 ? "transfer" : "transfers"} recorded${
                              r.payments.length ? ` (${r.payments[0]}${r.payments.length > 1 ? ` … ${r.payments[r.payments.length - 1]}` : ""})` : ""
                            }.`;
                          })
                        }
                        className="btn-primary"
                      >
                        {busy ? "Recording…" : "Mark paid"}
                      </button>
                    ) : (
                      <button
                        disabled={busy || !reason.trim()}
                        onClick={() =>
                          run(async () => {
                            if (step.kind === "cancelBatch") {
                              await api(`/api/purchases/payment-batches/${batch.id}/cancel`, {
                                method: "POST",
                                body: { reason },
                              });
                              return `${batch.number} is cancelled.`;
                            }
                            await api("/api/purchases/payment-batch-lines/cancel", {
                              method: "POST",
                              body: { reason, lineIds: tickedLines.map((l) => l.id) },
                            });
                            return `${tickedLines.length} ${tickedLines.length === 1 ? "transfer" : "transfers"} cancelled.`;
                          })
                        }
                        className="btn-primary"
                      >
                        {busy ? "Cancelling…" : step.kind === "cancelBatch" ? "Cancel batch" : "Cancel transfers"}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {batch.status !== "cancelled" && live.length > 0 && (
                      <DownloadButton batch={batch} className="btn-secondary" />
                    )}
                    {batch.status === "sent" && waiting.length > 0 && (
                      <button onClick={() => setStep({ kind: "markPaid" })} className="btn-primary">
                        Mark paid
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
