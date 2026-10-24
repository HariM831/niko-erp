// Face recognition helpers. The face is read on the server: a page sends the
// picture to POST /api/payroll/face/vector and gets the face's vector back
// (server/services/face-engine.ts, OpenCV's SFace). Matching the vector against
// the roster still happens here, on the device (shared/face-match.ts).
//
// Human's FaceRes used to run in this file, in the browser. It put the wrong
// name on 16 gate scans in 100 where SFace puts it on about 1
// (docs/face-sface-plan.md), and the model now lives in one place for the
// gate, the canteen, enrolment and a CCTV box later.
//
// What went with it: Human's photo-or-screen check. A guard holds the phone at
// the gate and sees who stands in front of it; a check of its own comes back,
// on the server, with the cameras that will not have a guard.

import { MATCH_MARGIN, MATCH_THRESHOLD } from "@shared/face";
import { api } from "../api";

/** Similarity above which we auto-accept a match (SFace cosine; shared/face.ts has the reasoning). */
export const DEFAULT_MATCH_THRESHOLD = MATCH_THRESHOLD;

/** Minimum gap between the top match and the runner-up for an auto-accept.
 * Prevents "close-call" matches when the top-1 and top-2 are within noise of
 * each other. */
export const MIN_MATCH_MARGIN = MATCH_MARGIN;

let ready: Promise<void> | null = null;

/** Resolves once the server's face engine is loaded; a page shows "loading" until then. */
export function loadFaceEngine(): Promise<void> {
  ready ??= api("/api/payroll/face/ready").then(
    () => undefined,
    (err) => {
      ready = null; // allow a retry after a network blip
      throw err;
    },
  );
  return ready;
}

export interface FaceResult {
  ok: boolean;
  embedding?: number[];
  faceCount: number;
  /** detector confidence 0..1 for the detected face */
  confidence?: number;
  error?: string;
}

/**
 * The picture sent for reading: big enough that a face across the gate keeps
 * its detail, small enough to post quickly (~100 KB). Separate from the 400 px
 * audit photo, which is what gets stored.
 */
const SCAN_MAX_PX = 960;
const SCAN_QUALITY = 0.85;

/** Read the largest face in an image/video/canvas and return its vector. */
export async function getFaceEmbedding(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
): Promise<FaceResult> {
  const w = input instanceof HTMLVideoElement ? input.videoWidth : input instanceof HTMLImageElement ? input.naturalWidth : input.width;
  const h = input instanceof HTMLVideoElement ? input.videoHeight : input instanceof HTMLImageElement ? input.naturalHeight : input.height;
  const scale = Math.min(1, SCAN_MAX_PX / Math.max(w || 1, h || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(input, 0, 0, canvas.width, canvas.height);
  const r = await api<{ embedding: number[] | null; faceCount: number; confidence?: number }>("/api/payroll/face/vector", {
    method: "POST",
    body: { photo: canvas.toDataURL("image/jpeg", SCAN_QUALITY) },
  });
  if (!r.embedding) return { ok: false, faceCount: 0, error: "No face detected" };
  return { ok: true, embedding: r.embedding, faceCount: r.faceCount, confidence: r.confidence };
}

/** Load an image src (data URL or http) into an HTMLImageElement. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

/** Downscale a video/canvas frame to a small JPEG data URL for audit storage. */
export function frameToDataUrl(
  source: HTMLVideoElement | HTMLCanvasElement,
  maxWidth = 400,
  quality = 0.6,
): string {
  const srcW = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const srcH = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  const scale = Math.min(1, maxWidth / (srcW || maxWidth));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Resize an uploaded photo to a bounded JPEG data URL (for employee photos).
 *
 * 1024 px keeps a portrait's face a few hundred pixels across, plenty for the
 * server's face engine, while keeping the stored JPEG well under the server's
 * 2 MB cap.
 */
export async function resizePhotoFile(file: File, maxDim = 1024, quality = 0.8): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}
