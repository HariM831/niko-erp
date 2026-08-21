/**
 * Goods Receipts — the record a truck creates when it arrives.
 *
 * Create and delete live here so the whole record can be exercised before the
 * six station screens exist. Deleting hands the number back to the series, so
 * testing leaves the counter where it started.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { StatusBadge } from "../components/status-badge";
import type { LineMatch } from "@shared/po-match-types";
import { Modal } from "../components/settings-ui";

interface ReceiptRow {
  id: string;
  number: string;
  status: string;
  vehicleNumber: string;
  vendorName: string | null;
  vendorBillNumber: string | null;
  arrivalAt: string;
  locationName: string | null;
  lineCount: number;
  billQuantityKg: string;
}

interface Context {
  locations: Array<{ id: string; name: string; code: string }>;
  vendors: Array<{ id: string; name: string }>;
  items: Array<{ id: string; name: string; unit: string; hsnOrSac: string | null }>;
}

interface LineDraft {
  /** Present when editing an existing line. */
  id?: string;
  itemId: string;
  itemName: string;
  billQuantityKg: string;
  billRatePerKg: string;
  billBagCount: string;
  qcVerdict: string;
  qcMoisturePct: string;
  qcRejectionReason: string;
  bagCountActual: string;
  damagePercent: string;
  allocatedNetKg: string;
}

const emptyLine = (): LineDraft => ({
  itemId: "",
  itemName: "",
  billQuantityKg: "",
  billRatePerKg: "",
  billBagCount: "",
  qcVerdict: "",
  qcMoisturePct: "",
  qcRejectionReason: "",
  bagCountActual: "",
  damagePercent: "",
  allocatedNetKg: "",
});

/** The full receipt as the detail endpoint returns it. */
interface Receipt {
  id: string;
  number: string;
  status: string;
  locationId: string | null;
  vendorId: string | null;
  vehicleNumber: string;
  vendorBillNumber: string | null;
  vendorBillDate: string | null;
  billTotalAmount: string | null;
  billTaxAmount: string | null;
  vendorSlipGrossKg: string | null;
  grossWeightKg: string | null;
  tareWeightKg: string | null;
  shortageReason: string | null;
  lines: Array<{
    id: string;
    itemId: string | null;
    itemName: string | null;
    billQuantityKg: string;
    billRatePerKg: string | null;
    billBagCount: number | null;
    qcVerdict: string | null;
    qcMoisturePct: string | null;
    qcRejectionReason: string | null;
    bagCountActual: number | null;
    damagePercent: string | null;
    allocatedNetKg: string | null;
  }>;
}

/** A quiet heading between the station groups. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
      {children}
    </div>
  );
}

const kg = (v: string | null) =>
  v == null ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The whole receipt on one screen.
 *
 * The six station screens exist for six people who never speak to each other.
 * This is for the opposite case: one person, at a desk, with the paperwork for
 * a truck that already came and went — a delivery logged the next morning, or
 * a correction to something keyed wrong.
 *
 * So every field any station writes is here, in station order, and the status
 * follows from what has been filled in rather than from a button. Editing
 * keeps the receipt's number: a goods receipt number is quoted on the bill it
 * becomes, so it is never reissued.
 */
