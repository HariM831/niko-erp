/**
 * What a photo taken at the gate is stored as.
 *
 * Three kinds of photo, three budgets, because they are not the same problem.
 * A bill has to keep handwritten digits legible — a smudged 2 read as a 7 is
 * a wrong payable. A vehicle photo only has to keep the number plate legible,
 * and the rest of the frame is a decorated truck against a field, which eats
 * bytes and tells us nothing. A weigh slip is dot-matrix on white and barely
 * compresses at all.
 *
 * The numbers below are measured, not guessed: scripts/check-capture-spec.ts
 * proves each kind lands under its cap AND that a bill still extracts correctly
 * after being squeezed. Change one and re-run it.
 */
import sharp from "sharp";

export type CaptureKind = "bill" | "weighslip" | "vehicle";

export interface CaptureSpec {
  /** Longest edge, px. Never enlarges a photo that is already smaller. */
  maxEdge: number;
  quality: number;
  /** Hard ceiling. The encoder steps quality down until it fits. */
  maxBytes: number;
}

export const CAPTURE: Record<CaptureKind, CaptureSpec> = {
  // Handwriting. The most detail-hungry of the three, and the one where a
  // misread costs money, so it gets the largest budget.
  bill: { maxEdge: 1600, quality: 65, maxBytes: 100 * 1024 },
  // Dot-matrix on white paper: high contrast, compresses well.
  weighslip: { maxEdge: 1600, quality: 65, maxBytes: 80 * 1024 },
  // Only the plate matters. A busy outdoor scene compresses badly, so this one
  // gets a smaller edge rather than a lower quality — dropping quality on a
  // photograph smears the plate before it saves meaningful bytes.
  vehicle: { maxEdge: 1100, quality: 62, maxBytes: 100 * 1024 },
};

export interface Stamp {
  /** "Nalbari Feed Mill · Main gate", or "Location unavailable". */
  place: string;
  /** Device clock at capture. */
  capturedAt: Date;
  /** Shown small, so a drifted fix is visible rather than implied. */
  accuracyM?: number | null;
  /** Receipt number or plate — whatever identifies the thing photographed. */
  reference?: string | null;
}

const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

const stampTime = (d: Date) =>
  d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

/**
 * Burn a provenance band underneath the photo.
 *
 * Deliberately BELOW rather than across. A stamping app that writes over the
 * frame is fine on a truck and disastrous on a bill, where the overlay can land
 * on the grand total — and a figure hidden by our own watermark is a figure
 * nobody can audit. A band costs a couple of kilobytes and covers nothing.
 *
 * The band is a convenience for whoever is holding a printout. The authoritative
 * record is the columns on the attachment row; nothing reads this back.
 */
export async function stampImage(input: Buffer, stamp: Stamp): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 1000;

  // Scaled off the image so the band reads the same on any capture size.
  const pad = Math.round(width * 0.022);
  const big = Math.max(13, Math.round(width * 0.030));
  const small = Math.max(11, Math.round(width * 0.023));
  const band = pad * 2 + big + small + Math.round(big * 0.35);

  const line1 = esc(stamp.place);
  const accuracy = stamp.accuracyM != null ? `  ±${Math.round(stamp.accuracyM)} m` : "";
  const line2 = esc(`${stampTime(stamp.capturedAt)}${accuracy}`);
  const ref = stamp.reference ? esc(stamp.reference) : null;

  const svg = `<svg width="${width}" height="${band}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${band}" fill="#12161f"/>
    <text x="${pad}" y="${pad + big}" font-family="DejaVu Sans, Arial, sans-serif"
          font-size="${big}" font-weight="600" fill="#ffffff">${line1}</text>
    <text x="${pad}" y="${pad + big + Math.round(big * 0.35) + small}"
          font-family="DejaVu Sans, Arial, sans-serif" font-size="${small}" fill="#9aa4b8">${line2}</text>
    ${
      ref
        ? `<text x="${width - pad}" y="${pad + big}" text-anchor="end"
             font-family="DejaVu Sans, Arial, sans-serif" font-size="${big}"
             font-weight="600" fill="#6ba4fc">${ref}</text>`
        : ""
    }
  </svg>`;

  return sharp(input)
    .extend({ bottom: band, background: "#12161f" })
    .composite([{ input: Buffer.from(svg), top: meta.height ?? 0, left: 0 }])
    .toBuffer();
}

/**
 * Encode a captured photo to its budget, stamping it first when we know where
 * and when it was taken.
 *
 * The client does this before upload so nothing large crosses the boom's
 * connection, and the server does it again on receipt — a client can be
 * modified, and an unbounded image is both a storage problem and a bill from
 * the vision API. Stamping happens before the size check, so the band is inside
 * the budget rather than pushing past it.
 */
export async function encodeForCapture(
  input: Buffer,
  kind: CaptureKind,
  stamp?: Stamp,
): Promise<Buffer> {
  const spec = CAPTURE[kind];
  const resized = await sharp(input)
    .rotate() // honour the EXIF orientation before it is stripped
    .resize({ width: spec.maxEdge, height: spec.maxEdge, fit: "inside", withoutEnlargement: true })
    .toBuffer();

  const body = stamp ? await stampImage(resized, stamp) : resized;

  let quality = spec.quality;
  let out = await sharp(body).jpeg({ quality, mozjpeg: true }).toBuffer();

  // Step down rather than pick one quality and hope. A cluttered photograph can
  // miss the cap at a quality that a document clears easily.
  while (out.length > spec.maxBytes && quality > 35) {
    quality -= 8;
    out = await sharp(body).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  return out;
}
