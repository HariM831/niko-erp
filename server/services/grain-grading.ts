/**
 * Grading a plate of maize from a photograph.
 *
 * The same division of labour as the bill reader in ocr.ts: **the model looks,
 * the server decides.** Claude is asked only for what it can see — how many
 * kernels, and how many of them are mouldy, bored, off-colour, broken or small,
 * plus any foreign matter and live insects. Every percentage is arithmetic done
 * here, where it is testable (scripts/check-grain-grading.ts) and cannot be
 * talked out of an answer.
 *
 * WHY THE PHOTO IS CUT INTO TILES. A phone photo of a plate holds 250–350
 * kernels, each a few dozen pixels across. Asked to count the whole plate in
 * one look, a model drifts by ten or twenty percent — the same mistake a person
 * makes. Counting a quarter of the plate at a time, with the counting area
 * boxed and a margin around it, is how the bench was checked by hand on
 * 5 Oct 2026 (four samples, every count within a few kernels of a careful
 * recount), so it is how the model is asked to do it.
 *
 * Each kernel belongs to the tile its CENTRE falls in. The margin is there so a
 * kernel cut by the box edge is still recognisable, not so it is counted twice.
 *
 * WHAT THE NUMBERS ARE. Percentages BY COUNT, not by weight. A bench that
 * weighs its fractions will read broken and immature lower than this, because
 * a broken piece weighs less than a whole kernel. The figures are a starting
 * point the technician confirms — the QC screen fills the boxes, the person
 * presses Confirm, and the spec, as always, decides.
 */
import Anthropic from "@anthropic-ai/sdk";
import sharp, { type Sharp } from "sharp";

/**
 * Overridable by env so a model change is a variable, not a deploy — the same
 * reasoning as OCR_MODEL_BILL. The model name actually used is recorded on
 * every grading so a change in behaviour stays attributable.
 */
export const GRADING_MODEL = process.env.GRADING_MODEL || "claude-opus-5-5";

/** Longest edge the photo is normalised to before tiling — Claude's own high-resolution ceiling. */
const NORMALISE_EDGE = 2576;
/** At or under this, the photo is graded whole: too small to cut up usefully. */
const TILE_THRESHOLD = 800;
/**
 * Each tile is sent at this long edge, ENLARGED if need be. The model sees an
 * image in 28-px patches; on a WhatsApp-sized 1280-px photo a kernel is about
 * 30 px, one patch, and a bore hole is invisible. Enlarging a quarter of the
 * plate to this size puts several patches across every kernel. It costs tokens
 * (about 2,400 a tile) and is the cheapest accuracy available.
 */
const TILE_EDGE = 1568;
/** Margin around each tile's counting box, as a share of the tile's size. */
const TILE_MARGIN = 0.07;
/** Below this many kernels a percentage swings a point per kernel — say so. */
const MIN_RELIABLE_KERNELS = 150;

/**
 * Foreign matter is reported as pieces, and a piece of chaff is not a kernel.
 * These weights turn pieces into kernel-equivalents so a percentage can be
 * offered at all; it is the weakest number on the screen and is labelled so.
 */
const FM_KERNEL_EQUIVALENT = { small: 0.25, medium: 1, large: 3 } as const;

export const GRADE_KEYS = ["fungus", "damaged_grain", "discoloured", "broken", "immature"] as const;
export type GradeKey = (typeof GRADE_KEYS)[number];

export interface RawTile {
  tile: number;
  kernels: number;
  fungus: number;
  damaged_grain: number;
  discoloured: number;
  broken: number;
  immature: number;
  foreign_matter: Array<{ what: string; size: "small" | "medium" | "large" }>;
  live_insects: number;
}

export interface RawGrading {
  is_maize_sample: boolean;
  photo_quality: "good" | "usable" | "poor";
  photo_issues: string[];
  tiles: RawTile[];
  /** Things the technician should look at with their own eyes. */
  observations: string[];
}

export interface Grading {
  grainCount: number;
  /** Kernels in each category. A kernel is in at most one. */
  counts: Record<GradeKey, number>;
  foreignMatter: Array<{ what: string; size: "small" | "medium" | "large" }>;
  liveInsects: number;
  /** Keyed the way a QC spec names its parameters, ready for the reading boxes. */
  readings: Record<GradeKey | "foreign_matter" | "live_insects", number | null>;
  observations: string[];
  photoQuality: RawGrading["photo_quality"];
  warnings: string[];
  model: string;
  tiles: number;
}