function ReceiptEditor({
  ctx,
  receiptId,
  onClose,
}: {
  ctx: Context;
  receiptId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const editing = !!receiptId;

  const { data: existing } = useQuery<Receipt>({
    queryKey: ["office", "receipt", receiptId],
    queryFn: () => api(`/api/office/receipts/${receiptId}`),
    enabled: editing,
  });

  const [locationId, setLocationId] = useState(ctx.locations[0]?.id ?? "");
  const [vendorId, setVendorId] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(new Date().toISOString().slice(0, 10));
  const [billTotal, setBillTotal] = useState("");
  const [billTax, setBillTax] = useState("");
  const [decision, setDecision] = useState<"allow" | "turn_away">("allow");
  const [exitReason, setExitReason] = useState("");
  const [slipGross, setSlipGross] = useState("");
  const [gross, setGross] = useState("");
  const [tare, setTare] = useState("");
  const [shortageReason, setShortageReason] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [matches, setMatches] = useState<LineMatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load an existing receipt into the form once.
  useEffect(() => {
    if (!existing) return;
    setLocationId(existing.locationId ?? ctx.locations[0]?.id ?? "");
    setVendorId(existing.vendorId ?? "");
    setVehicleNumber(existing.vehicleNumber ?? "");
    setBillNumber(existing.vendorBillNumber ?? "");
    setBillDate(existing.vendorBillDate ?? new Date().toISOString().slice(0, 10));
    setBillTotal(existing.billTotalAmount ?? "");
    setBillTax(existing.billTaxAmount ?? "");
    setSlipGross(existing.vendorSlipGrossKg ?? "");
    setGross(existing.grossWeightKg ?? "");
    setTare(existing.tareWeightKg ?? "");
    setShortageReason(existing.shortageReason ?? "");
    setLines(
      existing.lines.map((l) => ({
        id: l.id,
        itemId: l.itemId ?? "",
        itemName: l.itemName ?? "",
        billQuantityKg: l.billQuantityKg ?? "",
        billRatePerKg: l.billRatePerKg ?? "",
        billBagCount: l.billBagCount != null ? String(l.billBagCount) : "",
        qcVerdict: l.qcVerdict === "rejected" ? "rejected" : l.qcVerdict ? "pass" : "",
        qcMoisturePct: l.qcMoisturePct ?? "",
        qcRejectionReason: l.qcRejectionReason ?? "",
        bagCountActual: l.bagCountActual != null ? String(l.bagCountActual) : "",
        damagePercent: l.damagePercent ?? "",
        allocatedNetKg: l.allocatedNetKg ?? "",
      })),
    );
  }, [existing, ctx.locations]);

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const usable = lines.filter((l) => l.itemName.trim() && Number(l.billQuantityKg) > 0);
  const totalKg = usable.reduce((s, l) => s + Number(l.billQuantityKg), 0);
  const totalValue = usable.reduce(
    (s, l) => s + Number(l.billQuantityKg) * (Number(l.billRatePerKg) || 0),
    0,
  );
  const net = gross && tare ? Number(gross) - Number(tare) : null;

  /** Pro rata across whatever is not rejected, mirroring the server. */
  const suggestAllocation = () => {
    if (net == null || net <= 0) return;
    const taking = lines.filter((l) => l.qcVerdict !== "rejected" && Number(l.billQuantityKg) > 0);
    const billed = taking.reduce((s, l) => s + Number(l.billQuantityKg), 0);
    if (!billed) return;
    setLines((ls) =>
      ls.map((l) =>
        l.qcVerdict === "rejected" || !Number(l.billQuantityKg)
          ? { ...l, allocatedNetKg: "" }
          : { ...l, allocatedNetKg: ((net * Number(l.billQuantityKg)) / billed).toFixed(3) },
      ),
    );
  };

  /**
   * Attach each line to an open order, the same hard match the gate applies.
   *
   * Without this a receipt keyed by hand can never be settled — V22 refuses to
   * raise a payable for a line with no order behind it, and the manual form
   * would have no way to supply one.
   */
  useEffect(() => {
    if (!vendorId || !usable.length) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ matches: LineMatch[] }>("/api/office/match-po-lines", {
        method: "POST",
        body: {
          vendorId,
          billDate: billDate || null,
          lines: usable.map((l) => ({
            itemId: l.itemId || null,
            itemName: l.itemName || null,
            quantityKg: Number(l.billQuantityKg) || null,
            ratePerKg: Number(l.billRatePerKg) || null,
          })),
        },
      })
        .then((r) => setMatches(r.matches))
        .catch(() => setMatches([]));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, billDate, JSON.stringify(usable)]);

  const linePayload = () =>
    usable.map((l, i) => ({
      id: l.id || undefined,
      purchaseOrderId: matches[i]?.chosen?.purchaseOrderId ?? null,
      poLineId: matches[i]?.chosen?.poLineId ?? null,
      itemId: l.itemId || null,
      itemName: l.itemName.trim(),
      billQuantityKg: l.billQuantityKg,
      billRatePerKg: l.billRatePerKg || null,
      billBagCount: l.billBagCount ? Number(l.billBagCount) : null,
      qcVerdict: l.qcVerdict || null,
      qcMoisturePct: l.qcMoisturePct ? Number(l.qcMoisturePct) : null,
      qcRejectionReason: l.qcRejectionReason || null,
      bagCountActual: l.bagCountActual ? Number(l.bagCountActual) : null,
      damagePercent: l.damagePercent ? Number(l.damagePercent) : null,
      allocatedNetKg: l.allocatedNetKg || null,
    }));

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api(`/api/office/receipts/${receiptId}`, {
            method: "PATCH",
            body: {
              vendorId: vendorId || null,
              vehicleNumber,
              vendorBillNumber: billNumber || null,
              vendorBillDate: billDate || null,
              billTotalAmount: billTotal || null,
              billTaxAmount: billTax || null,
              vendorSlipGrossKg: slipGross || null,
              grossWeightKg: gross || null,
              tareWeightKg: tare || null,
              shortageReason: shortageReason || null,
              lines: linePayload(),
            },
          })
        : api("/api/office/receipts", {
            method: "POST",
            body: {
              locationId,
              vendorId: vendorId || undefined,
              vehicleNumber,
              decision,
              exitReason: decision === "turn_away" ? exitReason : undefined,
              vendorBillNumber: billNumber || undefined,
              vendorBillDate: billDate || undefined,
              billTotalAmount: billTotal || undefined,
              billTaxAmount: billTax || undefined,
              deviceCapturedAt: new Date().toISOString(),
              lines: usable.map((l, i) => ({
                purchaseOrderId: matches[i]?.chosen?.purchaseOrderId ?? undefined,
                poLineId: matches[i]?.chosen?.poLineId ?? undefined,
                itemId: l.itemId || undefined,
                itemName: l.itemName.trim(),
                billQuantityKg: l.billQuantityKg,
                billRatePerKg: l.billRatePerKg || undefined,
                billBagCount: l.billBagCount ? Number(l.billBagCount) : undefined,
              })),
            },
          }),
    onSuccess: async (created: unknown) => {
      // A direct entry is keyed complete in one pass, so the station fields go
      // straight back in the follow-up PATCH rather than making someone walk
      // the queues to record what already happened.
      const id = (created as { id?: string })?.id;
      const hasStationData = gross || tare || lines.some((l) => l.qcVerdict);
      if (!editing && id && decision === "allow" && hasStationData) {
        await api(`/api/office/receipts/${id}`, {
          method: "PATCH",
          body: {
            vendorSlipGrossKg: slipGross || null,
            grossWeightKg: gross || null,
            tareWeightKg: tare || null,
            shortageReason: shortageReason || null,
            lines: linePayload(),
          },
        }).catch(() => {
          /* the receipt exists; the stations can still be filled in by hand */
        });
      }
      void qc.invalidateQueries({ queryKey: ["office"] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save"),
  });

  const canSave =
    !!locationId &&
    vehicleNumber.trim().length >= 4 &&
    usable.length > 0 &&
    (decision === "allow" || exitReason.trim().length > 0);

  const settled = existing?.status === "settled";

  return (
    <Modal
      title={editing ? `Edit ${existing?.number ?? "receipt"}` : "New Goods Receipt"}
      onClose={onClose}
      width="w-[900px]"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => {
              setError(null);
              save.mutate();
            }}
            disabled={!canSave || save.isPending || settled}
            className="btn-primary"
          >
            {editing ? "Save changes" : decision === "turn_away" ? "Record turn-away" : "Allow in"}
          </button>
        </>
      }
    >
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}
      {settled && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          This receipt has been settled into a bill. Void the bill before correcting it.
        </div>
      )}

      <SectionLabel>At the gate</SectionLabel>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div>
          <label className="label-required">Site *</label>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            disabled={editing}
            className="input disabled:bg-gray-50"
          >
            {ctx.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-required">Vehicle number *</label>
          <input
            value={vehicleNumber}
            onChange={(e) => setVehicleNumber(e.target.value)}
            placeholder="AS 26 AC 1723"
            className="input"
          />
        </div>
        <div>
          <label className="label">Vendor</label>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="input">
            <option value="">Not identified yet</option>
            {ctx.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Vendor's bill number</label>
          <input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} className="input" />
        </div>
        <div>
          <label className="label">Bill date</label>
          <input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} className="input" />
        </div>
        <div>
          {/* Settlement spreads this across the lines and bills the all-in
              rate: we claim no input credit, so the vendor's tax is part of
              what the material cost. Blank on a bill of supply. */}
          <label className="label">GST on their bill</label>
          <input
            value={billTax}
            onChange={(e) => setBillTax(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="input text-right"
          />
        </div>
        <div>
          <label className="label">Bill grand total</label>
          <input
            value={billTotal}
            onChange={(e) => setBillTotal(e.target.value)}
            inputMode="decimal"
            className="input text-right"
          />
        </div>
        {!editing && (
          <div>
            <label className="label">Decision at the gate</label>
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as "allow" | "turn_away")}
              className="input"
            >
              <option value="allow">Allow in</option>
              <option value="turn_away">Turn away</option>
            </select>
          </div>
        )}
      </div>

      {decision === "turn_away" && !editing ? (
        <div className="mb-4">
          <label className="label-required">Why is it being turned away? *</label>
          <input value={exitReason} onChange={(e) => setExitReason(e.target.value)} className="input" />
          <p className="mt-1 text-[12px] text-gray-500">
            No weights are taken and no purchase order quantity is consumed.
          </p>
        </div>
      ) : (
        <>
          <SectionLabel>On the weighbridge</SectionLabel>
          <div className="mb-4 grid grid-cols-4 gap-3">
            <div>
              <label className="label">Their slip — gross</label>
              <input
                value={slipGross}
                onChange={(e) => setSlipGross(e.target.value)}
                inputMode="decimal"
                className="input text-right"
              />
            </div>
            <div>
              <label className="label">Our gross (kg)</label>
              <input
                value={gross}
                onChange={(e) => setGross(e.target.value)}
                inputMode="decimal"
                className="input text-right"
              />
            </div>
            <div>
              <label className="label">Our tare (kg)</label>
              <input
                value={tare}
                onChange={(e) => setTare(e.target.value)}
                inputMode="decimal"
                className="input text-right"
              />
            </div>
            <div>
              <label className="label">Net off the truck</label>
              <div className="input bg-gray-50 text-right tabular-nums">
                {net != null ? net.toLocaleString("en-IN") : "—"}
              </div>
            </div>
          </div>

          <div className="mb-1 flex items-baseline justify-between">
            <SectionLabel>Materials, quality and unloading</SectionLabel>
            {net != null && net > 0 && (
              <button className="btn-ghost text-[12px]" onClick={suggestAllocation}>
                Split net pro rata
              </button>
            )}
          </div>
          <table className="mb-2 w-full text-[12px]">
            <thead className="table-head">
              <tr>
                <th className="px-2 py-2 text-left">Material</th>
                <th className="w-24 px-1 py-2 text-right">Billed kg</th>
                <th className="w-20 px-1 py-2 text-right">Rate</th>
                <th className="w-16 px-1 py-2 text-right">Bags</th>
                <th className="w-24 px-1 py-2 text-center">QC</th>
                <th className="w-20 px-1 py-2 text-right">Moist %</th>
                <th className="w-20 px-1 py-2 text-right">Dmg %</th>
                <th className="w-24 px-1 py-2 text-right">Net kg</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="px-2 py-1">
                    <select
                      value={l.itemId}
                      onChange={(e) => {
                        const item = ctx.items.find((it) => it.id === e.target.value);
                        setLine(i, { itemId: e.target.value, itemName: item?.name ?? "" });
                      }}
                      className="input"
                    >
                      <option value="">Choose…</option>
                      {ctx.items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={l.billQuantityKg}
                      onChange={(e) => setLine(i, { billQuantityKg: e.target.value })}
                      className="input text-right"
                      inputMode="decimal"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={l.billRatePerKg}
                      onChange={(e) => setLine(i, { billRatePerKg: e.target.value })}
                      className="input text-right"
                      inputMode="decimal"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={l.billBagCount}
                      onChange={(e) => setLine(i, { billBagCount: e.target.value })}
                      className="input text-right"
                      inputMode="numeric"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <select
                      value={l.qcVerdict}
                      onChange={(e) => setLine(i, { qcVerdict: e.target.value })}
                      className="input"
                    >
                      <option value="">Not tested</option>
                      <option value="pass">Accept</option>
                      <option value="rejected">Reject</option>
                    </select>
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={l.qcMoisturePct}
                      onChange={(e) => setLine(i, { qcMoisturePct: e.target.value })}
                      className="input text-right"
                      inputMode="decimal"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={l.damagePercent}
                      onChange={(e) => setLine(i, { damagePercent: e.target.value })}
                      className="input text-right"
                      inputMode="decimal"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={l.qcVerdict === "rejected" ? "" : l.allocatedNetKg}
                      onChange={(e) => setLine(i, { allocatedNetKg: e.target.value })}
                      disabled={l.qcVerdict === "rejected"}
                      title={
                        l.qcVerdict === "rejected"
                          ? "Rejected material never came off the truck, so it takes no share of the net"
                          : undefined
                      }
                      className="input text-right disabled:bg-gray-50"
                      inputMode="decimal"
                    />
                  </td>
                  <td className="px-1 py-1 text-center">
                    {lines.length > 1 && (
                      <button
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                        className="text-gray-400 hover:text-red-600"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Which order each line landed on. Shown because a line that
              silently fails to match reaches gate out and then cannot be
              settled — better to see it here than at the payable. */}
          {!!vendorId && !!usable.length && (
            <div className="mb-3 rounded-lg border border-gray-100 bg-gray-50/60 p-2">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Against our orders
                </span>
                <span
                  className={`text-[11px] font-semibold uppercase tracking-wide ${
                    matches.length && matches.every((m) => m.chosen) ? "text-green-600" : "text-amber-600"
                  }`}
                >
                  {!matches.length
                    ? "checking…"
                    : matches.every((m) => m.chosen)
                      ? "on order"
                      : "not matched"}
                </span>
              </div>
              {matches.map((m) => (
                <div key={m.lineNo} className="flex items-baseline gap-2 text-[12px]">
                  <span className={m.chosen ? "text-green-600" : "text-amber-600"}>
                    {m.chosen ? "✓" : "!"}
                  </span>
                  <span className="text-gray-700">
                    {usable[m.lineNo - 1]?.itemName || `Line ${m.lineNo}`}
                  </span>
                  <span className="text-gray-500">{m.message}</span>
                </div>
              ))}
              {matches.length > 0 && !matches.every((m) => m.chosen) && (
                <p className="mt-1 text-[11px] text-gray-400">
                  A receipt can still be saved unmatched, but it cannot be settled into a bill until
                  every line sits against an open order.
                </p>
              )}
            </div>
          )}

          {lines.some((l) => l.qcVerdict === "rejected") && (
            <div className="mb-3 space-y-1">
              {lines.map((l, i) =>
                l.qcVerdict === "rejected" ? (
                  <input
                    key={i}
                    value={l.qcRejectionReason}
                    onChange={(e) => setLine(i, { qcRejectionReason: e.target.value })}
                    placeholder={`Why was ${l.itemName || `line ${i + 1}`} rejected?`}
                    className="input"
                  />
                ) : null,
              )}
            </div>
          )}

          {net != null && totalKg - net > 0 && (
            <div className="mb-3">
              <label className="label">
                Short by {(totalKg - net).toLocaleString("en-IN")} kg — why?
              </label>
              <input
                value={shortageReason}
                onChange={(e) => setShortageReason(e.target.value)}
                className="input"
              />
            </div>
          )}
        </>
      )}

      <div className="flex items-center justify-between">
        <button onClick={() => setLines((ls) => [...ls, emptyLine()])} className="btn-ghost">
          + Add line
        </button>
        <div className="text-[13px] text-gray-600">
          <span className="mr-4">{totalKg.toLocaleString("en-IN")} kg billed</span>
          <span className="font-semibold text-gray-900">
            ₹{totalValue.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>
    </Modal>
  );
}


export function GoodsReceiptsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: rows, isLoading } = useQuery<ReceiptRow[]>({
    queryKey: ["office", "receipts"],
    queryFn: () => api("/api/office/receipts"),
  });
  const { data: ctx } = useQuery<Context>({
    queryKey: ["office", "context"],
    queryFn: () => api("/api/office/context"),
  });
  const { data: numbering } = useQuery<Array<{ prefix: string; nextNumber: number; padding: number; seriesName: string; isDefault: boolean }>>({
    queryKey: ["office", "numbering"],
    queryFn: () => api("/api/office/numbering"),
  });

  const next = numbering?.find((n) => n.isDefault) ?? numbering?.[0];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-[19px] font-semibold text-gray-900">Goods Receipts</h1>
          <p className="text-[13px] text-gray-500">
            Every truck that reached the boom, and what it was carrying.
          </p>
        </div>
        <div className="flex items-center gap-4">
          {next && (
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-gray-400">Next number</div>
              <div className="font-mono text-[14px] text-gray-700">
                {next.prefix}
                {String(next.nextNumber).padStart(next.padding, "0")}
              </div>
            </div>
          )}
          <button className="btn-primary" onClick={() => setCreating(true)} disabled={!ctx}>
            + New Receipt
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="table-surface">
        <table className="w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="px-3 py-2 text-left">Receipt</th>
              <th className="px-3 py-2 text-left">Vehicle</th>
              <th className="px-3 py-2 text-left">Vendor</th>
              <th className="px-3 py-2 text-left">Bill</th>
              <th className="px-3 py-2 text-right">Lines</th>
              <th className="px-3 py-2 text-right">Billed</th>
              <th className="px-3 py-2 text-left">Arrived</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && !rows?.length && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-400">
                  No trucks recorded yet.
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50/60">
                <td className="px-3 py-2 font-mono text-gray-900">{r.number}</td>
                <td className="px-3 py-2 font-medium text-gray-900">{r.vehicleNumber}</td>
                <td className="px-3 py-2 text-gray-600">{r.vendorName ?? "—"}</td>
                <td className="px-3 py-2 text-gray-600">{r.vendorBillNumber ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">{r.lineCount}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                  {kg(r.billQuantityKg)}
                </td>
                <td className="px-3 py-2 text-gray-500">{when(r.arrivalAt)}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => setEditing(r.id)}
                    className="text-[12px] text-brand-600 hover:underline"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[12px] text-gray-500">
        Correcting a receipt keeps its number — a goods receipt number is quoted on the bill it
        becomes, so it is never reissued. A receipt already settled into a bill cannot be changed
        until that bill is voided.
      </p>

      {creating && ctx && <ReceiptEditor ctx={ctx} onClose={() => setCreating(false)} />}
      {editing && ctx && (
        <ReceiptEditor ctx={ctx} receiptId={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
