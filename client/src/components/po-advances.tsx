import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, formatDate, formatMoney } from "../api";
import { AttachmentsButton, AttachmentsPanel } from "./attachments";
import { DateInput } from "./date-input";

/**
 * Advances against a purchase order (docs/vendor-advances-and-batches-plan.md).
 *
 * The vendor sends a proforma and wants paying before the goods: somebody
 * raises an advance request on the order, with the proforma attached, and it
 * waits on the Vendor Sheet's Advances tab to go to the bank like a bill. Once
 * the batch is marked paid it is a vendor payment held as an advance, and the
 * order's bill picks it up in Apply Credits.
 */

export interface AdvanceOrder {
  id: string;
  number: string;
  orderDate: string;
  total: string;
  vendorId: string;
  vendorName: string;
  /** Open and paid advances on it already. */
  advanced: string;
}

interface OrderAdvance {
  id: string;
  number: string;
  amount: string;
  proformaNumber: string | null;
  proformaDate: string | null;
  notes: string | null;
  status: "open" | "paid" | "cancelled";
  createdAt: string;
  createdByName: string | null;
  cancelReason: string | null;
  vendorPaymentId: string | null;
  paymentNumber: string | null;
  paymentDate: string | null;
  unapplied: string | null;
  sentBatchId: string | null;
  sentBatchNumber: string | null;
}

const ENTITY = "vendor_advance_request";

/**
 * Ask for an advance. With `order` given it is for that order (the PO's own
 * Request Advance); without, the order is picked from those still open. Once
 * made, the same dialog takes the proforma, through the one attachments panel.
 */