export interface GradingUsage {
  inputTokens: number;
  outputTokens: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const whole = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

/**
 * Everything decided about what the model saw, with the model out of the loop.
 * Checked without an API call by scripts/check-grain-grading.ts.
 */
export function reconcileGrading(raw: RawGrading, model: string): Grading {
  const warnings: string[] = [];
  const counts = Object.fromEntries(GRADE_KEYS.map((k) => [k, 0])) as Record<GradeKey, number>;
  const foreignMatter: Grading["foreignMatter"] = [];
  let grainCount = 0;
  let liveInsects = 0;

  for (const t of raw.tiles ?? []) {
    const kernels = whole(t.kernels);
    grainCount += kernels;
    let defects = 0;
    for (const k of GRADE_KEYS) {
      let n = whole(t[k]);
      // More mouldy kernels than kernels is a misread, not a finding. Capped
      // rather than refused: the rest of the tile is still worth having.
      if (n > kernels) {
        warnings.push(`Tile ${t.tile}: ${n} ${k.replace(/_/g, " ")} out of ${kernels} kernels — capped`);
        n = kernels;
      }
      counts[k] += n;
      defects += n;
    }
    if (defects > kernels) {
      warnings.push(
        `Tile ${t.tile}: ${defects} defects among ${kernels} kernels — a kernel was put in two categories`,
      );
    }
    for (const f of t.foreign_matter ?? []) {
      const size = f?.size === "large" || f?.size === "small" ? f.size : "medium";
      foreignMatter.push({ what: String(f?.what ?? "unidentified").slice(0, 80), size });
    }
    liveInsects += whole(t.live_insects);
  }

  const pct = (n: number) => (grainCount > 0 ? round2((n / grainCount) * 100) : null);
  const fmEquivalent = foreignMatter.reduce((s, f) => s + FM_KERNEL_EQUIVALENT[f.size], 0);

  const readings: Grading["readings"] = {
    fungus: pct(counts.fungus),
    damaged_grain: pct(counts.damaged_grain),
    discoloured: pct(counts.discoloured),
    broken: pct(counts.broken),
    immature: pct(counts.immature),
    foreign_matter: pct(fmEquivalent),
    live_insects: liveInsects,
  };

  if (!raw.is_maize_sample) {
    // Nothing is filled in for a photo of something else: a confident set of
    // percentages for a plate of soya would be worse than none.
    warnings.unshift("This does not look like a maize sample — nothing was filled in");
    for (const k of Object.keys(readings) as Array<keyof typeof readings>) readings[k] = null;
  } else if (grainCount === 0) {
    warnings.unshift("No kernels were counted — retake the photo");
  } else if (grainCount < MIN_RELIABLE_KERNELS) {
    warnings.push(
      `Only ${grainCount} kernels — each one moves a figure by ${round2(100 / grainCount)}%. Spread a fuller sample`,
    );
  }
  if (raw.photo_quality === "poor") {
    warnings.unshift("Poor photo — treat these figures as rough and retake if you can");
  }
  for (const issue of raw.photo_issues ?? []) warnings.push(`Photo: ${issue}`);

  return {
    grainCount,
    counts,
    foreignMatter,
    liveInsects,
    readings,
    observations: (raw.observations ?? []).map((o) => String(o).slice(0, 300)).slice(0, 12),
    photoQuality: raw.photo_quality ?? "usable",
    warnings,
    model,
    tiles: (raw.tiles ?? []).length,
  };
}

// ───────────────────────────── Tiling ─────────────────────────────

/**
 * Where the grain is in the frame.
 *
 * Bench photos are a plate in the middle of a table, a knife, a knee. Every
 * pixel of table sent to the model is a pixel not spent on a kernel, so the
 * photo is cropped to the yellow-orange of the maize, with a margin. If too
 * little of the frame is maize-coloured to trust that, the whole frame is used.
 */
async function grainBounds(img: Buffer): Promise<{ left: number; top: number; width: number; height: number }> {
  const meta = await sharp(img).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const whole = { left: 0, top: 0, width: W, height: H };
  const S = 200;
  const { data, info } = await sharp(img)
    .resize({ width: S, height: S, fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      // Maize: red and green well above blue, red at least green, bright.
      if (r > 150 && g > 90 && r >= g && r - b > 70 && g - b > 35) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < info.width * info.height * 0.02) return whole;

  // Percentiles, not the extremes: a few kernels spilled on the floor, or a
  // bag of the rejected fraction at the edge of the frame, must not drag the
  // crop out to the corners. The padding brings back the plate's outer ring.
  const at = (v: number[], q: number) => v.sort((a, b) => a - b)[Math.floor((v.length - 1) * q)]!;
  const x0 = at(xs, 0.005), x1 = at(xs, 0.995);
  const y0 = at(ys, 0.005), y1 = at(ys, 0.995);

  const sx = W / info.width;
  const sy = H / info.height;
  const padX = (x1 - x0 + 1) * 0.08 * sx;
  const padY = (y1 - y0 + 1) * 0.08 * sy;
  const left = Math.max(0, Math.floor(x0 * sx - padX));
  const top = Math.max(0, Math.floor(y0 * sy - padY));
  const right = Math.min(W, Math.ceil((x1 + 1) * sx + padX));
  const bottom = Math.min(H, Math.ceil((y1 + 1) * sy + padY));
  // A crop that keeps nearly everything is not worth the risk of clipping.
  if ((right - left) * (bottom - top) > W * H * 0.9) return whole;
  return { left, top, width: right - left, height: bottom - top };
}

interface Tile {
  n: number;
  jpeg: Buffer;
}

/**
 * The overview the model orients itself by, and the boxed tiles it counts in.
 *
 * Exported so the check script can write the tiles to disk and a person can
 * look at exactly what the model was shown.
 */
export async function tilePhoto(input: Buffer): Promise<{ overview: Buffer; tiles: Tile[] }> {
  const upright = await sharp(input).rotate().toBuffer(); // EXIF orientation before anything is measured
  const box = await grainBounds(upright);
  const base = await sharp(upright)
    .extract(box)
    .resize({ width: NORMALISE_EDGE, height: NORMALISE_EDGE, fit: "inside", withoutEnlargement: true })
    .toBuffer();
  const meta = await sharp(base).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("The photo could not be read");

  const jpeg = (b: Buffer | Sharp) =>
    (Buffer.isBuffer(b) ? sharp(b) : b).jpeg({ quality: 88 }).toBuffer();

  if (Math.max(W, H) <= TILE_THRESHOLD) {
    const whole = await jpeg(sharp(base).resize({ width: TILE_EDGE, height: TILE_EDGE, fit: "inside" }));
    return { overview: whole, tiles: [{ n: 1, jpeg: whole }] };
  }

  const cols = 2;
  const rows = 2;
  const tw = Math.ceil(W / cols);
  const th = Math.ceil(H / rows);
  const stroke = Math.max(3, Math.round(Math.max(W, H) / 600));

  const tiles: Tile[] = [];
  const grid: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const n = r * cols + c + 1;
      const x0 = c * tw;
      const y0 = r * th;
      const x1 = Math.min(W, x0 + tw);
      const y1 = Math.min(H, y0 + th);
      const mx = Math.round((x1 - x0) * TILE_MARGIN);
      const my = Math.round((y1 - y0) * TILE_MARGIN);
      const left = Math.max(0, x0 - mx);
      const top = Math.max(0, y0 - my);
      const width = Math.min(W, x1 + mx) - left;
      const height = Math.min(H, y1 + my) - top;

      // The counting box, drawn where the tile's own bounds fall in the crop.
      // Drawn before the tile is enlarged, so it scales with the kernels.
      const box = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${x0 - left}" y="${y0 - top}" width="${x1 - x0}" height="${y1 - y0}"
              fill="none" stroke="#e0115f" stroke-width="${stroke}"/>
      </svg>`;
      const boxed = await sharp(base)
        .extract({ left, top, width, height })
        .composite([{ input: Buffer.from(box), top: 0, left: 0 }])
        .toBuffer();
      const crop = sharp(boxed).resize({
        width: TILE_EDGE,
        height: TILE_EDGE,
        fit: "inside",
        kernel: "lanczos3",
      });
      tiles.push({ n, jpeg: await jpeg(crop) });

      grid.push(
        `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#e0115f" stroke-width="${stroke * 2}"/>`,
        `<text x="${x0 + stroke * 6}" y="${y0 + stroke * 22}" font-family="DejaVu Sans, Arial, sans-serif"
               font-size="${stroke * 20}" font-weight="700" fill="#e0115f">${n}</text>`,
      );
    }
  }

  // Composited to a buffer first: sharp resizes before it composites, whatever
  // order the calls are written in, and a full-size grid will not fit a
  // shrunk image.
  const gridded = await sharp(base)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${grid.join("")}</svg>`) }])
    .toBuffer();
  const overview = await jpeg(
    sharp(gridded).resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true }),
  );
  return { overview, tiles };
}

// ───────────────────────────── The call ─────────────────────────────

const PROMPT = `You are grading a sample of shelled maize (corn) spread on a plate, photographed
from above at a poultry feed mill's receiving bench in Assam, India. The grading
decides what the mill pays for a truckload and whether it is safe to feed to laying
hens, so count carefully and report only what you can actually see.

