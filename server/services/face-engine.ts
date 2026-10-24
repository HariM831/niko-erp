/**
 * The face engine: a photo in, a 128-number SFace vector out. Every face
 * vector the app stores or matches is made here.
 *
 * It replaced Human's FaceRes, which ran on the phone. On the farm's own gate
 * photos FaceRes put the wrong name on 16 scans in 100 against a single
 * enrolment photo, 28 in 100 after dark; OpenCV's SFace on the same photos
 * about 1 in 100, and none after dark. It is Apache-2.0, so it may be used here
 * without asking anyone (docs/face-sface-plan.md has the test).
 *
 * It runs on the server so the model lives in one place: the gate and canteen
 * pages, enrolment, and a CCTV box later all send a photo and get the same
 * vector back, and changing the model never means changing a phone.
 *
 * Two small ONNX models, both from OpenCV Zoo and pinned by revision and hash:
 *
 *  1. YuNet finds the face and five points on it (eyes, nose, mouth corners).
 *  2. The face is turned and scaled so those points land where SFace was
 *     trained to see them (a 112×112 crop), and SFace turns the crop into its
 *     vector.
 *
 * Steps 1 and 2 are what OpenCV's FaceDetectorYN and FaceRecognizerSF do,
 * written out so no OpenCV binary is needed: the decoding follows
 * modules/objdetect/src/face_detect.cpp and the crop follows alignCrop in
 * face_recognize.cpp. On 300 farm photos the vectors agree with OpenCV's own at
 * a median cosine of 0.999 (worst 0.93); scripts/check-face-engine.ts keeps the
 * arithmetic honest.
 *
 * The weights are fetched once into FACE_MODELS_DIR (default .cache/face-models,
 * beside TimesFM's cache) and checked against their sha256 before first use; a
 * file that does not match is refused, not run. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { FACE_DIM } from "@shared/face";

const MODELS = {
  yunet: {
    file: "face_detection_yunet_2023mar.onnx",
    url: "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  },
  sface: {
    file: "face_recognition_sface_2021dec.onnx",
    url: "https://huggingface.co/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/face_recognition_sface_2021dec.onnx",
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
  },
} as const;

const modelsDir = () => path.resolve(process.env.FACE_MODELS_DIR ?? ".cache/face-models");

/** YuNet's ONNX takes a fixed 640×640 picture; anything bigger is shrunk to fit first. */
const DET_SIZE = 640;
/** OpenCV's defaults for FaceDetectorYN, and what the gate-photo test ran with. */
const SCORE_THRESHOLD = 0.6;
const NMS_THRESHOLD = 0.3;
const STRIDES = [8, 16, 32] as const;

/** Where SFace expects the five points in its 112×112 crop (OpenCV alignCrop). */
const CROP = 112;
export const TEMPLATE: readonly [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

async function modelBytes(m: (typeof MODELS)[keyof typeof MODELS]): Promise<Buffer> {
  const where = path.join(modelsDir(), m.file);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  try {
    const b = await readFile(where);
    if (sha(b) === m.sha256) return b;
  } catch {
    // not fetched yet
  }
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`face engine: could not fetch ${m.file} (HTTP ${res.status})`);
  const b = Buffer.from(await res.arrayBuffer());
  if (sha(b) !== m.sha256) throw new Error(`face engine: ${m.file} does not match its pinned sha256`);
  // Written aside and renamed, so a fetch cut off half way never leaves a file
  // that is read as the model next time. A folder the service may not write
  // (systemd's ReadWritePaths) costs a fetch per boot, not the engine.
  try {
    await mkdir(modelsDir(), { recursive: true });
    await writeFile(`${where}.part`, b);
    await rename(`${where}.part`, where);
  } catch (e) {
    console.warn(`[faces] could not keep ${m.file} in ${modelsDir()}; it will be fetched again next boot:`, (e as Error).message);
  }
  return b;
}

let sessions: Promise<{ det: ort.InferenceSession; rec: ort.InferenceSession }> | null = null;

