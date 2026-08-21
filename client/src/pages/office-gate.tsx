/**
 * Station 1 — Gate In. Records are born here.
 *
 * The bill is photographed once and everything the paper can tell us follows
 * the truck; no field is typed twice. Until the extraction layer is wired the
 * same screen takes the values by hand, which is the fallback path anyway —
 * the gate has the worst signal on site and a phone cannot always reach a
 * vision model.
 *
 * One decision is made here and it is the only one: does this truck come in?
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ApiError, api } from "../api";
import type { LineMatch } from "@shared/po-match-types";

interface Context {
  locations: Array<{ id: string; name: string; code: string }>;
  vendors: Array<{ id: string; name: string }>;
  items: Array<{ id: string; name: string; unit: string; hsnOrSac: string | null }>;
}

interface LineDraft {
  itemId: string;
  itemName: string;
  billQuantityKg: string;
  billRatePerKg: string;
  billBagCount: string;
}

const emptyLine = (): LineDraft => ({
  itemId: "",
  itemName: "",
  billQuantityKg: "",
  billRatePerKg: "",
  billBagCount: "",
});

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export type PhotoKind = "gate_in_bill" | "gate_in_vehicle" | "gate_in_weighslip";

const SLOTS: Array<{ kind: PhotoKind; title: string; hint: string; required: boolean }> = [
  {
    kind: "gate_in_bill",
    title: "The vendor's bill",
    hint: "Fit all four edges. Capture every row of the particulars table.",
    required: false,
  },
  {
    kind: "gate_in_vehicle",
    title: "The vehicle",
    hint: "Front on, with the number plate readable.",
    required: true,
  },
  {
    kind: "gate_in_weighslip",
    title: "Their weigh slip",
    hint: "The weighbridge ticket, if the driver has one.",
    required: false,
  },
];

/** Client-side downscale before upload, so nothing large crosses the boom's link. */
const CLIENT_EDGE: Record<PhotoKind, number> = {
  gate_in_bill: 1600,
  gate_in_weighslip: 1600,
  gate_in_vehicle: 1100,
};

async function shrink(file: File, maxEdge: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.72),
  );
}

/**
 * One photo slot.
 *
 * A photo is worth taking even when nothing reads it: it is the evidence the
 * payable is eventually raised against, and it can only be taken while the
 * truck is at the barrier. So capture and extraction are separate actions — a
 * failed read never discards a good photograph.
 */