The first image is the whole plate, divided into numbered tiles. Each following
image is one tile, enlarged, with its COUNTING BOX drawn as a pink rectangle and a
small margin of the neighbouring tiles around it for context.

For EACH tile, count only the items whose CENTRE lies inside that tile's pink box.
An item cut by the box edge belongs to whichever tile holds its centre — never count
it in both. Count every kernel; do not estimate.

Per tile report:
- kernels: every kernel and every broken piece of kernel. A whole kernel and a broken
  piece are each one. Do NOT count cob, chaff, husk, stalk, threads or stones here.
- Then sort the kernels you counted into AT MOST ONE defect each. If a kernel shows
  more than one, use the first that applies in this order:
  1. fungus: visible mould — powdery, fuzzy or cottony growth (white, grey, green,
     black, or pink/red cottony growth from Fusarium), kernels stuck together by
     mould, or a kernel blackened by rot.
  2. damaged_grain: insect bore holes, a hollowed or eaten germ, a dark or rotted
     germ spot, sprouted, or heat-damaged (cooked, brown through).
  3. discoloured: clearly off-colour for the lot — dull, chalky, brownish, bleached
     or stained — but with no mould and no damage visible. A plain red or pink tip
     cap where the kernel joined the cob is NORMAL and is not a defect.
  4. broken: a piece or a kernel with a substantial part missing (roughly a quarter
     or more). A small chip is not broken.
  5. immature: clearly smaller and shrivelled or flat compared with the typical kernel
     in this sample.
