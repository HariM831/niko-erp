import { amountInWords } from "../api";
import logoUrl from "../assets/letterhead-logo.png";
import bandUrl from "../assets/letterhead-band.png";

/**
 * A purchase order on the company letterhead (22 Oct 2026; Amino Farms logo
 * in red, 24 Oct 2026).
 *
 * The content is the PO's own — the same fields, in the same places, as the
 * Zoho-style sheet every other document prints. Only the look comes from the
 * letterhead: the Amino Farms logo in red, red accents, and the band and
 * company lines at the foot of the page.
 */
export interface PoLetterheadProps {
  number: string;
  orderDate: string;
  terms: string | null;
  reference?: string | null;
  allowance?: { orgPct: number; extraPct: number; by: string | null } | null;
  allowanceReason?: string | null;
  /** Freight we pay the transporter, as agreed with the vendor. */
  freightBasis?: "none" | "per_ton" | "per_truck" | null;
  freightRate?: string | null;
  placeOfSupply: string | null;
  vendorName: string;
  vendorLink?: React.ReactNode;
  vendorAddress: string[];
  vendorGstin?: string;
  org?: {
    name: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
  } | null;
  /** The location picked in the PO's "Deliver To" field; without one, the org profile's address prints. */
  deliverTo?: { name: string; lines: string[] } | null;
  pdfFields: Array<{ fieldId: string; label: string; display: string }>;
  lines: Array<{ id: string; name: string; description?: string; quantity: string; unit?: string; rate: string; amount: string }>;
  subTotal: string;
  discountTotal: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  total: string;
  notes?: string | null;
  termsAndConditions?: string | null;
  formatNum: (v: string | number) => string;
  slashDate: (d: string) => string;
}

