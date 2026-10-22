/**
 * A payment row's "…" on an invoice or a bill, and Zoho's "Delete Recorded
 * Payment?" behind it.
 *
 * Zoho asks which delete is meant, because from a document there are two:
 * take the payment off this document and keep the money as the party's
 * credit, or delete the payment entirely. The first is a dissociate — the
 * payment stays, unapplied — and the second is the same delete the payments
 * screens use, which reopens every document the payment touched. Each is
 * refused on the server where niko refuses it (a locked period; a payment
 * matched in Banking cannot be deleted), and the reason is shown here.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, formatMoney } from "../api";

export function PaymentRowMenu({
  editHref,
  canEdit,
  canDelete,
  onDelete,
}: {
  editHref: string;
  canEdit: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!canEdit && !canDelete) return null;
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-label="More"
        onClick={() => setOpen((v) => !v)}
        className="rounded px-1.5 text-[15px] leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-800"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-32 rounded-md border border-[#ebeaf2] bg-white py-1 text-left text-[13px] shadow-lg">
          {canEdit && (
            <Link href={editHref} className="block px-3 py-1.5 text-gray-700 hover:bg-[#408dfb] hover:text-white">
              Edit
            </Link>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="block w-full px-3 py-1.5 text-left text-gray-700 hover:bg-[#408dfb] hover:text-white"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DeletePaymentDialog({
  side,
  documentId,
  payment,
  canDissociate,
  canDelete,
  onClose,
}: {
  side: "customer" | "vendor";
  documentId: string;
  payment: { paymentId: string; paymentNumber: string; amountApplied: string };
  canDissociate: boolean;
  canDelete: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const one = side === "customer" ? "invoice" : "bill";
  const party = side === "customer" ? "customer" : "vendor";
  const base = side === "customer" ? "/api/sales" : "/api/purchases";

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [busy, onClose]);

  const run = async (how: "dissociate" | "delete") => {
    setBusy(true);
    setError(null);
    try {
      if (how === "dissociate") {
        await api(`${base}/${side === "customer" ? "invoices" : "bills"}/${documentId}/payments/${payment.paymentId}/dissociate`, {
          method: "POST",
          body: {},
        });
      } else {
        await api(`${base}/payments/${payment.paymentId}`, { method: "DELETE" });
      }
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Could not delete the payment");
      setBusy(false);
    }
  };

  const option = (label: string, how: "dissociate" | "delete", allowed: boolean) => (
    <button
      type="button"
      disabled={busy || !allowed}
      title={allowed ? undefined : "You do not have permission to do this"}
      onClick={() => run(how)}
      className="mb-4 flex w-full items-center justify-between rounded-[10px] bg-[#f3f8fe] p-[15px] text-left text-[15px] text-[#212529] hover:bg-[#e6f0fd] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
      <span className="text-[#408dfb]">›</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-3">
      <div role="dialog" aria-label="Delete Recorded Payment?" className="w-full max-w-[500px] rounded-b-lg bg-white shadow-xl">
        <div className="flex items-center justify-between rounded-t-[5.5px] bg-[#f9f9fb] px-5 py-3">
          <h4 className="text-[17px] font-normal text-[#212529]">Delete Recorded Payment?</h4>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-2xl leading-none text-gray-500 hover:text-gray-800"
          >
            ×
          </button>
        </div>
        <div className="px-5 pt-4">
          <div className="mb-4 flex gap-3 text-[13px] leading-[1.6] text-[#212529]">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[#f59e0b] text-[15px] font-bold text-[#f59e0b]">
              !
            </span>
            <p>
              You&apos;re deleting a payment of {formatMoney(payment.amountApplied)}. You can either dissociate this
              payment from this {one} and add it as a credit to the {party} or you can delete this payment entirely.
            </p>
          </div>
          {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}
          {option("Dissociate & Add As Credit", "dissociate", canDissociate)}
          {option("Delete Payment", "delete", canDelete)}
        </div>
      </div>
    </div>
  );
}
