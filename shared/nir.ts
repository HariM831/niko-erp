/**
 * The NIR bench's vocabulary, shared by the reader in the browser and the
 * matcher on the server.
 */

/**
 * A sample name or a receipt number folded so the two can be compared.
 *
 * The technician types the GR number into IAS by hand, so "gr 26", "GR-26",
 * "GR26" and "GR-00026" must all land on the same truck: upper-case, nothing
 * but letters and digits, and no leading zeros inside a run of digits.
 * Applied to BOTH sides, so it works for whatever prefix a number series uses.
 * Null for a name with no digits in it — IAS's untouched default is a model
 * prefix like "Sfrf20", which does have digits, but never matches a receipt.
 */
export function sampleKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const folded = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/\d+/g, (run) => String(Number(run)));
  return /\d/.test(folded) ? folded.slice(0, 60) : null;
}

/**
 * What a QC spec calls each figure the analyser reports.
 *
 * The instrument's spelling is not consistent even within one vendor's models
 * ("fibre" and "Fibre", "oil" and "Oil"), so names are compared folded. Oil on
 * an NIR report is the ether extract a spec calls fat; SS on a soya-meal model
 * is sand and silica. Anything not listed is still kept on the scan and shown,
 * but it fills no QC field.
 */
const ALIASES: Record<string, string> = {
  moisture: "moisture",
  water: "moisture",
  protein: "protein",
  crudeprotein: "protein",
  cp: "protein",
  oil: "fat",
  fat: "fat",
  ee: "fat",
  etherextract: "fat",
  fibre: "fiber",
  fiber: "fiber",
  crudefibre: "fiber",
  crudefiber: "fiber",
  cf: "fiber",
  ss: "sand_silica",
  sandsilica: "sand_silica",
};

export function qcParameterFor(instrumentName: string): string | null {
  return ALIASES[instrumentName.toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

/**
 * A reading the model reports on a dry-matter basis — "Protein (DM)".
 *
 * Specs and vendor terms are as received, so such a figure is converted with
 * the same scan's own moisture before it goes anywhere near a limit (the user,
 * 3 Oct 2026): as received = DM × (100 − moisture) / 100. Returns the name
 * with the basis taken off, or null for an as-received reading.
 */
export function dryMatterBase(instrumentName: string): string | null {
  const m = instrumentName.match(/^(.*?)\s*[([]\s*(?:DM|DB|dry\s*matter|dry\s*basis)\s*[)\]]\s*$/i)
    ?? instrumentName.match(/^(.*?)\s*[-_ ]\s*(?:DM|DB)$/i);
  return m ? m[1]!.trim() : null;
}

export const asReceived = (dryMatterValue: number, moisturePct: number) =>
  (dryMatterValue * (100 - moisturePct)) / 100;

/** One scan as the bench uploads it. */
export interface NirUploadRow {
  iasId: number;
  resultSn: string;
  deviceSn: string;
  model: string;
  modelVersion: string | null;
  sampleName: string | null;
  /** ISO with offset. IAS writes local time with none; the reader adds IST. */
  scannedAt: string;
  iasStatus: number | null;
  readings: Record<string, number>;
  flags: Record<string, number>;
  raw: unknown;
}

export interface NirUploadModel {
  shortName: string;
  modelName: string | null;
  version: string | null;
  matterNames: Record<string, string>;
}

/** What QC keeps on a receipt line when the NIR supplied the readings. */
export interface QcNirRecord {
  results: string[];
  average: Record<string, number>;
  instrument?: Record<string, number>;
  edited?: string[];
  flagged?: string[];
  fromDryMatter?: string[];
}

const LABEL: Record<string, string> = {
  moisture: "Moisture",
  protein: "Protein",
  fat: "Fat",
  fiber: "Fibre",
  sand_silica: "Sand silica",
};

/**
 * The NIR's part of a line's QC, written out as a remark a person can read on
 * the goods receipt: what was measured, on what basis, and what was changed.
 *
 *   NIR, 2 scans averaged: Moisture 6.023% · Protein 9.554% (DM 10.166) ·
 *   Fat 3.465% (DM 3.687) · Starch (DM) 63.579
 */
export function nirRemark(nir: QcNirRecord | null | undefined): string | null {
  if (!nir?.results?.length) return null;
  const fmt = (v: number) => Number(v.toFixed(3)).toString();
  const order = Object.keys(LABEL);
  const rank = (p: string) => (order.indexOf(p) + 1 || order.length + 1);
  const instrument = nir.instrument ?? {};
  const dmFor = (param: string) =>
    Object.entries(instrument).find(([n]) => {
      const base = dryMatterBase(n);
      return base != null && qcParameterFor(base) === param;
    })?.[1];
  const parts = Object.entries(nir.average)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([p, v]) => {
    const dm = nir.fromDryMatter?.includes(p) ? dmFor(p) : undefined;
    const typed = nir.edited?.includes(p) ? ", typed over" : "";
    const flag = nir.flagged?.includes(p) ? ", flagged by the instrument" : "";
    return `${LABEL[p] ?? p} ${fmt(v)}%${dm != null ? ` (DM ${fmt(dm)})` : ""}${typed}${flag}`;
  });
  // Readings no QC parameter takes — starch, NDF, ash — as the instrument gave them.
  const others = Object.entries(instrument)
    .filter(([n]) => !qcParameterFor(dryMatterBase(n) ?? n))
    .map(([n, v]) => `${n} ${fmt(v)}`);
  const n = nir.results.length;
  return `NIR, ${n === 1 ? "1 scan" : `${n} scans averaged`}: ${[...parts, ...others].join(" · ")}`;
}