function engine() {
  sessions ??= (async () => {
    // Two threads each: the engine shares the box with the web server, and a
    // gate scan is one face, which SFace does in a few milliseconds anyway.
    const opts: ort.InferenceSession.SessionOptions = { intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 3 };
    const [det, rec] = await Promise.all([
      modelBytes(MODELS.yunet).then((b) => ort.InferenceSession.create(b, opts)),
      modelBytes(MODELS.sface).then((b) => ort.InferenceSession.create(b, opts)),
    ]);
    return { det, rec };
  })().catch((e) => {
    sessions = null; // let the next call try again rather than caching the failure
    throw e;
  });
  return sessions;
}

/** Fetch and load both models now, so the first scan does not pay for it. */
export async function warmFaceEngine(): Promise<void> {
  await engine();
}

/** An RGB picture, row by row, 3 bytes a pixel. */
interface Rgb {
  data: Buffer;
  width: number;
  height: number;
}

export interface DetectedFace {
  /** Box in the photo's own pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Right eye, left eye, nose tip, right and left mouth corner, as OpenCV orders them. */
  points: [number, number][];
  /** YuNet's confidence, 0..1. */
  score: number;
}

export interface FaceVector {
  /** FACE_DIM numbers, scaled to unit length. */
  vector: number[];
  face: DetectedFace;
  /** How many faces the photo held; the largest is the one returned. */
  faceCount: number;
}

/** Decode any photo sharp reads, turned the way its EXIF says it was held. */
async function decode(photo: Buffer): Promise<Rgb> {
  const { data, info } = await sharp(photo).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const iou = (a: DetectedFace, b: DetectedFace) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

/** Every face YuNet sees, best first, in the photo's own pixels. */
export async function detectFaces(img: Rgb): Promise<DetectedFace[]> {
  const { det } = await engine();
  // Shrink to fit 640×640 and pad the rest with black, top-left aligned —
  // what FaceDetectorYN does with its own padding, so the grid lines up.
  const scale = Math.min(1, DET_SIZE / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  // Linear, as cv2.resize does. With sharp's default (lanczos) the vectors
  // agreed with OpenCV's less well on the farm's photos: worst 0.82 against 0.93.
  const small = scale < 1
    ? await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).resize(w, h, { kernel: "linear" }).raw().toBuffer()
    : img.data;
  // Blue, green, red planes: YuNet was trained on OpenCV's BGR order.
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = y * DET_SIZE + x;
      input[d] = small[s + 2]!;
      input[plane + d] = small[s + 1]!;
      input[2 * plane + d] = small[s]!;
    }
  }
  const out = await det.run({ [det.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, DET_SIZE, DET_SIZE]) });

  const found: DetectedFace[] = [];
  for (const stride of STRIDES) {
    const cls = out[`cls_${stride}`]!.data as Float32Array;
    const obj = out[`obj_${stride}`]!.data as Float32Array;
    const box = out[`bbox_${stride}`]!.data as Float32Array;
    const kps = out[`kps_${stride}`]!.data as Float32Array;
    const cols = DET_SIZE / stride;
    const rows = DET_SIZE / stride;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const clamp = (v: number) => Math.min(1, Math.max(0, v));
        const score = Math.sqrt(clamp(cls[i]!) * clamp(obj[i]!));
        if (score < SCORE_THRESHOLD) continue;
        const cx = (c + box[i * 4]!) * stride;
        const cy = (r + box[i * 4 + 1]!) * stride;
        const bw = Math.exp(box[i * 4 + 2]!) * stride;
        const bh = Math.exp(box[i * 4 + 3]!) * stride;
        const points: [number, number][] = [];
        for (let n = 0; n < 5; n++) {
          points.push([((kps[i * 10 + 2 * n]! + c) * stride) / scale, ((kps[i * 10 + 2 * n + 1]! + r) * stride) / scale]);
        }
        found.push({ x: (cx - bw / 2) / scale, y: (cy - bh / 2) / scale, w: bw / scale, h: bh / scale, points, score });
      }
    }
  }
  // Non-maximum suppression: of boxes that overlap heavily, keep the surest.
  found.sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];
  for (const f of found) if (kept.every((k) => iou(k, f) <= NMS_THRESHOLD)) kept.push(f);
  return kept;
}

