/**
 * What stands behind a goods receipt's numbers: the photos taken at each
 * station and our weighbridge's slip for the truck.
 *
 * The photos are the receipt's own attachments. The slip is the weighbridge's
 * record, found by vehicle and weights, and opens as a PDF with the camera's
 * photograph and the weights — so someone who can see the receipt, its
 * settlement or its bill can read it without access to the weighbridge screen.
 * Read-only where the viewer is looking at a bill rather than correcting the
 * receipt.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { AttachmentsPanel } from "./attachments";

interface WeighSlip {
  id: string;
  number: string;
  grossWeightKg: string | null;
  tareWeightKg: string | null;
  netWeightKg: string | null;
  photoId: string | null;
}

const kg = (v: string | null) =>
  v == null ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;

export function ReceiptEvidence({ receiptId, readOnly = false }: { receiptId: string; readOnly?: boolean }) {
  const { data: slips } = useQuery<WeighSlip[]>({
    queryKey: ["office", "receipt", receiptId, "weigh-slips"],
    queryFn: () => api(`/api/office/receipts/${receiptId}/weigh-slips`),
  });

  return (
    <AttachmentsPanel
      entityType="office_receipt"
      entityId={receiptId}
      readOnly={readOnly}
      extraTiles={slips?.map((w) => (
        <a
          key={w.id}
          href={`/api/office/receipts/${receiptId}/weigh-slips/${w.id}/pdf`}
          target="_blank"
          rel="noreferrer"
          title={`Weighment slip ${w.number} (PDF)`}
          className="block"
        >
          {w.photoId ? (
            <img
              src={`/api/attachments/${w.photoId}/download`}
              alt={`Weighment slip ${w.number}`}
              className="h-24 w-full rounded-lg border border-gray-100 object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-24 w-full flex-col justify-center rounded-lg border border-gray-200 bg-white px-2 text-[11px] tabular-nums text-gray-600">
              <span className="font-mono font-semibold text-gray-900">{w.number}</span>
              <span>Gross {kg(w.grossWeightKg)}</span>
              <span>Tare {kg(w.tareWeightKg)}</span>
              <span>Net {kg(w.netWeightKg)}</span>
            </div>
          )}
          <div className="mt-0.5 truncate text-[11px] text-gray-600">Our weighment slip · {w.number} · PDF</div>
          <div className="text-[10px] tabular-nums text-gray-400">
            {kg(w.grossWeightKg)} − {kg(w.tareWeightKg)} = {kg(w.netWeightKg)}
          </div>
        </a>
      ))}
    />
  );
}
