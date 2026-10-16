/**
 * Reads a bank statement PDF into the same shape the CSV import gives: a header
 * row and data rows of strings, which the Map Fields step then maps as usual.
 *
 * Statement PDFs have no cells, only text placed on a page, so the table is
 * rebuilt from positions: the header line ("… Date … Debit … Credit …") fixes the
 * columns, every word goes to the column it sits under, a line whose first
 * column holds a date starts a transaction, and the lines below it (wrapped
 * narrations, references) join that transaction. Anything else in the first
 * column, such as a page footer, ends the table until the header repeats.
 */

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

interface Line {
  y: number;
  items: PdfTextItem[];
}

interface Column {
  name: string;
  x0: number;
  x1: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** True for the dates bank statements print: 7 Oct 2026, 07-Oct-2026, 07/10/2026, 2026-10-07. */
export function looksLikeDate(s: string): boolean {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(t)) return true;
  const m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{2,4})$/.exec(t);
  return !!m && MONTHS.includes(m[2]!.toLowerCase());
}

function groupLines(items: PdfTextItem[]): Line[] {
  const sorted = items.filter((i) => i.str.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - it.y) <= 2.5) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

const lineText = (l: Line) => l.items.map((i) => i.str).join(" ").toLowerCase();

function isHeaderLine(l: Line): boolean {
  const t = lineText(l);
  return t.includes("date") && /debit|withdrawal|\bdr\b/.test(t) && /credit|deposit|\bcr\b/.test(t);
}

/** Header words close together are one column name ("Txn" "Date" → "Txn Date"). */
function columnsFrom(header: Line): Column[] {
  const cols: Column[] = [];
  for (const it of header.items) {
    const last = cols[cols.length - 1];
    if (last && it.x - last.x1 < 6) {
      last.name += " " + it.str.trim();
      last.x1 = it.x + it.width;
    } else cols.push({ name: it.str.trim(), x0: it.x, x1: it.x + it.width });
  }
  return cols;
}

/** The column a word belongs to: the one it overlaps most, else the nearest. */
function columnOf(cols: Column[], it: PdfTextItem): number {
  const a = it.x;
  const b = it.x + it.width;
  let best = 0;
  let bestOverlap = 0;
  cols.forEach((c, i) => {
    const overlap = Math.min(b, c.x1) - Math.max(a, c.x0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  });
  if (bestOverlap > 0) return best;
  const mid = (a + b) / 2;
  let bestDist = Infinity;
  cols.forEach((c, i) => {
    const d = Math.abs(mid - (c.x0 + c.x1) / 2);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/**
 * An item that runs across columns is split into words, each placed by its
 * share of the item's width. Some banks print "7 Oct 2026 7 Oct 2026" as one
 * piece of text across Txn Date and Value Date.
 */
function splitAcross(cols: Column[], it: PdfTextItem): PdfTextItem[] {
  const spans = cols.filter((c) => Math.min(it.x + it.width, c.x1) - Math.max(it.x, c.x0) > 0).length;
  if (spans < 2 || !it.str.includes(" ")) return [it];
  const perChar = it.width / it.str.length;
  const words: PdfTextItem[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(it.str))) words.push({ str: m[0], x: it.x + m.index * perChar, y: it.y, width: m[0].length * perChar });
  return words;
}

export function tableFromPages(pages: PdfTextItem[][]): { headers: string[]; rows: string[][] } {
  let cols: Column[] | null = null;
  let named = false;
  const rows: string[][] = [];

  for (const items of pages) {
    const lines = groupLines(items);
    let inTable = false;
    let pageCols: Column[] | null = null;
    let current: string[] | null = null;
    let headerY = 0;

    for (const line of lines) {
      if (isHeaderLine(line)) {
        pageCols = columnsFrom(line);
        if (!cols) cols = pageCols.map((c) => ({ ...c }));
        inTable = true;
        current = null;
        headerY = line.y;
        continue;
      }
      if (!inTable || !pageCols) continue;

      const cells: string[][] = pageCols.map(() => []);
      for (const it of line.items.flatMap((i) => splitAcross(pageCols!, i))) cells[columnOf(pageCols, it)]!.push(it.str.trim());
      const first = cells[0]!.join(" ");

      // A second header line ("No." under "Ref No./Cheque", "Code" under
      // "Branch") sits just below the first and before any transaction.
      if (!current && headerY - line.y < 14 && !looksLikeDate(first)) {
        if (!named) cells.forEach((c, i) => c.length && (cols![i]!.name += " " + c.join(" ")));
        continue;
      }

      named = true;
      if (first && looksLikeDate(first)) {
        current = cells.map((c) => c.join(" "));
        rows.push(current);
      } else if (first) {
        inTable = false;
        current = null;
      } else if (current) {
        cells.forEach((c, i) => {
          if (c.length) current![i] = (current![i] ? current![i] + " " : "") + c.join(" ");
        });
      }
    }
  }

  if (!cols) return { headers: [], rows: [] };
  return { headers: cols.map((c) => c.name), rows: rows.map((r) => r.map((s) => s.replace(/\s+/g, " ").trim())) };
}

/** Loads pdf.js only when a PDF is chosen; the CSV path never pays for it. */
export async function readPdfStatement(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: PdfTextItem[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    pages.push(
      content.items.flatMap((i) =>
        "str" in i ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, width: i.width }] : [],
      ),
    );
  }
  return tableFromPages(pages);
}
