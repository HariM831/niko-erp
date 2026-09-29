/**
 * A weighment slip as a PDF: the weighbridge's own record of a weighing — the
 * vehicle, the party, the material, gross, tare and net with the time of each,
 * who weighed it — and the photograph the weighbridge camera took.
 *
 * Rendered for the goods receipt the weighing belongs to, so that whoever can
 * open the receipt, its settlement or the bill it became can see the slip,
 * without access to the weighbridge screen (29 Sep 2026: "an accountant with
 * just access to settlement or bills can't access that page").
 */
import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
import { winAnsi } from "./owner-statement-pdf";

export interface WeighSlipSpec {
  org: {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    phone: string | null;
    gstin: string | null;
  } | null;
  number: string;
  vehicleNumber: string;
  partyName: string | null;
  itemName: string | null;
  grossWeightKg: string | null;
  grossAt: Date | string | null;
  tareWeightKg: string | null;
  tareAt: Date | string | null;
  netWeightKg: string | null;
  operatorName: string | null;
  notes: string | null;
  /** The goods receipt it is printed for. */
  receiptNumber: string;
  /** The weighbridge camera's photograph, on disk; left out when missing. */
  photoPath: string | null;
}

const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";

const kg = (v: string | null) => (v == null ? "-" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`);
const when = (v: Date | string | null) =>
  v == null
    ? ""
    : new Date(v).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

export function renderWeighSlip(spec: WeighSlipSpec): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Weighment slip ${spec.number}` } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = 40;
  const inner = doc.page.width - 80;

  // Who weighed it.
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(winAnsi((spec.org?.name || "").toUpperCase()), left, 40, { width: inner, align: "center" });
  const address = [spec.org?.address, spec.org?.city, [spec.org?.state, spec.org?.pincode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const contact = [spec.org?.phone ? `Phone ${spec.org.phone}` : null, spec.org?.gstin ? `GSTIN ${spec.org.gstin}` : null].filter(Boolean).join("  |  ");
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  if (address) doc.text(winAnsi(address), { width: inner, align: "center" });
  if (contact) doc.text(winAnsi(contact), { width: inner, align: "center" });

  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text("WEIGHMENT SLIP", { width: inner, align: "center" });
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(`${spec.number}  |  for goods receipt ${spec.receiptNumber}`, { width: inner, align: "center" });

  // What was weighed.
  let y = doc.y + 14;
  doc.moveTo(left, y).lineTo(left + inner, y).strokeColor(RULE).lineWidth(1).stroke();
  y += 10;
  const facts: Array<[string, string]> = [
    ["Vehicle", spec.vehicleNumber],
    ["Party", spec.partyName ?? "-"],
    ["Material", spec.itemName ?? "-"],
  ];
  for (const [k, v] of facts) {
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(k, left, y, { width: 90 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(winAnsi(v), left + 95, y, { width: inner - 95 });
    y += 18;
  }

  // The weights.
  y += 6;
  const cols = [
    { label: "Weighment", x: left, w: 120, align: "left" as const },
    { label: "Weight", x: left + 120, w: 140, align: "right" as const },
    { label: "Date & time", x: left + 290, w: inner - 290, align: "left" as const },
  ];
  doc.rect(left, y, inner, 20).fill("#f3f4f6");
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9);
  for (const c of cols) doc.text(c.label.toUpperCase(), c.x + 6, y + 6, { width: c.w - 12, align: c.align });
  y += 26;
  const rows: Array<[string, string, string, boolean]> = [
    ["Gross", kg(spec.grossWeightKg), when(spec.grossAt), false],
    ["Tare", kg(spec.tareWeightKg), when(spec.tareAt), false],
    ["Net", kg(spec.netWeightKg), "", true],
  ];
  for (const [label, weight, at, strong] of rows) {
    doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 12 : 11).fillColor(INK);
    doc.text(label, cols[0]!.x + 6, y, { width: cols[0]!.w - 12 });
    doc.text(weight, cols[1]!.x + 6, y, { width: cols[1]!.w - 12, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(winAnsi(at), cols[2]!.x + 6, y + 1, { width: cols[2]!.w - 12 });
    y += 22;
    doc.moveTo(left, y - 5).lineTo(left + inner, y - 5).strokeColor(RULE).lineWidth(0.5).stroke();
  }

  y += 6;
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("Operator", left, y, { width: 90 });
  doc.font("Helvetica-Bold").fillColor(INK).text(winAnsi(spec.operatorName ?? "-"), left + 95, y, { width: inner - 95 });
  y += 18;
  if (spec.notes) {
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("Notes", left, y, { width: 90 });
    doc.fillColor(INK).text(winAnsi(spec.notes), left + 95, y, { width: inner - 95 });
    y = doc.y + 6;
  }

  // The camera's photograph of the weighing.
  if (spec.photoPath && existsSync(spec.photoPath)) {
    y += 10;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("WEIGHBRIDGE CAMERA", left, y);
    y += 14;
    const room = doc.page.height - 40 - 30 - y;
    try {
      doc.image(spec.photoPath, left, y, { fit: [inner, Math.max(120, room)], align: "center" });
    } catch {
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("The photograph could not be read.", left, y);
    }
  }

  doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(
    "Weights recorded from the platform indicator.",
    left,
    doc.page.height - 55,
    { width: inner, align: "center", lineBreak: false },
  );
  doc.end();
  return done;
}
