/**
 * One person's payslip as a PDF file — the page "Print payslips" prints for
 * them, as a file HR can attach to that person's WhatsApp chat (8 Oct 2026:
 * Amino let her send each slip on its own; niko only printed the month's).
 *
 * Built on the server with pdfkit, as the owner statements are, so the file is
 * a real PDF the phone can open — not a browser print the sender has to save
 * first. Amounts are labelled INR once and printed bare: Helvetica here has no
 * rupee glyph (see owner-statement-pdf.ts).
 */
import PDFDocument from "pdfkit";
import { winAnsi } from "./owner-statement-pdf";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PAGE = { margin: 44, width: 595.28 } as const; // A4 portrait
const BRAND = "#850206";
const INK = "#111111";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";
const BAND = "#f9fafb";

const n = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => Math.round(n(v)).toLocaleString("en-IN");
const days = (v: unknown) => n(v).toLocaleString("en-IN", { maximumFractionDigits: 1 });

export interface PayslipSpec {
  company: string;
  month: number;
  year: number;
  slip: {
    name: string;
    empCode: string;
    department: string | null;
    designation: string | null;
    totalDays: number;
    paidDays: number;
    lopDays: number;
    bankName: string | null;
    bankAccountNumber: string | null;
    earnedBasic: unknown;
    earnedHra: unknown;
    earnedAllowances: unknown;
    earnedGross: unknown;
    bonus: unknown;
    overtime: unknown;
    arrears: unknown;
    reimbursement: unknown;
    pfEmployee: unknown;
    esiEmployee: unknown;
    professionalTax: unknown;
    otherDeductions: unknown;
    advanceRecovery: unknown;
    totalDeductions: unknown;
    netPay: unknown;
  };
}

/** "Payslip_E012_Sep_2026.pdf" — what the file is called on the phone. */
export function payslipFilename(empCode: string, month: number, year: number): string {
  return `Payslip_${empCode.replace(/[^\w-]/g, "")}_${MONTHS[month - 1]!.slice(0, 3)}_${year}.pdf`;
}

