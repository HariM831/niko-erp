import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatMoney } from "../api";
import { useAuth } from "../auth";
import { DateInput } from "../components/date-input";
import { shortDate } from "./documents";
import { localYmd } from "../lib/utils";

/**
 * Freight agreed on a PO and paid to the transporter by us (22 Oct 2026).
 *
 * Every truck settled against such a PO is owed here until a payment clears
 * it. Transporters are not vendors: a payment names who was paid in words,
 * picks the trucks it covers, and comes out of a bank account.
 */
interface Charge {
  id: string;
  chargeDate: string;
  vehicleNumber: string | null;
  basis: "per_ton" | "per_truck";
  rate: string;
  quantityKg: string | null;
  amount: string;
  billId: string;
  billNumber: string;
  purchaseOrderId: string;
  poNumber: string;
  vendorName: string;
  receiptId: string | null;
  receiptNumber: string | null;
  paymentId: string | null;
  paymentNumber: string | null;
  paymentDate: string | null;
}
interface Payment {
  id: string;
  number: string;
  paymentDate: string;
  amount: string;
  transporter: string | null;
  reference: string | null;
  notes: string | null;
  bankAccountName: string | null;
  trucks: string | null;
}

const terms = (c: Charge) =>
  c.basis === "per_ton"
    ? `₹${Number(c.rate).toLocaleString("en-IN")}/t × ${(Number(c.quantityKg) / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 })} t`
    : `₹${Number(c.rate).toLocaleString("en-IN")} a truck`;

