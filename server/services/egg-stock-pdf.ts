/**
 * The Daily Production & Stock Statement as the farm's printed sheet (7 Oct
 * 2026): the niko eggs mark, the date box, the Production Report by shed, the
 * Stock Summary in four rows, the four rules and the supervisor's signature.
 *
 * Columns in the sheet's own order — Small, Medium, Large, NIKO, Brown, Jumbo,
 * Dirty. The physical count sits under the summary as a check: it never
 * changes the closing, so its difference is printed for somebody to explain.
 */
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { EGG_SIZE_LABEL, STOCK_SHEET_SIZES, type EggSize } from "@shared/egg-sizes";
import { winAnsi } from "./owner-statement-pdf";

const INK = "#1f1a14";
const MUTED = "#6b6258";
const HEAD = "#d9d9d9";
const RED = "#c8102e";

interface Summary {
  opening: number;
  production: number;
  sales: number;
  other: number;
  closing: number;
}

export interface StockSheet {
  date: string;
  rows: Array<{ code: string; purpose: string; entered: boolean; boxes: Record<string, number> }>;
  summary: Record<string, Summary>;
  count: Record<string, number> | null;
  variance: Record<string, number> | null;
  submission: { submittedBy: string | null; submittedAt: Date | string } | null;
}

const LABEL = (s: EggSize) => (s === "niko" ? "NIKO" : EGG_SIZE_LABEL[s]);

const longDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
};

const stamp = (t: Date | string) =>
  new Date(t).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

/** The niko mark ships with the app; a server without it prints the name instead. */
function logoPath(): string | null {
  const p = path.resolve(process.cwd(), "client/src/assets/logo.png");
  return fs.existsSync(p) ? p : null;
}