export function PoLetterheadSheet(p: PoLetterheadProps) {
  const n = p.formatNum;
  const amountRows: Array<[string, string]> = [
    ["Sub Total", n(p.subTotal)],
    ...(Number(p.discountTotal) > 0 ? [["Discount", `(-) ${n(p.discountTotal)}`] as [string, string]] : []),
    ...(Number(p.cgst) > 0 ? [["CGST", n(p.cgst)] as [string, string]] : []),
    ...(Number(p.sgst) > 0 ? [["SGST", n(p.sgst)] as [string, string]] : []),
    ...(Number(p.igst) > 0 ? [["IGST", n(p.igst)] as [string, string]] : []),
    ...(Number(p.roundOff) !== 0 ? [["Round Off", n(p.roundOff)] as [string, string]] : []),
  ];

  return (
    <div className="letterhead flex min-h-[297mm] flex-col">
      <div className="flex-1 px-[16mm] pt-[14mm]">
        <header className="flex items-start justify-between border-b border-[#cb1e25] pb-[5mm]">
          <img src={logoUrl} alt="Amino Farms" className="-mt-[2mm] ml-[2mm] w-[32mm]" />
          <div className="text-right">
            <div className="lh-bold mt-[7mm] text-[22pt] leading-none">PURCHASE ORDER</div>
            <div className="lh-bold mt-[2mm] text-[9.5pt] text-[#cb1e25]">{p.org?.name || "Amino Farms Private Limited"}</div>
          </div>
        </header>

        <div className="flex border-b border-[#c9c9c9]">
          <div className="lh-kv flex-1 px-[2.5mm] py-[3mm]">
            <span className="lh-lbl">Purchase Order #</span>
            <span className="lh-bold">{p.number}</span>
            <span className="lh-lbl">Purchase Order Date</span>
            <span className="lh-bold">{p.slashDate(p.orderDate)}</span>
            {p.terms && (
              <>
                <span className="lh-lbl">Terms</span>
                <span className="lh-bold">{p.terms}</span>
              </>
            )}
            {p.reference && (
              <>
                <span className="lh-lbl">Reference</span>
                <span className="lh-bold">{p.reference}</span>
              </>
            )}
            {p.allowance && (
              <>
                <span className="lh-lbl">Allowance</span>
                <span className="lh-bold">
                  {p.allowance.orgPct}% over ordered
                  {p.allowance.extraPct > 0 && (
                    <>
                      {" "}+ {p.allowance.extraPct}% extended{p.allowance.by ? ` by ${p.allowance.by}` : ""}
                      {p.allowanceReason ? ` — ${p.allowanceReason}` : ""}
                    </>
                  )}
                </span>
              </>
            )}
            {p.freightBasis && p.freightBasis !== "none" && Number(p.freightRate) > 0 && (
              <>
                <span className="lh-lbl">Freight</span>
                <span className="lh-bold">
                  ₹{n(p.freightRate!)} {p.freightBasis === "per_ton" ? "per ton" : "per truck"}, paid by us to the transporter
                </span>
              </>
            )}
          </div>
          <div className="lh-kv flex-1 border-l border-[#c9c9c9] px-[2.5mm] py-[3mm]">
            {p.placeOfSupply && (
              <>
                <span className="lh-lbl">Place Of Supply</span>
                <span className="lh-bold">{p.placeOfSupply}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex border-b border-[#c9c9c9]">
          <div className="flex-1 px-[2.5mm] py-[3mm]">
            <div className="lh-bold mb-[1.5mm] text-[#cb1e25]">Vendor</div>
            <div className="lh-bold text-[10.5pt]">{p.vendorLink ?? p.vendorName}</div>
            {p.vendorAddress.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
            {p.vendorGstin && <div>GSTIN {p.vendorGstin}</div>}
          </div>
          <div className="flex-1 border-l border-[#c9c9c9] px-[2.5mm] py-[3mm]">
            <div className="lh-bold mb-[1.5mm] text-[#cb1e25]">Deliver To</div>
            <div className="lh-bold text-[10.5pt]">{p.org?.name}</div>
            {p.deliverTo ? (
              <>
                <div className="lh-bold">{p.deliverTo.name}</div>
                {p.deliverTo.lines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </>
            ) : (
              <>
                {p.org?.address && <div>{p.org.address}</div>}
                {[p.org?.city, p.org?.pincode, p.org?.state].some(Boolean) && (
                  <div>{[p.org?.city, p.org?.pincode, p.org?.state].filter(Boolean).join(" ")}</div>
                )}
              </>
            )}
            <div>India</div>
          </div>
        </div>

        {p.pdfFields.length > 0 && (
          <div className="flex flex-wrap gap-x-8 gap-y-1 border-b border-[#c9c9c9] px-[2.5mm] py-[2mm]">
            {p.pdfFields.map((f) => (
              <div key={f.fieldId}>
                <span className="lh-lbl">{f.label}: </span>
                <span className="lh-bold">{f.display || "—"}</span>
              </div>
            ))}
          </div>
        )}

        <table className="mt-[4mm] w-full border-collapse">
          <thead>
            <tr className="bg-[#cb1e25] text-white">
              <th className="lh-bold w-[9mm] px-[2.5mm] py-[2.2mm] text-center">#</th>
              <th className="lh-bold px-[2.5mm] py-[2.2mm] text-left">Item &amp; Description</th>
              <th className="lh-bold w-[26mm] px-[2.5mm] py-[2.2mm] text-right">Qty</th>
              <th className="lh-bold w-[26mm] px-[2.5mm] py-[2.2mm] text-right">Rate</th>
              <th className="lh-bold w-[30mm] px-[2.5mm] py-[2.2mm] text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l, i) => (
              <tr key={l.id} className="border-b border-[#c9c9c9] align-top">
                <td className="px-[2.5mm] py-[2.4mm] text-center">{i + 1}</td>
                <td className="px-[2.5mm] py-[2.4mm]">
                  <div>{l.name}</div>
                  {l.description && <div className="whitespace-pre-wrap text-[8.5pt] text-[#555]">{l.description}</div>}
                </td>
                <td className="px-[2.5mm] py-[2.4mm] text-right tabular-nums">
                  {n(l.quantity)}
                  {l.unit && <div className="text-[8.5pt] text-[#555]">{l.unit}</div>}
                </td>
                <td className="px-[2.5mm] py-[2.4mm] text-right tabular-nums">{n(l.rate)}</td>
                <td className="px-[2.5mm] py-[2.4mm] text-right tabular-nums">{n(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex">
          <div className="flex-1 px-[2.5mm] py-[4mm]">
            <div className="lh-lbl">Total In Words</div>
            <div className="lh-bold mt-[1mm] italic">{amountInWords(p.total)}</div>
            {p.notes && (
              <div className="pt-[4mm]">
                <div className="lh-bold text-[#cb1e25]">Notes</div>
                <p className="mt-[1mm] whitespace-pre-wrap">{p.notes}</p>
              </div>
            )}
            {p.termsAndConditions && (
              <div className="pt-[4mm]">
                <div className="lh-bold text-[#cb1e25]">Terms &amp; Conditions</div>
                <p className="mt-[1mm] whitespace-pre-wrap">{p.termsAndConditions}</p>
              </div>
            )}
          </div>
          <div className="w-[44%] self-start border-l border-[#c9c9c9]">
            <table className="w-full border-collapse">
              <tbody>
                {amountRows.map(([label, value]) => (
                  <tr key={label}>
                    <td className="px-[2.5mm] py-[1.6mm] text-right">{label}</td>
                    <td className="w-[34mm] px-[2.5mm] py-[1.6mm] text-right tabular-nums">{value}</td>
                  </tr>
                ))}
                <tr className="border-t-[1.5px] border-[#1f1f1f]">
                  <td className="lh-bold px-[2.5mm] pb-[1.6mm] pt-[2mm] text-right text-[11pt]">Total</td>
                  <td className="lh-bold px-[2.5mm] pb-[1.6mm] pt-[2mm] text-right text-[11pt] tabular-nums">₹{n(p.total)}</td>
                </tr>
              </tbody>
            </table>
            <div className="flex h-[26mm] items-end justify-center border-y border-[#c9c9c9] pb-[1.5mm]">Authorized Signature</div>
          </div>
        </div>
      </div>

      <footer className="mt-[8mm] break-inside-avoid pb-[6mm]">
        <img src={bandUrl} alt="" className="block h-[4.6mm] w-full" />
        <div className="pl-[18.5mm] pt-[4mm] text-[8.5pt] leading-[1.75] text-[#404041]">
          <div className="lh-bold">Amino Farms Private Limited</div>
          <div>
            <span className="lh-bold">CIN:</span> U01463AS2023PTC029795 | <span className="lh-bold">Website:</span> www.aminofarms.com
          </div>
          <div>
            <span className="lh-bold">Registered Address:</span> 1 No. Nabil Kachari, Mouza Borgaon, Thelamara, District Sonitpur,
            784149, Assam, India
          </div>
        </div>
      </footer>
    </div>
  );
}