export function renderPayslip({ company, month, year, slip: s }: PayslipSpec): Promise<Buffer> {
  const period = `${MONTHS[month - 1]} ${year}`;
  const doc = new PDFDocument({ size: "A4", margin: PAGE.margin, info: { Title: `Payslip ${period} - ${s.name}`, Author: company } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const inner = right - left;
  let y = PAGE.margin;

  /* ── Heading ──────────────────────────────────────────────────────────── */
  doc.font("Helvetica-Bold").fontSize(17).fillColor(BRAND).text(winAnsi(company), left, y, { width: inner * 0.65 });
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(`Salary Slip - ${period}`, left, y + 24);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("Emp Code: ", left, y + 4, { width: inner, align: "right", continued: false });
  doc.font("Helvetica-Bold").fillColor(INK).text(winAnsi(s.empCode), left, y + 18, { width: inner, align: "right" });
  y += 44;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(2).strokeColor(BRAND).stroke();
  y += 14;

  /* ── Who, and the days ────────────────────────────────────────────────── */
  const lop = n(s.lopDays) > 0 ? ` (${days(s.lopDays)} LOP)` : "";
  const facts: Array<[string, string, boolean?]> = [
    ["EMPLOYEE NAME", s.name, true],
    ["DESIGNATION", s.designation ?? "-"],
    ["DEPARTMENT", s.department ?? "-"],
    ["WORKING DAYS", `${days(s.paidDays)} / ${s.totalDays} days${lop}`],
  ];
  if (s.bankName) facts.push(["BANK", s.bankName]);
  if (s.bankAccountNumber) facts.push(["ACCOUNT", `XXXX${s.bankAccountNumber.slice(-4)}`]);
  const factRows = Math.ceil(facts.length / 2);
  const factH = factRows * 32 + 12;
  doc.roundedRect(left, y, inner, factH, 5).fill(BAND);
  facts.forEach(([label, value, bold], i) => {
    const x = left + 10 + (i % 2) * (inner / 2);
    const fy = y + 8 + Math.floor(i / 2) * 32;
    doc.font("Helvetica").fontSize(7.5).fillColor("#888888").text(label, x, fy);
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor(INK).text(winAnsi(value), x, fy + 11, { width: inner / 2 - 20, lineBreak: false, ellipsis: true });
  });
  y += factH + 16;

  /* ── Earnings beside deductions ───────────────────────────────────────── */
  const earnings: Array<[string, unknown, boolean?]> = [
    ["Basic Salary", s.earnedBasic, true],
    ["HRA", s.earnedHra],
    ["Allowances", s.earnedAllowances],
    ["Bonus / Incentive", s.bonus],
    ["Overtime", s.overtime],
    ["Arrears (earlier period)", s.arrears],
    ["Expense Reimbursement", s.reimbursement],
  ];
  const deductions: Array<[string, unknown, boolean?]> = [
    ["PF (Employee)", s.pfEmployee],
    ["ESI (Employee)", s.esiEmployee],
    ["Professional Tax", s.professionalTax],
    ["Other Deductions", s.otherDeductions],
    ["Advance Recovery", s.advanceRecovery],
  ];
  const shown = (rows: Array<[string, unknown, boolean?]>) => rows.filter(([, v, always]) => always || n(v) !== 0);
  const earn = shown(earnings);
  const ded = shown(deductions);
  const gross = n(s.earnedGross) + n(s.bonus) + n(s.overtime) + n(s.reimbursement) + n(s.arrears);
  const lineH = 20;
  const bodyRows = Math.max(earn.length, ded.length, 1);
  const half = inner / 2;
  const boxH = 22 + bodyRows * lineH + 26;

  doc.lineWidth(1).strokeColor(RULE).roundedRect(left, y, inner, boxH, 5).stroke();
  doc.moveTo(left + half, y).lineTo(left + half, y + boxH).stroke();
  const column = (x: number, title: string, tint: string, ink: string, rows: Array<[string, unknown, boolean?]>, totalLabel: string, total: number) => {
    doc.rect(x + 0.5, y + 0.5, half - 1, 21).fill(tint);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(ink).text(`${title} (INR)`, x + 8, y + 7);
    rows.forEach(([label, v], i) => {
      const ry = y + 22 + i * lineH + 5;
      doc.font("Helvetica").fontSize(10).fillColor("#555555").text(label, x + 8, ry);
      doc.fillColor(INK).text(money(v), x, ry, { width: half - 8, align: "right" });
    });
    const ty = y + 22 + bodyRows * lineH;
    doc.rect(x + 0.5, ty, half - 1, 25.5).fill(tint);
    doc.moveTo(x, ty).lineTo(x + half, ty).strokeColor(RULE).stroke();
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(totalLabel, x + 8, ty + 8);
    doc.text(money(total), x, ty + 8, { width: half - 8, align: "right" });
  };
  column(left, "EARNINGS", "#f0fdf4", "#166534", earn, "Gross Earnings", gross);
  column(left + half, "DEDUCTIONS", "#fef2f2", "#991b1b", ded, "Total Deductions", n(s.totalDeductions));
  y += boxH + 14;

  /* ── Take-home ────────────────────────────────────────────────────────── */
  doc.roundedRect(left, y, inner, 40, 5).fill(BRAND);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#ffffff").text("NET TAKE-HOME (INR)", left + 14, y + 14);
  doc.fontSize(17).text(money(s.netPay), left, y + 11, { width: inner - 14, align: "right" });
  y += 54;

  doc.font("Helvetica").fontSize(8).fillColor("#aaaaaa").text("This is a computer-generated payslip and does not require a signature.", left, y, { width: inner, align: "center" });

  doc.end();
  return done;
}
