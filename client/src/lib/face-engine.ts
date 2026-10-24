// The face engine on the phone: onnxruntime-web runs YuNet and SFace in the
// page, and the arithmetic around them is shared with the server's scripts
// (shared/face-engine.ts), so a face read here is the vector a script reading
// the same photo would make.
//
// Everything it needs comes from our own server, never the wider internet:
// the two models (~39 MB) and the runtime (~14 MB), all from /api/face-engine.
// They are kept in the browser's Cache Storage after the first time, so a gate
// page reopened during a network cut still reads faces.

import { CROP, DET_SIZE, FACE_MODELS, readFace, type FaceRuntime, type FaceVector } from "@shared/face-engine";

const BASE = "/api/face-engine";
/** The runtime the page loads; must match the onnxruntime-web in package.json. */
const ORT_VERSION = "1.30.0";
const CACHE = "niko-face-engine";

/**
 * A file from our server, from Cache Storage when it is there. The URL carries
 * the file's version, so a new model or runtime is a new entry and an old one
 * is never served for it. Without Cache Storage (plain http on a LAN address)
 * it is an ordinary fetch.
 */
async function cachedBytes(url: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
  } catch {
    cache = null;
  }
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Could not download the face engine (${res.status})`);
  if (cache) {
    try {
      await cache.put(url, res.clone());
      // The entries of an older model or runtime are dead weight on the phone.
      for (const req of await cache.keys()) {
        const known = [modelUrl("yunet"), modelUrl("sface"), runtimeUrl()];
        if (!known.some((k) => req.url.endsWith(k))) await cache.delete(req);
      }
    } catch {
      // A full or refused cache only means the next open downloads again.
    }
  }
  return res.arrayBuffer();
}

const modelUrl = (m: keyof typeof FACE_MODELS) => `${BASE}/models/${FACE_MODELS[m].file}?sha=${FACE_MODELS[m].sha256.slice(0, 16)}`;
const runtimeUrl = () => `${BASE}/runtime/ort-wasm-simd-threaded.wasm?v=${ORT_VERSION}`;

let engine: Promise<FaceRuntime> | null = null;

/** Download (first time) and start the engine; every later call is the same promise. */
export function startFaceEngine(): Promise<FaceRuntime> {
  engine ??= (async () => {
    const [ort, wasm, yunet, sface] = await Promise.all([
      import("onnxruntime-web/wasm"),
      cachedBytes(runtimeUrl()),
      cachedBytes(modelUrl("yunet")),
      cachedBytes(modelUrl("sface")),
    ]);
    // One thread: several need the page to be cross-origin isolated, which this
    // app is not, and a gate scan is one face.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmBinary = wasm;
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" } as const;
    const det = await ort.InferenceSession.create(new Uint8Array(yunet), opts);
    const rec = await ort.InferenceSession.create(new Uint8Array(sface), opts);

    const rt: FaceRuntime = {
      async detect(input) {
        const out = await det.run({ [det.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, DET_SIZE, DET_SIZE]) });
        return Object.fromEntries(Object.entries(out).map(([k, t]) => [k, t.data as Float32Array]));
      },
      async embed(input) {
        const out = await rec.run({ [rec.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, CROP, CROP]) });
        return out[rec.outputNames[0]!]!.data as Float32Array;
      },
    };
    return rt;
  })().catch((err) => {
    engine = null; // allow a retry after a network blip
    throw err;
  });
  return engine;
}

/** The largest face in a canvas, read on this phone; null when there is none. */
export async function readCanvasFace(canvas: HTMLCanvasElement): Promise<FaceVector | null> {
  const rt = await startFaceEngine();
  const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  return readFace(rt, { data, width: canvas.width, height: canvas.height, channels: 4 });
}
