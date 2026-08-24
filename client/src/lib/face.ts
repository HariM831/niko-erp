// Face recognition helpers — runs fully in the browser, no external API calls.
//
// Uses @vladmandic/human (loaded once from CDN, then cached by the browser).
// Each face is converted to an embedding (array of numbers). Two embeddings of
// the same person are numerically close; we match with cosine similarity.
//
// No biometric data ever leaves the app: embeddings are stored in our own DB
// and matching happens on-device.

let humanPromise: Promise<any> | null = null;

// Pin to an exact version so a jsDelivr resolution swap can't put the runtime
// out of sync with the model weights. Load models from the SAME `@vladmandic/human`
// package (it ships a `/models/` directory) rather than the separate
// `@vladmandic/human-models` package — the latter is over jsDelivr's 150 MB
// package-size limit, so every model URL under it returns 403/404 and
// `human.detect()` crashes deep inside TF.js with
// "Cannot read properties of undefined (reading 'inputNodes')" when it tries
// to run a model that never loaded.
const HUMAN_CDN = "https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.5/dist/human.esm.js";
const MODEL_BASE = "https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.5/models/";

/** Similarity above which we auto-accept a match (tunable on the gate page).
 *
 * FaceRes embeddings (the descriptor Human returns) score roughly:
 *   • same person, good conditions       0.75 – 0.95
 *   • same person, different light/angle 0.60 – 0.75
 *   • different person, similar looks    0.35 – 0.55
 *   • random different person            0.10 – 0.30
 *
 * A 0.55 cutoff sits right in the false-accept zone — two different farm
 * workers can easily land there. 0.65 puts us into "genuinely likely same
 * person" territory while still tolerating the light/pose differences between
 * a mugshot-style enrolment photo and a live gate capture. The gate also
 * requires the top match to beat the runner-up by MIN_MATCH_MARGIN, so an
 * ambiguous score like 0.66 vs 0.64 gets deferred to manual selection.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.65;

/** Minimum gap between the top match and the runner-up for an auto-accept.
 * Prevents "close-call" matches when the top-1 and top-2 are within noise of
 * each other. */
export const MIN_MATCH_MARGIN = 0.05;

/** Minimum anti-spoof ("real face") score to accept a capture.
 *
 * Human's antispoof model returns `real` 0..1 — a printed photo or a face on
 * a phone screen typically scores well below 0.5, a live face well above 0.7.
 * 0.6 rejects lazy photo-of-a-photo attempts without bouncing legitimate
 * workers in poor light. If either score is missing (model failed to load on
 * an old device) the check passes — the guard remains the human backstop, as
 * per the original design. */
export const MIN_REAL_SCORE = 0.6;

/** True when a capture looks like a photo/screen rather than a live person.
 * Conservative: only flags when the model actually produced a score. */
export function looksSpoofed(face: { real?: number; live?: number }): boolean {
  const real = typeof face.real === "number" ? face.real : null;
  const live = typeof face.live === "number" ? face.live : null;
  if (real !== null && real < MIN_REAL_SCORE) return true;
  if (live !== null && live < MIN_REAL_SCORE) return true;
  return false;
}