export function NewAdvanceDialog({
  order,
  onClose,
  onCreated,
}: {
  order?: { id: string; number: string; vendorName: string; total: string };
  onClose: () => void;
  onCreated?: () => void;
}) {
  const qc = useQueryClient();
  const { data: orders } = useQuery({
    queryKey: ["/api/purchases/advances/orders"],
    queryFn: () => api<AdvanceOrder[]>("/api/purchases/advances/orders"),
  });
  const [orderId, setOrderId] = useState(order?.id ?? "");
  const [filter, setFilter] = useState("");
  const [amount, setAmount] = useState("");
  const [proformaNumber, setProformaNumber] = useState("");
  const [proformaDate, setProformaDate] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; number: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (created ? done() : onClose());
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const picked = orders?.find((o) => o.id === orderId);
  const room = picked ? Number(picked.total) - Number(picked.advanced) : null;
  const shown = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return (orders ?? []).filter(
      (o) => !t || o.number.toLowerCase().includes(t) || o.vendorName.toLowerCase().includes(t),
    );
  }, [orders, filter]);

  const done = () => {
    void qc.invalidateQueries({ queryKey: ["/api/purchases/payables"] });
    void qc.invalidateQueries({ queryKey: ["po-advances"] });
    void qc.invalidateQueries({ queryKey: ["/api/purchases/advances/orders"] });
    onCreated?.();
    onClose();
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string; number: string }>("/api/purchases/advances", {
        method: "POST",
        body: {
          purchaseOrderId: orderId,
          amount: Number(amount).toFixed(2),
          proformaNumber: proformaNumber.trim() || undefined,
          proformaDate: proformaDate || undefined,
          notes: notes.trim() || undefined,
        },
      });
      setCreated(r);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not save the advance");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-12">
      <div className="fixed inset-0 bg-black/40" onClick={created ? done : onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-lg border bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-gray-800">
          {created ? `${created.number} — attach the proforma` : "New advance"}
        </h2>
        {created ? (
          <>
            <p className="mt-1 text-[12.5px] text-gray-500">
              The advance is on the Vendor Sheet&apos;s Advances tab, ready to send to the bank. Attach the
              vendor&apos;s proforma here.
            </p>
            <div className="mt-3">
              <AttachmentsPanel entityType={ENTITY} entityId={created.id} />
            </div>
            <div className="mt-5 flex justify-end">
              <button onClick={done} className="btn-primary">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-4 grid gap-3">
              <div>
                <label className="label-required">Purchase order *</label>
                {order ? (
                  <div className="input flex items-center bg-gray-50 text-gray-700">
                    {order.number} · {order.vendorName} · {formatMoney(order.total)}
                  </div>
                ) : (
                  <>
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Search by PO# or vendor"
                      className="input mb-1"
                    />
                    <select
                      value={orderId}
                      onChange={(e) => setOrderId(e.target.value)}
                      size={6}
                      className="input h-auto py-1"
                    >
                      {shown.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.number} · {o.vendorName} · {formatMoney(o.total)}
                          {Number(o.advanced) > 0 ? ` (advanced ${formatMoney(o.advanced)})` : ""}
                        </option>
                      ))}
                    </select>
                    {orders && !orders.length && (
                      <p className="mt-1 text-[12px] text-gray-500">No issued purchase order is waiting for its bill.</p>
                    )}
                  </>
                )}
                {room !== null && (
                  <p className="mt-1 text-[12px] text-gray-500">
                    Up to {formatMoney(room)} can still be asked for on {picked!.number}.
                  </p>
                )}
              </div>
              <div>
                <label className="label-required">Amount *</label>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="input text-right tabular-nums"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Proforma#</label>
                  <input value={proformaNumber} onChange={(e) => setProformaNumber(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="label">Proforma date</label>
                  <DateInput value={proformaDate} onChange={(e) => setProformaDate(e.target.value)} className="input" />
                </div>
              </div>
              <div>
                <label className="label">Notes</label>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. 50% before dispatch"
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
                onClick={save}
                disabled={busy || !orderId || !(Number(amount) > 0)}
                className="btn-primary"
              >
                {busy ? "Saving…" : "Save and attach proforma"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Withdraw an advance nobody will pay; it is kept, marked, with the reason. */
export function CancelAdvanceDialog({
  advance,
  onClose,
  onDone,
}: {
  advance: { id: string; number: string; amount: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/purchases/advances/${advance.id}/cancel`, { method: "POST", body: { reason } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel");
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-lg border bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-gray-800">Cancel {advance.number}</h2>
        <p className="mt-1 text-[12.5px] text-gray-500">{formatMoney(advance.amount)} — it stays on record, marked cancelled.</p>
        <div className="mt-3">
          <label className="label-required">Reason *</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Vendor withdrew the proforma…"
            className="input"
            autoFocus
          />
        </div>
        {error && <p className="mt-3 text-[12.5px] text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            Keep
          </button>
          <button onClick={submit} disabled={busy || !reason.trim()} className="btn-primary">
            {busy ? "Cancelling…" : "Cancel advance"}
          </button>
        </div>
      </div>
    </div>
  );
}

const statusOf = (a: OrderAdvance) =>
  a.status === "paid"
    ? { label: `Paid · ${a.paymentNumber ?? ""}`, tone: "text-green-700 bg-green-50" }
    : a.status === "cancelled"
      ? { label: "Cancelled", tone: "text-gray-500 bg-gray-100" }
      : a.sentBatchNumber
        ? { label: `Sent · ${a.sentBatchNumber}`, tone: "text-brand-700 bg-brand-50" }
        : { label: "Waiting to send", tone: "text-amber-800 bg-amber-50" };

/**
 * The strip on a purchase order: its advances, where each has got to, and a
 * Request Advance button while the order can still take one.
 */
export function PurchaseOrderAdvances({
  order,
}: {
  order: { id: string; number: string; status: string; vendorName: string; total: string };
}) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [cancelling, setCancelling] = useState<OrderAdvance | null>(null);
  const { data } = useQuery({
    queryKey: ["po-advances", order.id],
    queryFn: () => api<OrderAdvance[]>(`/api/purchases/orders/${order.id}/advances`),
  });
  const canAsk = order.status === "issued" || order.status === "partially_billed";
  const advances = data ?? [];
  if (!canAsk && !advances.length) return null;

  return (
    <div className="border-b bg-white px-6 py-2.5 text-[13px] print:hidden">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-gray-700">
          Advances
          {advances.length > 0 && (
            <span className="ml-2 font-normal text-gray-500">
              {formatMoney(
                advances.filter((a) => a.status !== "cancelled").reduce((s, a) => s + Number(a.amount), 0),
              )}{" "}
              of {formatMoney(order.total)}
            </span>
          )}
        </span>
        {canAsk && (
          <button
            onClick={() => setAsking(true)}
            className="rounded px-2.5 py-1 font-medium text-brand-700 hover:bg-brand-50"
          >
            Request Advance
          </button>
        )}
      </div>
      {advances.length > 0 && (
        <table className="mt-1.5 w-full text-[12.5px]">
          <tbody>
            {advances.map((a) => {
              const st = statusOf(a);
              return (
                <tr key={a.id} className="border-t border-gray-100">
                  <td className="py-1.5 pr-3 font-medium text-gray-800">{a.number}</td>
                  <td className="py-1.5 pr-3 text-gray-600">
                    {a.proformaNumber ? `Proforma ${a.proformaNumber}` : "No proforma#"}
                    {a.proformaDate && ` · ${formatDate(a.proformaDate)}`}
                    {a.notes && <span className="text-gray-400"> · {a.notes}</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatMoney(a.amount)}</td>
                  <td className="py-1.5 pr-3">
                    <span className={`rounded px-1.5 py-0.5 text-[11.5px] ${st.tone}`} title={a.cancelReason ?? undefined}>
                      {st.label}
                    </span>
                    {a.status === "paid" && a.unapplied && Number(a.unapplied) > 0 && (
                      <span className="ml-2 text-[11.5px] text-gray-500">
                        {formatMoney(a.unapplied)} not yet on a bill
                      </span>
                    )}
                  </td>
                  <td className="w-20 py-1 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <AttachmentsButton entityType={ENTITY} entityId={a.id} />
                      {a.status === "open" && !a.sentBatchId && (
                        <button
                          onClick={() => setCancelling(a)}
                          className="text-[12px] text-gray-400 hover:text-red-600"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {asking && (
        <NewAdvanceDialog
          order={{ id: order.id, number: order.number, vendorName: order.vendorName, total: order.total }}
          onClose={() => setAsking(false)}
        />
      )}
      {cancelling && (
        <CancelAdvanceDialog
          advance={cancelling}
          onClose={() => setCancelling(null)}
          onDone={async () => {
            setCancelling(null);
            await qc.invalidateQueries({ queryKey: ["po-advances", order.id] });
            await qc.invalidateQueries({ queryKey: ["/api/purchases/payables"] });
          }}
        />
      )}
    </div>
  );
}
