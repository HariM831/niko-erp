/**
 * The supporting statement that goes on an owner's document, as a PDF.
 *
 * One statement per document, and each shows only its own trade: the feed
 * invoice gets the feed, the pullet invoice gets the pullets, the egg bill gets
 * the eggs. A statement that also listed the other two would invite somebody to
 * add up the wrong column and query a number that is not on the invoice in
 * front of them.
 *
 * A note on the rupee sign: pdfkit's built-in Helvetica is WinAnsi-encoded and
 * has no glyph for it, so it renders as rubbish. Amounts are therefore labelled
 * "INR" in the heading and printed bare, which is what an accounting document
 * does anyway — the currency is stated once, not on every line.
 *
 * Built with pdfkit rather than printed from the browser, because these are
 * generated on the server at the moment the documents post and have to be
 * identical to what was billed — a page rendered later from live data is a
 * different document wearing the same name.
 */
import PDFDocument from "pdfkit";

/** A rupee figure, grouped Indian-style. Bare — the currency is in the header. */
const money = (v: number) =>
  v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (v: number, dp = 0) =>
  v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const dmy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

export interface Column {
  /** The heading. */
  label: string;
  /** How wide, in points. */
  width: number;
  align?: "left" | "right";
}

export interface StatementSpec {
  /** "Feed supplied", "Pullets supplied", "Eggs purchased". */
  title: string;
  /** The document this explains, e.g. "Invoice INV-000012". */
  document: string;
  orgName: string;
  ownerName: string;
  /** Which way the trade went, in words. */
  direction: string;
  from: string;
  to: string;
  sheds: string;
  columns: Column[];
  rows: Array<Array<string | number>>;
  /** The last row, printed in bold with a rule above it. */
  total: Array<string | number>;
  /** Printed under the table — the rate basis, or anything that needs saying. */
  notes?: string[];
}

/**
 * Cut a cell down to one line, with three dots when it does not fit.
 *
 * Every row is drawn at a known y and the next row follows a fixed distance
 * below, so a cell that wraps writes its second line straight through the row
 * underneath. Better a shortened item name than two rows on top of each other —
 * and the document number beside it is what identifies the line anyway.
 */
/**
 * Fold the characters the built-in fonts cannot draw.
 *
 * Helvetica here is WinAnsi-encoded: the rupee sign and the em dash come out as
 * nothing at all, which turns "spread — the rate" into "spread  the rate" and
 * reads like a typo rather than an encoding problem. Cheaper to write plain
 * punctuation than to ship a font file for two glyphs.
 */
function winAnsi(text: string): string {
  return text
    .replace(/₹\s*/g, "")
    .replace(/\s*[—–]\s*/g, " - ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/→/g, "->");
}

function clamp(doc: PDFKit.PDFDocument, raw: string, width: number): string {
  const text = winAnsi(raw);
  if (doc.widthOfString(text) <= width) return text;
  let cut = text;
  while (cut.length > 1 && doc.widthOfString(`${cut}...`) > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

const PAGE = { margin: 40, width: 595.28 } as const; // A4 portrait
const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#d1d5db";
const BAND = "#f3f4f6";

/**
 * Render one statement.
 *
 * Returns the finished bytes rather than a stream: the caller writes it beside
 * an attachment row, and a half-written file with a row pointing at it is worse
 * than no file at all.
 */
export function renderStatement(spec: StatementSpec): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE.margin,
    info: { Title: `${spec.title} — ${spec.ownerName}`, Author: spec.orgName },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const inner = right - left;

  /* ── Heading ──────────────────────────────────────────────────────────── */
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(winAnsi(spec.title), left, left);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(winAnsi(`Supporting statement to ${spec.document}`), { width: inner });
  doc.moveDown(0.8);

  const facts: Array<[string, string]> = [
    [spec.direction, `${spec.orgName}  ·  ${spec.ownerName}`],
    ["Period", `${dmy(spec.from)} to ${dmy(spec.to)}`],
    ["Sheds", spec.sheds || "-"],
  ];
  for (const [k, v] of facts) {
    const y = doc.y;
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(winAnsi(k), left, y, { width: 70 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(winAnsi(v), left + 74, y, { width: inner - 74 });
  }
  doc.moveDown(1);

  /* ── Table ────────────────────────────────────────────────────────────── */
  //
  // Laid out by hand because pdfkit has no table: the columns are measured in
  // points and every row is drawn at a known y, which is also what makes the
  // page break predictable.
  const totalWidth = spec.columns.reduce((s, c) => s + c.width, 0);
  const scale = inner / totalWidth;
  const widths = spec.columns.map((c) => c.width * scale);
  const xs: number[] = [];
  let x = left;
  for (const w of widths) {
    xs.push(x);
    x += w;
  }

  const ROW = 15;
  const drawHead = () => {
    const y = doc.y;
    doc.rect(left, y - 3, inner, ROW + 2).fill(BAND);
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    spec.columns.forEach((c, i) => {
      doc.text(clamp(doc, c.label.toUpperCase(), widths[i]! - 6), xs[i]! + 3, y + 1, {
        width: widths[i]! - 6,
        align: c.align ?? "left",
        lineBreak: false,
      });
    });
    doc.y = y + ROW + 3;
  };

  drawHead();
  doc.font("Helvetica").fontSize(8.5).fillColor(INK);
  for (const row of spec.rows) {
    // A new page repeats the heading — a column of bare numbers on page two
    // with no headings is unreadable.
    if (doc.y > 780) {
      doc.addPage();
      doc.y = PAGE.margin;
      drawHead();
      doc.font("Helvetica").fontSize(8.5).fillColor(INK);
    }
    const y = doc.y;
    spec.columns.forEach((c, i) => {
      doc.text(clamp(doc, String(row[i] ?? ""), widths[i]! - 6), xs[i]! + 3, y, {
        width: widths[i]! - 6,
        align: c.align ?? "left",
        lineBreak: false,
      });
    });
    doc
      .moveTo(left, y + ROW - 4)
      .lineTo(right, y + ROW - 4)
      .strokeColor("#eeeeee")
      .lineWidth(0.5)
      .stroke();
    doc.y = y + ROW - 2;
  }

  /* ── Total ────────────────────────────────────────────────────────────── */
  const ty = doc.y + 2;
  doc.moveTo(left, ty).lineTo(right, ty).strokeColor(RULE).lineWidth(1).stroke();
  doc.y = ty + 4;
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(INK);
  spec.columns.forEach((c, i) => {
    doc.text(clamp(doc, String(spec.total[i] ?? ""), widths[i]! - 6), xs[i]! + 3, y, {
      width: widths[i]! - 6,
      align: c.align ?? "left",
      lineBreak: false,
    });
  });
  doc.y = y + ROW;

  if (spec.notes?.length) {
    doc.moveDown(0.8);
    doc.font("Helvetica").fontSize(8).fillColor(MUTED);
    for (const note of spec.notes) doc.text(winAnsi(note), left, doc.y, { width: inner });
  }

  doc.end();
  return done;
}