export async function loadFaceEngine(): Promise<any> {
  if (!humanPromise) {
    humanPromise = (async () => {
      const mod: any = await import(/* @vite-ignore */ HUMAN_CDN);
      const Human = mod.Human ?? mod.default;
      const human = new Human({
        modelBasePath: MODEL_BASE,
        cacheSensitivity: 0,
        filter: { enabled: true, equalization: true },
        face: {
          enabled: true,
          // 0.4 minConfidence with the 1024-px resize gives a clean face crop
          // (~500 px face) — no need for the lax 0.2 setting which was a
          // band-aid for the smaller 640-px resize we used briefly.
          detector: { rotation: true, maxDetected: 5, minConfidence: 0.4 },
          mesh: { enabled: true },
          iris: { enabled: false },
          emotion: { enabled: false },
          description: { enabled: true }, // produces the embedding
          // Anti-spoofing: `antispoof` scores whether the face is a real face
          // vs a printed photo / phone screen; `liveness` scores whether the
          // input looks like a live camera capture. Both are small models
          // (<1 MB each, cached like the rest). Scores surface on FaceResult
          // and the gate page rejects captures below MIN_REAL_SCORE.
          antispoof: { enabled: true },
          liveness: { enabled: true },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
        segmentation: { enabled: false },
      });
      await human.load();
      return human;
    })().catch((err) => {
      humanPromise = null; // allow retry on transient network failure
      throw err;
    });
  }
  return humanPromise;
}

export interface FaceResult {
  ok: boolean;
  embedding?: number[];
  faceCount: number;
  /** detector confidence 0..1 for the detected face */
  confidence?: number;
  /** anti-spoof score 0..1 — low means "looks like a photo/screen" */
  real?: number;
  /** liveness score 0..1 — low means "doesn't look like a live capture" */
  live?: number;
  error?: string;
}

/** Detect a single face in an image/video/canvas and return its embedding. */
export async function getFaceEmbedding(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
): Promise<FaceResult> {
  const human = await loadFaceEngine();
  // Race detect() with a timeout: Human/TF.js can silently hang when an internal
  // model failed to load or the library/models packages are out of sync — the
  // outer promise never resolves and the caller ends up in an infinite spinner.
  // Ten seconds is a generous cap for a resized ≤640px photo on mobile.
  const DETECT_TIMEOUT_MS = 10_000;
  const result: any = await Promise.race([
    human.detect(input),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Face detection timed out — reload the page and try again")),
        DETECT_TIMEOUT_MS,
      ),
    ),
  ]);
  const faces = (result?.face || []).filter((f: any) => Array.isArray(f.embedding) && f.embedding.length > 0);
  if (faces.length === 0) {
    return { ok: false, faceCount: 0, error: "No face detected" };
  }
  if (faces.length > 1) {
    // pick the largest face but flag the count so callers can warn
    faces.sort((a: any, b: any) => (b.box?.[2] || 0) * (b.box?.[3] || 0) - (a.box?.[2] || 0) * (a.box?.[3] || 0));
  }
  const face = faces[0];
  return {
    ok: true,
    embedding: Array.from(face.embedding as number[]),
    faceCount: faces.length,
    confidence: face.faceScore ?? face.score,
    real: typeof face.real === "number" ? face.real : undefined,
    live: typeof face.live === "number" ? face.live : undefined,
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface MatchCandidate {
  id: string;
  /** enrollment descriptor plus any recent live-capture embeddings — a person
   * matches on their BEST descriptor, which tolerates lighting/pose drift */
  descriptors: number[][];
}

export interface MatchResult {
  /** id of the best candidate, or null if none */
  id: string | null;
  /** similarity 0..1 of the best candidate */
  score: number;
  /** similarity of the runner-up PERSON (useful to judge ambiguity) */
  secondScore: number;
}

/** Find the best-matching candidate for an embedding. Each candidate is scored
 * by their best descriptor; secondScore is the best score of a DIFFERENT person. */
export function findBestMatch(embedding: number[], candidates: MatchCandidate[]): MatchResult {
  let best: string | null = null;
  let bestScore = -1;
  let secondScore = -1;
  for (const c of candidates) {
    let s = -1;
    for (const d of c.descriptors) {
      const v = cosineSimilarity(embedding, d);
      if (v > s) s = v;
    }
    if (s > bestScore) {
      secondScore = bestScore;
      bestScore = s;
      best = c.id;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }
  return { id: best, score: Math.max(0, bestScore), secondScore: Math.max(0, secondScore) };
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
 * maxDim was 640 but that shrank the face crop below BlazeFace + mesh's reliable
 * detection window on typical 12 MP mobile portraits (~160 px face → dropped by
 * the mesh pass → "no face found"). 1024 gives a ~500-px face and detects
 * cleanly while still keeping the stored JPEG well under the server's 2 MB cap.
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