export function FreightPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"owed" | "payments">("owed");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);

  const { data: owed = [], isLoading } = useQuery({
    queryKey: ["freight", "owed"],
    queryFn: () => api<Charge[]>("/api/purchases/freight?status=owed"),
  });
  const { data: payments = [] } = useQuery({
    queryKey: ["freight", "payments"],
    queryFn: () => api<Payment[]>("/api/purchases/freight/payments"),
    enabled: tab === "payments",
  });

  const owedTotal = owed.reduce((s, c) => s + Number(c.amount), 0);
  const pickedRows = owed.filter((c) => picked.has(c.id));
  const pickedTotal = pickedRows.reduce((s, c) => s + Number(c.amount), 0);
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const remove = async (p: Payment) => {
    if (!confirm(`Delete ${p.number}? Its trucks will be owed again.`)) return;
    try {
      await api(`/api/purchases/freight/payments/${p.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["freight"] });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not delete the payment");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-6 py-2.5">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-semibold">Freight</h1>
          <div className="flex gap-1 text-[13px]">
            {(["owed", "payments"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 ${tab === t ? "bg-brand-50 font-semibold text-brand-700" : "text-gray-500 hover:bg-gray-100"}`}
              >
                {t === "owed" ? `Owed (${owed.length})` : "Payments"}
              </button>
            ))}
          </div>
        </div>
        {tab === "owed" && can("purchases", "create") && (
          <button onClick={() => setPaying(true)} disabled={!pickedRows.length} className="btn-primary">
            {pickedRows.length ? `Pay ${pickedRows.length} truck${pickedRows.length > 1 ? "s" : ""} · ${formatMoney(pickedTotal)}` : "Pick trucks to pay"}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === "owed" ? (
          <>
            <p className="mb-3 text-[13px] text-gray-500">
              Freight on the trucks settled against a PO with freight terms. It is already in the material's cost; this is
              what the transporters are still to be paid —{" "}
              <strong className="tabular-nums text-gray-800">{formatMoney(owedTotal)}</strong> in all.
            </p>
            {isLoading ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : !owed.length ? (
              <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[13px] text-gray-400">
                No freight owed.
              </p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="table-head">
                  <tr>
                    <th className="w-8 border-b border-[#ece3d5] px-3 py-2">
                      <input
                        type="checkbox"
                        checked={picked.size === owed.length}
                        onChange={(e) => setPicked(e.target.checked ? new Set(owed.map((c) => c.id)) : new Set())}
                      />
                    </th>
                    <th className="border-b border-[#ece3d5] px-3 py-2">Date</th>
                    <th className="border-b border-[#ece3d5] px-3 py-2">Truck</th>
                    <th className="border-b border-[#ece3d5] px-3 py-2">Vendor</th>
                    <th className="border-b border-[#ece3d5] px-3 py-2">PO</th>
                    <th className="border-b border-[#ece3d5] px-3 py-2">Bill</th>
                    <th className="border-b border-[#ece3d5] px-3 py-2">Terms</th>
                    <th className="border-b border-[#ece3d5] px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {owed.map((c) => (
                    <tr key={c.id} className="border-b border-[#ece3d5] hover:bg-gray-50" onClick={() => toggle(c.id)}>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} onClick={(e) => e.stopPropagation()} />
                      </td>
                      <td className="px-3 py-2">{shortDate(c.chargeDate)}</td>
                      <td className="px-3 py-2 font-medium">
                        {c.vehicleNumber ?? "—"}
                        {c.receiptNumber && <div className="text-[11.5px] font-normal text-gray-500">{c.receiptNumber}</div>}
                      </td>
                      <td className="px-3 py-2">{c.vendorName}</td>
                      <td className="px-3 py-2">
                        <Link href={`/purchases/orders/${c.purchaseOrderId}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline">
                          {c.poNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/purchases/bills/${c.billId}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline">
                          {c.billNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{terms(c)}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : !payments.length ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[13px] text-gray-400">
            No freight paid yet.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="table-head">
              <tr>
                <th className="border-b border-[#ece3d5] px-3 py-2">Number</th>
                <th className="border-b border-[#ece3d5] px-3 py-2">Date</th>
                <th className="border-b border-[#ece3d5] px-3 py-2">Paid to</th>
                <th className="border-b border-[#ece3d5] px-3 py-2">Trucks</th>
                <th className="border-b border-[#ece3d5] px-3 py-2">From</th>
                <th className="border-b border-[#ece3d5] px-3 py-2">Reference</th>
                <th className="border-b border-[#ece3d5] px-3 py-2 text-right">Amount</th>
                <th className="border-b border-[#ece3d5] px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-[#ece3d5]">
                  <td className="px-3 py-2 font-medium">{p.number}</td>
                  <td className="px-3 py-2">{shortDate(p.paymentDate)}</td>
                  <td className="px-3 py-2">{p.transporter ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-600">{p.trucks ?? "—"}</td>
                  <td className="px-3 py-2">{p.bankAccountName ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-600">{p.reference ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(p.amount)}</td>
                  <td className="px-3 py-2 text-right">
                    {can("purchases", "delete") && (
                      <button onClick={() => void remove(p)} className="text-[12px] text-gray-400 hover:text-red-600">
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {paying && (
        <PayFreightDialog
          charges={pickedRows}
          onClose={() => setPaying(false)}
          onDone={async () => {
            setPaying(false);
            setPicked(new Set());
            await qc.invalidateQueries({ queryKey: ["freight"] });
          }}
        />
      )}
    </div>
  );
}

function PayFreightDialog({ charges, onClose, onDone }: { charges: Charge[]; onClose: () => void; onDone: () => void }) {
  const { data: banks = [] } = useQuery({
    queryKey: ["bank-accounts"],
    queryFn: () => api<Array<{ id: string; name: string }>>("/api/banking/accounts"),
  });
  const [paymentDate, setPaymentDate] = useState(localYmd());
  const [bankAccountId, setBankAccountId] = useState("");
  const [transporter, setTransporter] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = useMemo(() => charges.reduce((s, c) => s + Number(c.amount), 0), [charges]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/purchases/freight/payments", {
        method: "POST",
        body: {
          chargeIds: charges.map((c) => c.id),
          paymentDate,
          bankAccountId,
          transporter: transporter.trim() || undefined,
          reference: reference.trim() || undefined,
          notes: notes.trim() || undefined,
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the payment");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-lg border bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-gray-800">Pay freight · {formatMoney(total)}</h2>
        <p className="mt-1 text-[12.5px] text-gray-500">
          {charges.map((c) => c.vehicleNumber ?? c.billNumber).join(", ")}
        </p>
        <div className="mt-4 grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label-required">Payment date *</label>
              <DateInput value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label-required">Paid from *</label>
              <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className="input">
                <option value="">Choose an account</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Paid to</label>
            <input value={transporter} onChange={(e) => setTransporter(e.target.value)} placeholder="Transporter's name" className="input" />
          </div>
          <div>
            <label className="label">Reference</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / NEFT reference" className="input" />
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input" />
          </div>
        </div>
        {error && <p className="mt-3 text-[12.5px] text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button onClick={save} disabled={busy || !bankAccountId || !paymentDate} className="btn-primary">
            {busy ? "Saving…" : "Record payment"}
          </button>
        </div>
      </div>
    </div>
  );
}
