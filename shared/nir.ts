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
