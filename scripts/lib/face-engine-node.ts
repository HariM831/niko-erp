/**
 * The face engine for scripts on the server: onnxruntime-node runs the models
 * and sharp decodes the photos. The arithmetic is the phone's own
 * (shared/face-engine.ts), so a photo read here gives the vector the gate
 * would have given it.
 *
 * Scripts only. The running server never imports this: faces are read on the
 * phone, and a model loaded into the web server would cost it a few hundred MB
 * for nothing.
 */
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { CROP, DET_SIZE, readFace, type FaceRuntime, type FaceVector, type Picture } from "@shared/face-engine";
import { modelBytes } from "../../server/services/face-models";

export type { FaceVector } from "@shared/face-engine";

let runtime: Promise<FaceRuntime> | null = null;

function engine(): Promise<FaceRuntime> {
  runtime ??= (async () => {
    const opts: ort.InferenceSession.SessionOptions = { intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 3 };
    const [det, rec] = await Promise.all([
      modelBytes("yunet").then((b) => ort.InferenceSession.create(b, opts)),
      modelBytes("sface").then((b) => ort.InferenceSession.create(b, opts)),
    ]);
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
  })().catch((e) => {
    runtime = null; // let the next call try again rather than caching the failure
    throw e;
  });
  return runtime;
}

/** Decode any photo sharp reads, turned the way its EXIF says it was held. */
async function decode(photo: Buffer): Promise<Picture> {
  const { data, info } = await sharp(photo).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 3 };
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
  let img: Picture;
  try {
    img = await decode(bytes);
  } catch {
    return null;
  }
  return readFace(await engine(), img);
}