function PhotoSlot({
  slot,
  file,
  onPick,
}: {
  slot: (typeof SLOTS)[number];
  file: File | null;
  onPick: (f: File | null) => void;
}) {
  // Two inputs, not one. `capture` sends a phone straight to the camera, which
  // is right at a barrier and wrong at a desk — where the photo already exists
  // and someone is keying a receipt after the fact.
  const camera = useRef<HTMLInputElement>(null);
  const browse = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  const take = (f: File | undefined | null) => {
    if (f && f.type.startsWith("image/")) onPick(f);
  };

  return (
    <div className="flex-1">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-gray-900">
          {slot.title}
          {slot.required && <span className="ml-1 text-red-600">*</span>}
        </span>
        {file && (
          <button className="btn-ghost text-[11px]" onClick={() => onPick(null)}>
            Remove
          </button>
        )}
      </div>

      <input
        ref={camera}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(e) => take(e.target.files?.[0])}
      />
      <input
        ref={browse}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => take(e.target.files?.[0])}
      />

      {preview ? (
        <button
          onClick={() => browse.current?.click()}
          className="group relative block h-28 w-full overflow-hidden rounded-lg border border-gray-200"
          title="Click to replace"
        >
          <img src={preview} alt={slot.title} className="h-full w-full object-cover" />
          <span className="absolute inset-0 hidden place-items-center bg-black/45 text-[11px] font-medium text-white group-hover:grid">
            Replace
          </span>
        </button>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer.files?.[0]);
          }}
          className={`grid h-28 place-items-center rounded-lg border border-dashed px-2 text-center transition-colors ${
            over ? "border-brand-400 bg-brand-50" : "border-gray-300"
          }`}
        >
          <div>
            <div className="mb-1 flex justify-center gap-1">
              <button className="btn-secondary h-7 px-2 text-[11px]" onClick={() => browse.current?.click()}>
                Upload
              </button>
              <button className="btn-secondary h-7 px-2 text-[11px]" onClick={() => camera.current?.click()}>
                Camera
              </button>
            </div>
            <div className="text-[10px] leading-tight text-gray-400">
              {over ? "Drop it here" : slot.hint}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function GateInPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: ctx } = useQuery<Context>({
    queryKey: ["office", "context"],
    queryFn: () => api("/api/office/context"),
  });
  const { data: numbering } = useQuery<
    Array<{ prefix: string; nextNumber: number; padding: number; seriesName: string; isDefault: boolean }>
  >({
    queryKey: ["office", "numbering"],
    queryFn: () => api("/api/office/numbering"),
  });

  const [photos, setPhotos] = useState<Partial<Record<PhotoKind, File>>>({});
  const [fix, setFix] = useState<GeolocationCoordinates | null>(null);
  const [reading, setReading] = useState(false);
  const [checks, setChecks] = useState<Array<{ name: string; ok: boolean; detail: string }>>([]);
  const [vendorHint, setVendorHint] = useState<{ name: string; candidates: Array<{ id: string; name: string; why: string }> } | null>(null);
  const [matches, setMatches] = useState<LineMatch[]>([]);
  const [allMatched, setAllMatched] = useState(false);
  const [matching, setMatching] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(new Date().toISOString().slice(0, 10));
  /**
   * What the vendor printed at the foot of their bill.
   *
   * Captured here because it is the only moment the paper is in front of
   * somebody. The tax is not a bookkeeping detail we can recover later: with no
   * GST input to claim it is part of what the material cost, so settlement
   * spreads it across the lines and bills the all-in figure. Read as zero, a
   * ₹1.09 lakh liability simply never appears.
   */
  const [billTotal, setBillTotal] = useState("");
  const [billTax, setBillTax] = useState("");
  const [billDocType, setBillDocType] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [turnAway, setTurnAway] = useState(false);
  const [exitReason, setExitReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Asked for once on arrival. A refused or drifted fix is recorded and
  // flagged, never blocking — a phone beside a steel shed reports +/-80 m as a
  // matter of course, and holding a loaded truck over that would be absurd.
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => setFix(p.coords),
      () => setFix(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  }, []);

  const asDataUrl = (f: File, kind: PhotoKind) =>
    shrink(f, CLIENT_EDGE[kind]).then(
      (b) =>
        new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.readAsDataURL(b);
        }),
    );

  /**
   * Read whatever has been captured, and say what the photos prove about each
   * other. Two calls at most: the bill on its own, and the vehicle and slip
   * together — both of those are trivial reads and batching them halves the
   * round trips.
   */
  const readPhotos = async () => {
    setReading(true);
    setError(null);
    try {
      let bill: unknown = null;
      if (photos.gate_in_bill) {
        const image = await asDataUrl(photos.gate_in_bill, "gate_in_bill");
        bill = await api<Record<string, any>>("/api/office/extract-bill", {
          method: "POST",
          body: { images: [image] },
        });
        const b = bill as Record<string, any>;
        if (b.billNumber) setBillNumber(String(b.billNumber));
        if (b.billDate) setBillDate(String(b.billDate));
        if (b.billTotal != null) setBillTotal(String(b.billTotal));
        // A bill of supply charges none, and null means "not printed" rather
        // than "zero" — either way an untouched field bills the goods alone.
        if (b.billTax != null) setBillTax(String(b.billTax));
        if (b.documentType) setBillDocType(String(b.documentType));
        if (b.vehicleNumber) setVehicleNumber(String(b.vehicleNumber));
        if (b.vendorMatch?.vendorId) setVendorId(String(b.vendorMatch.vendorId));
        setVendorHint(
          b.vendorMatch?.vendorId
            ? null
            : b.vendor
              ? { name: String(b.vendor), candidates: b.vendorMatch?.candidates ?? [] }
              : null,
        );
        if (Array.isArray(b.lines) && b.lines.length) {
          setLines(
            b.lines.map((l: Record<string, any>) => ({
              itemId: l.itemId ?? "",
              itemName: l.materialName ?? l.description ?? "",
              billQuantityKg: l.quantityKg != null ? String(l.quantityKg) : "",
              billRatePerKg: l.ratePerKg != null ? String(l.ratePerKg) : "",
              billBagCount: l.bagCount != null ? String(l.bagCount) : "",
            })),
          );
        }
      }

      if (photos.gate_in_vehicle || photos.gate_in_weighslip) {
        const payload: Record<string, unknown> = { bill };
        if (photos.gate_in_vehicle) {
          payload.vehicle = await asDataUrl(photos.gate_in_vehicle, "gate_in_vehicle");
        }
        if (photos.gate_in_weighslip) {
          payload.weighslip = await asDataUrl(photos.gate_in_weighslip, "gate_in_weighslip");
        }
        const r = await api<{
          plate: { plate: string | null };
          checks: Array<{ name: string; ok: boolean; detail: string }>;
        }>("/api/office/extract-gate-docs", { method: "POST", body: payload });
        if (r.plate?.plate && !vehicleNumber) setVehicleNumber(r.plate.plate);
        setChecks(r.checks ?? []);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not read the photos");
    } finally {
      setReading(false);
    }
  };

  /**
   * Re-check the open orders whenever the vendor, the date or a line changes.
   *
   * Debounced because it fires on every keystroke in a quantity field, and the
   * answer decides whether the boom lifts — a stale verdict is worse than a
   * slightly late one.
   */
  useEffect(() => {
    const usableNow = lines.filter((l) => l.itemName.trim() && Number(l.billQuantityKg) > 0);
    if (!vendorId || !usableNow.length) {
      setMatches([]);
      setAllMatched(false);
      return;
    }
    const timer = setTimeout(() => {
      setMatching(true);
      api<{ matches: LineMatch[]; allMatched: boolean }>("/api/office/match-po-lines", {
        method: "POST",
        body: {
          vendorId,
          billDate: billDate || null,
          lines: usableNow.map((l) => ({
            itemId: l.itemId || null,
            itemName: l.itemName || null,
            quantityKg: Number(l.billQuantityKg) || null,
            ratePerKg: Number(l.billRatePerKg) || null,
          })),
        },
      })
        .then((r) => {
          setMatches(r.matches);
          setAllMatched(r.allMatched);
        })
        .catch(() => {
          setMatches([]);
          setAllMatched(false);
        })
        .finally(() => setMatching(false));
    }, 500);
    return () => clearTimeout(timer);
  }, [vendorId, billDate, lines]);

  const site = locationId || ctx?.locations[0]?.id || "";
  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const totalKg = lines.reduce((s, l) => s + (Number(l.billQuantityKg) || 0), 0);
  const totalValue = lines.reduce(
    (s, l) => s + (Number(l.billQuantityKg) || 0) * (Number(l.billRatePerKg) || 0),
    0,
  );

  const usable = lines.filter((l) => l.itemName.trim() && Number(l.billQuantityKg) > 0);
  const basicsDone =
    !!site && vehicleNumber.trim().length >= 4 && usable.length > 0;
  // A truck is only let in against something we actually ordered. There is no
  // override: every line matches an open order, or it does not come in.
  const canSubmit = turnAway
    ? basicsDone && exitReason.trim().length > 0
    : basicsDone && allMatched;

  const next = numbering?.find((n) => n.isDefault) ?? numbering?.[0];

  const submit = useMutation({
    mutationFn: () =>
      api<{ id: string; number: string }>("/api/office/receipts", {
        method: "POST",
        body: {
          locationId: site,
          vendorId: vendorId || undefined,
          vehicleNumber,
          decision: turnAway ? "turn_away" : "allow",
          exitReason: turnAway ? exitReason : undefined,
          vendorBillNumber: billNumber || undefined,
          vendorBillDate: billDate || undefined,
          billDocumentType: billDocType || undefined,
          billTotalAmount: billTotal.trim() ? Number(billTotal).toFixed(2) : undefined,
          billTaxAmount: billTax.trim() ? Number(billTax).toFixed(2) : undefined,
          deviceCapturedAt: new Date().toISOString(),
          // The same fix the photos are stamped with, so the receipt itself can
          // say which gate it was raised at and how far off it was. Absent when
          // the device refused or had no signal, which the server records as
          // no_fix rather than as nothing at all.
          latitude: fix?.latitude,
          longitude: fix?.longitude,
          accuracyM: fix?.accuracy,
          lines: usable.map((l, i) => ({
            purchaseOrderId: matches[i]?.chosen?.purchaseOrderId,
            poLineId: matches[i]?.chosen?.poLineId,
            itemId: l.itemId || undefined,
            itemName: l.itemName.trim(),
            billQuantityKg: l.billQuantityKg,
            billRatePerKg: l.billRatePerKg || undefined,
            billBagCount: l.billBagCount ? Number(l.billBagCount) : undefined,
          })),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["office"] });
      // Photos follow the receipt: they need its id and its number for the band.
      void (async () => {
        for (const [kind, file] of Object.entries(photos) as Array<[PhotoKind, File]>) {
          const body = new FormData();
          body.append("file", await shrink(file, CLIENT_EDGE[kind]), `${kind}.jpg`);
          body.append("kind", kind);
          body.append("capturedAt", new Date().toISOString());
          if (fix) {
            body.append("latitude", String(fix.latitude));
            body.append("longitude", String(fix.longitude));
            body.append("accuracyM", String(fix.accuracy));
          }
          await fetch(`/api/office/receipts/${r.id}/photos`, {
            method: "POST",
            body,
            credentials: "same-origin",
          }).catch(() => {
            /* the receipt is already recorded; a failed photo must not undo it */
          });
        }
        void qc.invalidateQueries({ queryKey: ["office"] });
      })();

      setDone(r.number);
      setPhotos({});
      setChecks([]);
      setVendorId("");
      setVehicleNumber("");
      setBillNumber("");
      setBillTotal("");
      setBillTax("");
      setBillDocType("");
      setLines([emptyLine()]);
      setTurnAway(false);
      setExitReason("");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not record this truck"),
  });

  if (!ctx) return <div className="p-6 text-[13px] text-gray-400">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold text-gray-900">Gate In</h1>
          <p className="text-[13px] text-gray-500">
            Scan the vendor's bill and decide whether the truck comes in.
          </p>
        </div>
        {next && (
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-gray-400">This receipt</div>
            <div className="font-mono text-[14px] text-gray-700">
              {next.prefix}
              {String(next.nextNumber).padStart(next.padding, "0")}
            </div>
          </div>
        )}
      </div>

      {done && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-800">
          <span>
            Recorded <span className="font-mono font-semibold">{done}</span>. The truck can proceed
            to the weighbridge.
          </span>
          <button className="btn-ghost" onClick={() => navigate("/office/receipts")}>
            View receipts →
          </button>
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="card mb-4 p-4">
        <div className="mb-3 flex gap-3">
          {SLOTS.map((slot) => (
            <PhotoSlot
              key={slot.kind}
              slot={slot}
              file={photos[slot.kind] ?? null}
              onPick={(f) =>
                setPhotos((p) => {
                  const next = { ...p };
                  if (f) next[slot.kind] = f;
                  else delete next[slot.kind];
                  return next;
                })
              }
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-gray-500">
            {fix
              ? `Location fixed to ±${Math.round(fix.accuracy)} m`
              : "Locating… the receipt is recorded either way"}
          </span>
          <button
            className="btn-secondary"
            disabled={reading || !Object.keys(photos).length}
            onClick={() => void readPhotos()}
          >
            {reading ? "Reading…" : "Read the photos"}
          </button>
        </div>

        {!!checks.length && (
          <div className="mt-3 space-y-1 border-t border-gray-100 pt-3">
            {checks.map((c) => (
              <div key={c.name} className="flex items-baseline gap-2 text-[12px]">
                <span className={c.ok ? "text-green-600" : "text-amber-600"}>
                  {c.ok ? "✓" : "!"}
                </span>
                <span className="text-gray-700">{c.name}</span>
                <span className="text-gray-400">{c.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card mb-4 p-4">
        <div className="mb-3 grid grid-cols-3 gap-4">
          <div>
            <label className="label-required">Site *</label>
            <select value={site} onChange={(e) => setLocationId(e.target.value)} className="input">
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
              placeholder="AS 26 AC 1223"
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
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">Bill number</label>
            <input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">Bill date</label>
            <input
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              className="input"
            />
          </div>
          <div>
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
            <label className="label">Their bill total</label>
            <input
              value={billTotal}
              onChange={(e) => setBillTotal(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="input text-right"
            />
          </div>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          The tax is payable, so it is billed with the goods rather than split out — we claim no
          input credit on it. Leave GST blank on a bill of supply, which charges none.
        </p>
      </div>

      <div className="table-surface mb-4">
        <table className="w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="px-3 py-2 text-left">Material</th>
              <th className="w-32 px-2 py-2 text-right">Quantity (kg)</th>
              <th className="w-28 px-2 py-2 text-right">Rate / kg</th>
              <th className="w-20 px-2 py-2 text-right">Bags</th>
              <th className="w-32 px-2 py-2 text-right">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="px-3 py-2">
                  <select
                    value={l.itemId}
                    onChange={(e) => {
                      const item = ctx.items.find((it) => it.id === e.target.value);
                      setLine(i, { itemId: e.target.value, itemName: item?.name ?? "" });
                    }}
                    className="input"
                  >
                    <option value="">Choose a material…</option>
                    {ctx.items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <input
                    value={l.billQuantityKg}
                    onChange={(e) => setLine(i, { billQuantityKg: e.target.value })}
                    className="input text-right"
                    inputMode="decimal"
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    value={l.billRatePerKg}
                    onChange={(e) => setLine(i, { billRatePerKg: e.target.value })}
                    className="input text-right"
                    inputMode="decimal"
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    value={l.billBagCount}
                    onChange={(e) => setLine(i, { billBagCount: e.target.value })}
                    className="input text-right"
                    inputMode="numeric"
                  />
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                  {inr((Number(l.billQuantityKg) || 0) * (Number(l.billRatePerKg) || 0))}
                </td>
                <td className="px-1 py-2 text-center">
                  {lines.length > 1 && (
                    <button
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      className="text-gray-400 hover:text-red-600"
                      title="Remove line"
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-3 py-2">
          <button onClick={() => setLines((ls) => [...ls, emptyLine()])} className="btn-ghost">
            + Add line
          </button>
          <div className="text-[13px] text-gray-600">
            <span className="mr-4">{totalKg.toLocaleString("en-IN")} kg billed</span>
            <span className="font-semibold text-gray-900">{inr(totalValue)}</span>
          </div>
        </div>
      </div>

      {turnAway && (
        <div className="card mb-4 p-4">
          <label className="label-required">Why is this truck being turned away? *</label>
          <input value={exitReason} onChange={(e) => setExitReason(e.target.value)} className="input" />
          <p className="mt-1 text-[12px] text-gray-500">
            No weights are taken and no purchase order quantity is consumed — the vendor has not
            delivered anything.
          </p>
        </div>
      )}

      {!turnAway && (
        <div className="card mb-4 p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[13px] font-semibold text-gray-900">Against our orders</span>
            <span
              className={`text-[11px] font-semibold uppercase tracking-wide ${
                matching ? "text-gray-400" : allMatched ? "text-green-600" : "text-red-600"
              }`}
            >
              {matching ? "checking…" : allMatched ? "on order" : "no matching order"}
            </span>
          </div>

          {!matches.length && !matching && (
            <p className="text-[12px] text-gray-500">
              {vendorId
                ? "Add a material and quantity to check it against open orders."
                : "Choose the vendor to check this delivery against their open orders."}
            </p>
          )}

          <div className="space-y-2">
            {matches.map((m) => (
              <div key={m.lineNo} className="rounded-lg border border-gray-100 bg-gray-50/60 p-2">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className={m.chosen ? "text-green-600" : "text-red-600"}>
                    {m.chosen ? "✓" : "✗"}
                  </span>
                  <span className="font-medium text-gray-900">Line {m.lineNo}</span>
                  <span className="text-gray-600">{m.message}</span>
                </div>
                {m.chosen && (
                  <div className="mt-1 flex flex-wrap gap-x-4 pl-5 text-[11px] text-gray-500">
                    {m.chosen.reasons.map((r, i) => (
                      <span key={i} className={r.passed ? "" : "text-amber-600"}>
                        {r.detail}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {!allMatched && !!matches.length && (
            <p className="mt-3 border-t border-gray-100 pt-3 text-[12px] text-gray-500">
              This truck cannot be let in until every line matches an open order. Correct the
              figures above, or turn it away.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          className="btn-secondary"
          onClick={() => {
            setTurnAway((t) => !t);
            setError(null);
          }}
        >
          {turnAway ? "← Back to allowing in" : "Turn away instead"}
        </button>
        <button
          className="btn-primary"
          disabled={!canSubmit || submit.isPending}
          onClick={() => {
            setError(null);
            setDone(null);
            submit.mutate();
          }}
        >
          {turnAway ? "Record turn-away" : "Allow in"}
        </button>
      </div>
    </div>
  );
}