export function renderStockSheet(sheet: StockSheet): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Production and Stock ${sheet.date}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const sizes = STOCK_SHEET_SIZES;
  const left = 40;
  const width = doc.page.width - 80;
  const firstW = 110;
  const numW = (width - firstW) / sizes.length;
  const colX = (i: number) => left + firstW + i * numW;
  const rowH = 26;
  const n = (v: number) => (v ? v.toLocaleString("en-IN") : "-");

  // ── Head: the mark, the date box, the title ──
  const logo = logoPath();
  if (logo) {
    doc.image(logo, left - 6, 22, { width: 96 });
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11).text("eggs", left + 26, 82, { width: 40, align: "center" });
  } else {
    doc.fillColor(RED).font("Helvetica-Bold").fontSize(26).text("niko", left, 40);
  }
  const boxX = doc.page.width - 40 - 200;
  doc.lineWidth(1).strokeColor(INK);
  doc.rect(boxX, 44, 70, 26).fillAndStroke(HEAD, INK);
  doc.rect(boxX + 70, 44, 130, 26).stroke();
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text("Date", boxX, 52, { width: 70, align: "center" });
  doc.font("Helvetica").text(longDate(sheet.date), boxX + 70, 52, { width: 130, align: "center" });
  doc.font("Helvetica-Bold").fontSize(11).text("DAILY PRODUCTION & STOCK STATEMENT", left + 110, 96, { width: width - 110, align: "center" });

  // ── A table: a band title, a heading row, then rows ──
  let y = 130;
  const grid = (top: number, h: number) => {
    doc.lineWidth(0.8).strokeColor(INK);
    doc.rect(left, top, width, h).stroke();
    doc.moveTo(left + firstW, top).lineTo(left + firstW, top + h).stroke();
    for (let i = 1; i < sizes.length; i++) doc.moveTo(colX(i), top).lineTo(colX(i), top + h).stroke();
  };
  const band = (title: string) => {
    doc.rect(left, y, width, rowH).fillAndStroke(HEAD, INK);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(title, left, y + 8, { width, align: "center" });
    y += rowH;
    doc.rect(left, y, width, rowH).fill(HEAD);
    grid(y, rowH);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text("Particulars", left, y + 8, { width: firstW, align: "center" });
    sizes.forEach((s, i) => doc.text(LABEL(s), colX(i), y + 8, { width: numW, align: "center" }));
    y += rowH;
  };
  const row = (label: string, values: (s: EggSize) => string, opts: { strong?: boolean; color?: (s: EggSize) => string } = {}) => {
    if (opts.strong) doc.rect(left, y, width, rowH).fill(HEAD);
    grid(y, rowH);
    doc.fillColor(INK).font(opts.strong ? "Helvetica-Bold" : "Helvetica").fontSize(10);
    doc.text(winAnsi(label), left, y + 8, { width: firstW, align: "center" });
    sizes.forEach((s, i) => {
      doc.fillColor(opts.color?.(s) ?? INK).text(values(s), colX(i), y + 8, { width: numW - 8, align: "right" });
    });
    y += rowH;
  };

  // ── Production Report ──
  band("Production Report");
  const sheds = sheet.rows.filter((r) => r.purpose === "layer" || r.entered);
  for (const r of sheds) row(r.code, (s) => n(r.boxes[s] ?? 0));
  const total = (s: EggSize) => sheds.reduce((a, r) => a + (r.boxes[s] ?? 0), 0);
  row("Total", (s) => n(total(s)), { strong: true });

  // ── Stock Summary ──
  y += 24;
  band("Stock Summary");
  const sum = (s: EggSize) => sheet.summary[s] ?? { opening: 0, production: 0, sales: 0, other: 0, closing: 0 };
  row("Opening Stock", (s) => n(sum(s).opening));
  row("(+) Production", (s) => n(sum(s).production));
  row("(-) Sales", (s) => n(sum(s).sales));
  // Only a hand-made stock adjustment lands here; the count never does.
  if (sizes.some((s) => sum(s).other)) row("(+/-) Adjustment", (s) => n(sum(s).other));
  row("Closing Stock", (s) => n(sum(s).closing), { strong: true });

  // ── The count, against the calculated closing ──
  if (sheet.count) {
    y += 10;
    row("Physical Count", (s) => n(sheet.count![s] ?? 0));
    row("Difference", (s) => {
      const v = sheet.variance?.[s] ?? 0;
      return v ? `${v > 0 ? "+" : ""}${v.toLocaleString("en-IN")}` : "-";
    }, { color: (s) => ((sheet.variance?.[s] ?? 0) !== 0 ? RED : INK) });
  }

  // ── The rules and the signature ──
  y += 30;
  const rules = [
    "Ensure the (+) Production row in Stock Summary exactly equals the Total row from the Production section.",
    "Carry forward yesterday's Closing Stock as today's Opening Stock without modification.",
    "Record (-) Sales entries strictly from authorized delivery challans or dispatch slips.",
    "Verify physical counts against calculated Closing Stock before submitting the report.",
  ];
  const rulesW = width * 0.6;
  const top = y;
  doc.fillColor(INK).font("Helvetica").fontSize(9.5);
  rules.forEach((t, i) => {
    doc.text(`${i + 1}.  ${t}`, left, y, { width: rulesW - 16 });
    y = doc.y + 4;
  });
  const sigX = left + rulesW;
  doc.lineWidth(0.8).strokeColor(INK).moveTo(sigX, top - 4).lineTo(sigX, y + 10).stroke();
  const lineY = Math.max(y, top + 80);
  if (sheet.submission) {
    doc.fillColor(INK).font("Helvetica").fontSize(9);
    doc.text(winAnsi(sheet.submission.submittedBy ?? "Submitted"), sigX + 20, lineY - 30, { width: width - rulesW - 20, align: "right" });
    doc.fillColor(MUTED).fontSize(8).text(stamp(sheet.submission.submittedAt), sigX + 20, lineY - 18, { width: width - rulesW - 20, align: "right" });
  }
  doc.strokeColor(INK).moveTo(sigX + 60, lineY).lineTo(left + width, lineY).stroke();
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text("Supervisor Signature", sigX + 20, lineY + 6, {
    width: width - rulesW - 20,
    align: "right",
  });
  if (!sheet.submission) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("Not yet submitted", sigX + 20, lineY + 20, { width: width - rulesW - 20, align: "right" });
  }

  doc.end();
  return done;
}
