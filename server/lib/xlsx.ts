import { deflateRawSync } from "node:zlib";

/**
 * A minimum viable .xlsx writer.
 *
 * The one thing niko needs to emit as a spreadsheet is a bank payment file — a
 * single flat sheet whose column formats the bank's upload parser is fussy
 * about: an account number must arrive as text or its leading zeros are gone,
 * an amount must be a number, a date must be a date. That is a small enough job
 * that pulling in a spreadsheet library, and the several hundred packages
 * behind it, would cost more than it buys.
 *
 * So: one sheet, inline strings, and a fixed stylesheet of the six cell shapes
 * a bank file uses. No formulas, no merges, no second sheet. Anything richer
 * than that should reach for a real library rather than growing this one.
 */

/** The cell shapes the fixed stylesheet below knows how to render. */
export type CellStyle = "plain" | "header" | "text" | "number" | "money" | "date";

export interface Cell {
  /** A date is passed as "YYYY-MM-DD" with style "date"; everything else as-is. */
  value: string | number | null | undefined;
  style?: CellStyle;
}

export interface Sheet {
  name: string;
  /** Column widths in Excel's character units, left to right. */
  columnWidths: number[];
  rows: Cell[][];
}

/** Index into the cellXfs list built in STYLES_XML — order matters. */
const STYLE_INDEX: Record<CellStyle, number> = {
  plain: 0,
  header: 1,
  text: 2,
  number: 3,
  money: 4,
  date: 5,
};

/** Excel rejects the control characters XML 1.0 forbids outright. */
const FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(FORBIDDEN, "");

/** A1, B1, ... Z1, AA1 — 1-indexed column. */
function cellRef(col: number, row: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return `${name}${row}`;
}

/**
 * Excel's day number for a date, counting from its own epoch.
 *
 * 1899-12-30 rather than 12-31 because Excel believes 1900 was a leap year and
 * the offset absorbs the phantom day, which is why every spreadsheet in the
 * world agrees that 1 = 1900-01-01.
 */
export function excelSerial(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const utc = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function cellXml(cell: Cell, ref: string): string {
  const style = cell.style ?? "plain";
  const s = STYLE_INDEX[style];
  const attrs = `r="${ref}"${s ? ` s="${s}"` : ""}`;
  const value = cell.value;
  if (value === null || value === undefined || value === "") return `<c ${attrs}/>`;
  if (style === "date") return `<c ${attrs}><v>${excelSerial(String(value))}</v></c>`;
  if (style === "number" || style === "money") {
    const n = Number(value);
    if (!Number.isFinite(n)) return `<c ${attrs}/>`;
    return `<c ${attrs}><v>${n}</v></c>`;
  }
  // Everything else goes out as an inline string: no shared-string table to
  // keep in step, and a bank file is written once and never edited here.
  return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/**
 * numFmt 49 is Excel's built-in "@" (text) — the one that keeps an account
 * number's leading zeros; 2 is "0.00"; 164 is the d-mm-yyyy the bank's own
 * template uses.
 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="d\\-mm\\-yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function sheetXml(sheet: Sheet): string {
  const width = Math.max(sheet.columnWidths.length, ...sheet.rows.map((r) => r.length), 1);
  const cols = sheet.columnWidths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");
  const rows = sheet.rows
    .map((cells, i) => {
      const r = i + 1;
      const body = cells.map((c, j) => cellXml(c, cellRef(j + 1, r))).join("");
      return `<row r="${r}" spans="1:${width}">${body}</row>`;
    })
    .join("");
  const dimension = `A1:${cellRef(width, Math.max(sheet.rows.length, 1))}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="14.4"/>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData></worksheet>`;
}

const workbookXml = (sheet: Sheet) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet.name).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

/* ══ ZIP container ═══════════════════════════════════════════════════════ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A ZIP of exactly these parts, deflated, with no directory entries and no
 * ZIP64: a payment file is kilobytes, and every field below is fixed-width.
 * The timestamp is pinned to the epoch DOS understands so two runs over the
 * same data produce byte-identical files.
 */
function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date — 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // deflate
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDirectory, end]);
}

/** Render one sheet as a .xlsx file. */
export function buildXlsx(sheet: Sheet): Buffer {
  const utf8 = (s: string) => Buffer.from(s, "utf8");
  return zip([
    { name: "[Content_Types].xml", data: utf8(CONTENT_TYPES) },
    { name: "_rels/.rels", data: utf8(ROOT_RELS) },
    { name: "xl/workbook.xml", data: utf8(workbookXml(sheet)) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(WORKBOOK_RELS) },
    { name: "xl/styles.xml", data: utf8(STYLES_XML) },
    { name: "xl/worksheets/sheet1.xml", data: utf8(sheetXml(sheet)) },
  ]);
}