/**
 * The similarity transform (turn, scale, shift — no stretching) that best
 * carries the five detected points onto SFace's template, by least squares.
 * Returned as the 2×3 matrix [a -b tx; b a ty] from photo to crop.
 */
export function similarity(src: [number, number][]): [number, number, number, number] {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i]![0]; sy += src[i]![1]; dx += TEMPLATE[i]![0]; dy += TEMPLATE[i]![1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num = 0, cross = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i]![0] - sx, py = src[i]![1] - sy;
    const qx = TEMPLATE[i]![0] - dx, qy = TEMPLATE[i]![1] - dy;
    num += px * qx + py * qy;
    cross += px * qy - py * qx;
    den += px * px + py * py;
  }
  const a = num / den;
  const b = cross / den;
  return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

/** The 112×112 crop SFace reads, sampled from the photo with bilinear weights; outside the photo is black. */
export function alignCrop(img: Rgb, points: [number, number][]): Buffer {
  const [a, b, tx, ty] = similarity(points);
  // Inverse of [a -b; b a]: walk the crop's pixels and ask where each came from.
  const det = a * a + b * b;
  const ia = a / det, ib = b / det;
  const out = Buffer.alloc(CROP * CROP * 3);
  for (let y = 0; y < CROP; y++) {
    for (let x = 0; x < CROP; x++) {
      const u = x - tx, v = y - ty;
      const px = ia * u + ib * v;
      const py = -ib * u + ia * v;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const fx = px - x0, fy = py - y0;
      for (let ch = 0; ch < 3; ch++) {
        const at = (xx: number, yy: number) =>
          xx < 0 || yy < 0 || xx >= img.width || yy >= img.height ? 0 : img.data[(yy * img.width + xx) * 3 + ch]!;
        const val = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1));
        out[(y * CROP + x) * 3 + ch] = Math.round(val);
      }
    }
  }
  return out;
}

/** SFace's vector for an aligned crop, scaled to unit length. */
export async function embedCrop(crop: Buffer): Promise<number[]> {
  const { rec } = await engine();
  // Red, green, blue planes, 0..255 unscaled: blobFromImage(crop, 1, …, swapRB=true).
  const plane = CROP * CROP;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = crop[i * 3]!;
    input[plane + i] = crop[i * 3 + 1]!;
    input[2 * plane + i] = crop[i * 3 + 2]!;
  }
  const out = await rec.run({ [rec.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, CROP, CROP]) });
  const raw = Array.from(out[rec.outputNames[0]!]!.data as Float32Array);
  if (raw.length !== FACE_DIM) throw new Error(`face engine: SFace gave ${raw.length} numbers, expected ${FACE_DIM}`);
  const len = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
  return raw.map((v) => v / len);
}

const DATA_URL = /^data:image\/[\w.+-]+;base64,(.+)$/s;

/**
 * The SFace vector of the largest face in a photo — a Buffer, or a data URL as
 * the app stores photos — or null when there is no face in it. Throws only when
 * the engine itself cannot run (models missing and unfetchable), never for a
 * photo that is merely unreadable: that is just "no face".
 */
export async function faceVector(photo: Buffer | string): Promise<FaceVector | null> {
  let bytes: Buffer;
  if (typeof photo === "string") {
    const m = DATA_URL.exec(photo);
    if (!m) return null;
    bytes = Buffer.from(m[1]!, "base64");
  } else {
    bytes = photo;
  }
  let img: Rgb;
  try {
    img = await decode(bytes);
  } catch {
    return null;
  }
  const faces = await detectFaces(img);
  if (!faces.length) return null;
  // The largest is the person at the gate; anyone behind them is smaller.
  const face = faces.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const vector = await embedCrop(alignCrop(img, face.points));
  return { vector, face, faceCount: faces.length };
}