- foreign_matter: each piece of anything that is not maize kernel — cob or glume
  pieces (papery, often pink-and-white flaky), chaff, husk, stalk, silk or threads,
  stones, soil clods, other seeds. Size each: small (smaller than a kernel), medium
  (about a kernel), large (bigger than a kernel).
- live_insects: storage insects on the plate (weevils, beetles, moths, larvae).
  Do NOT count house flies or other flying insects visiting the plate.

Also report:
- is_maize_sample: false if this is not a plate of shelled maize.
- photo_quality and photo_issues: blur, glare, shadows, kernels piled on each
  other, plate cut off, too far away.
- observations: short notes for the technician about what deserves a closer look
  with their own eyes — for example pink flaky pieces that could be cob chaff or
  Fusarium, a black kernel, insect holes. Say where on the plate (e.g. "tile 3, near
  the rim"). Do not repeat the counts.

Record your answer with the record_grading tool.`;

const TOOL: Anthropic.Tool = {
  name: "record_grading",
  description: "Record the grading of the maize sample, tile by tile.",
  input_schema: {
    type: "object",
    required: ["is_maize_sample", "photo_quality", "photo_issues", "tiles", "observations"],
    properties: {
      is_maize_sample: { type: "boolean" },
      photo_quality: { type: "string", enum: ["good", "usable", "poor"] },
      photo_issues: { type: "array", items: { type: "string" } },
      tiles: {
        type: "array",
        items: {
          type: "object",
          required: [
            "tile", "kernels", "fungus", "damaged_grain", "discoloured",
            "broken", "immature", "foreign_matter", "live_insects",
          ],
          properties: {
            tile: { type: "integer" },
            kernels: { type: "integer", minimum: 0 },
            fungus: { type: "integer", minimum: 0 },
            damaged_grain: { type: "integer", minimum: 0 },
            discoloured: { type: "integer", minimum: 0 },
            broken: { type: "integer", minimum: 0 },
            immature: { type: "integer", minimum: 0 },
            foreign_matter: {
              type: "array",
              items: {
                type: "object",
                required: ["what", "size"],
                properties: {
                  what: { type: "string" },
                  size: { type: "string", enum: ["small", "medium", "large"] },
                },
              },
            },
            live_insects: { type: "integer", minimum: 0 },
          },
        },
      },
      observations: { type: "array", items: { type: "string" } },
    },
  },
};

/** Grade one photo. Throws on a transport or model failure; the route turns that into a message. */
export async function gradeMaizePhoto(
  photo: Buffer,
  apiKey: string,
  model: string = GRADING_MODEL,
): Promise<{ grading: Grading; usage: GradingUsage }> {
  const { overview, tiles } = await tilePhoto(photo);
  const image = (b: Buffer): Anthropic.ImageBlockParam => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") },
  });

  const content: Anthropic.ContentBlockParam[] = [];
  if (tiles.length > 1) {
    content.push({ type: "text", text: "The whole plate, with the numbered tiles:" }, image(overview));
    for (const t of tiles) content.push({ type: "text", text: `Tile ${t.n}:` }, image(t.jpeg));
  } else {
    content.push({ type: "text", text: "The whole plate — a single tile, number 1:" }, image(tiles[0]!.jpeg));
  }
  content.push({ type: "text", text: PROMPT });

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens: 4000,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content }],
  });

  const call = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!call) throw new Error("The model did not return a grading");

  return {
    grading: reconcileGrading(call.input as RawGrading, msg.model ?? model),
    usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
  };
}
