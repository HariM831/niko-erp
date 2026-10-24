/**
 * The face engine's two model files, kept on the server so the phones fetch
 * them from us and never from the internet at large.
 *
 * The phones run the models (client/src/lib/face-engine.ts); the server only
 * hands the files out — it never loads one, so its memory is unchanged by the
 * engine. Scripts that read photos already on file use the same files
 * (scripts/lib/face-engine-node.ts).
 *
 * Fetched once into FACE_MODELS_DIR (default .cache/face-models, beside
 * TimesFM's cache) and checked against their pinned sha256 before they are
 * served or run; a file that does not match is refused.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FACE_MODELS, type FaceModelName } from "@shared/face-engine";

const modelsDir = () => path.resolve(process.env.FACE_MODELS_DIR ?? ".cache/face-models");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Fetches in flight, so two phones opening the gate at once fetch once. */
const pending = new Map<FaceModelName, Promise<Buffer>>();

/** The model's bytes, fetched and checked the first time. */
export function modelBytes(name: FaceModelName): Promise<Buffer> {
  let p = pending.get(name);
  if (!p) {
    p = load(name).finally(() => pending.delete(name));
    pending.set(name, p);
  }
  return p;
}

async function load(name: FaceModelName): Promise<Buffer> {
  const m = FACE_MODELS[name];
  const where = path.join(modelsDir(), m.file);
  try {
    const b = await readFile(where);
    if (sha(b) === m.sha256) return b;
  } catch {
    // not fetched yet
  }
  const res = await fetch(m.url, { signal: AbortSignal.timeout(120_000) });
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
