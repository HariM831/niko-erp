/**
 * The face engine's arithmetic: a picture in, a 128-number SFace vector out.
 *
 * It runs on the phone (client/src/lib/face-engine.ts, onnxruntime-web) for
 * every scan and enrolment, and in scripts on the server
 * (scripts/lib/face-engine-node.ts, onnxruntime-node) for the one-off reading
 * of photos already on file. Both feed this file the same pixels and get the
 * same vector back; only how a model is run differs, and each side supplies
 * that (`FaceRuntime`). Even the shrinking is done here, not by a canvas or
 * sharp: on 30 farm photos the phone's canvas shrink alone moved a vector as
 * far as 0.91 from the script's. The running server never loads a model.
 *
 * It replaced Human's FaceRes. On the farm's own gate photos FaceRes put the
 * wrong name on 16 scans in 100 against a single enrolment photo, 28 in 100
 * after dark; OpenCV's SFace on the same photos about 1 in 100, and none after
 * dark. It is Apache-2.0 (docs/face-sface-plan.md has the test).
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
 */
import { FACE_DIM } from "./face";

export const FACE_MODELS = {
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

export type FaceModelName = keyof typeof FACE_MODELS;

/** YuNet's ONNX takes a fixed 640×640 picture; anything bigger is shrunk to fit first. */
export const DET_SIZE = 640;
/** OpenCV's defaults for FaceDetectorYN, and what the gate-photo test ran with. */
const SCORE_THRESHOLD = 0.6;
const NMS_THRESHOLD = 0.3;
const STRIDES = [8, 16, 32] as const;

/** Where SFace expects the five points in its 112×112 crop (OpenCV alignCrop). */
export const CROP = 112;
export const TEMPLATE: readonly [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * A picture, row by row: 3 bytes a pixel (RGB), or 4 (RGBA, as a canvas gives
 * it — the fourth is ignored).
 */
export interface Picture {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 3 | 4;
}

/** What each side supplies: how to run the two models. */
export interface FaceRuntime {
  /** YuNet on a 1×3×640×640 BGR tensor; its outputs by name (cls_8, obj_8, bbox_8, kps_8, …). */
  detect(input: Float32Array): Promise<Record<string, Float32Array>>;
  /** SFace on a 1×3×112×112 RGB tensor; its raw FACE_DIM numbers. */
  embed(input: Float32Array): Promise<Float32Array>;
}

export interface DetectedFace {
  /** Box in the picture's own pixels. */
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
  /** How many faces the picture held; the largest is the one returned. */
  faceCount: number;
}

const iou = (a: DetectedFace, b: DetectedFace) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

/**
 * The picture scaled to w×h as cv2.resize's INTER_LINEAR does it: each output
 * pixel's centre mapped back into the source, bilinear between the four
 * nearest, edges clamped. RGB out, whatever came in.
 */
export function shrink(img: Picture, w: number, h: number): Picture {
  const ch = img.channels;
  const out = new Uint8Array(w * h * 3);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    let y0 = Math.floor(fy);
    if (y0 >= img.height - 1) { y0 = img.height - 1; fy = y0; }
    const y1 = Math.min(y0 + 1, img.height - 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      let x0 = Math.floor(fx);
      if (x0 >= img.width - 1) { x0 = img.width - 1; fx = x0; }
      const x1 = Math.min(x0 + 1, img.width - 1);
      const wx = fx - x0;
      const a = (y0 * img.width + x0) * ch, b = (y0 * img.width + x1) * ch;
      const c = (y1 * img.width + x0) * ch, d = (y1 * img.width + x1) * ch;
      for (let k = 0; k < 3; k++) {
        const top = img.data[a + k]! * (1 - wx) + img.data[b + k]! * wx;
        const bottom = img.data[c + k]! * (1 - wx) + img.data[d + k]! * wx;
        out[(y * w + x) * 3 + k] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return { data: out, width: w, height: h, channels: 3 };
}

/** Every face YuNet sees, best first, in the picture's own pixels. */
export async function detectFaces(rt: FaceRuntime, img: Picture): Promise<DetectedFace[]> {
  // Shrink to fit 640×640 and pad the rest with black, top-left aligned —
  // what FaceDetectorYN does with its own padding, so the grid lines up.
  const scale = Math.min(1, DET_SIZE / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const small = scale < 1 ? shrink(img, w, h) : img;
  const ch = small.channels;
  // Blue, green, red planes: YuNet was trained on OpenCV's BGR order.
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * ch;
      const d = y * DET_SIZE + x;
      input[d] = small.data[s + 2]!;
      input[plane + d] = small.data[s + 1]!;
      input[2 * plane + d] = small.data[s]!;
    }
  }
  const out = await rt.detect(input);

  const found: DetectedFace[] = [];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (const stride of STRIDES) {
    const cls = out[`cls_${stride}`]!;
    const obj = out[`obj_${stride}`]!;
    const box = out[`bbox_${stride}`]!;
    const kps = out[`kps_${stride}`]!;
    const cols = DET_SIZE / stride;
    const rows = DET_SIZE / stride;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
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
 * Returned as the 2×3 matrix [a -b tx; b a ty] from picture to crop.
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

/** The 112×112 RGB crop SFace reads, sampled from the picture with bilinear weights; outside the picture is black. */
export function alignCrop(img: Picture, points: [number, number][]): Uint8Array {
  const [a, b, tx, ty] = similarity(points);
  // Inverse of [a -b; b a]: walk the crop's pixels and ask where each came from.
  const det = a * a + b * b;
  const ia = a / det, ib = b / det;
  const chs = img.channels;
  const out = new Uint8Array(CROP * CROP * 3);
  for (let y = 0; y < CROP; y++) {
    for (let x = 0; x < CROP; x++) {
      const u = x - tx, v = y - ty;
      const px = ia * u + ib * v;
      const py = -ib * u + ia * v;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const fx = px - x0, fy = py - y0;
      for (let ch = 0; ch < 3; ch++) {
        const at = (xx: number, yy: number) =>
          xx < 0 || yy < 0 || xx >= img.width || yy >= img.height ? 0 : img.data[(yy * img.width + xx) * chs + ch]!;
        const val = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1));
        out[(y * CROP + x) * 3 + ch] = Math.round(val);
      }
    }
  }
  return out;
}

/** SFace's vector for an aligned crop, scaled to unit length. */
export async function embedCrop(rt: FaceRuntime, crop: Uint8Array): Promise<number[]> {
  // Red, green, blue planes, 0..255 unscaled: blobFromImage(crop, 1, …, swapRB=true).
  const plane = CROP * CROP;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = crop[i * 3]!;
    input[plane + i] = crop[i * 3 + 1]!;
    input[2 * plane + i] = crop[i * 3 + 2]!;
  }
  const raw = Array.from(await rt.embed(input));
  if (raw.length !== FACE_DIM) throw new Error(`face engine: SFace gave ${raw.length} numbers, expected ${FACE_DIM}`);
  const len = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
  return raw.map((v) => v / len);
}

/** The SFace vector of the largest face in a picture, or null when it holds none. */
export async function readFace(rt: FaceRuntime, img: Picture): Promise<FaceVector | null> {
  const faces = await detectFaces(rt, img);
  if (!faces.length) return null;
  // The largest is the person at the gate; anyone behind them is smaller.
  const face = faces.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const vector = await embedCrop(rt, alignCrop(img, face.points));
  return { vector, face, faceCount: faces.length };
}
