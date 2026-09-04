/**
 * Employee photos, cut down to the size the screen actually shows.
 *
 * An enrolment photo is a ~1024 px JPEG held as a base64 data URL in
 * `employees.photo_url` — around 200 KB each. Every screen that shows one
 * shows it at 80 px or smaller: the gate's confirm card, the punch list
 * avatars, the manual-selection list. And the gate roster ships one per
 * active worker, so at 180 workers a single roster fetch is tens of
 * megabytes. gzip does not help — JPEG bytes are already compressed.
 *
 * So resize once and remember it, keyed on the hash of the photo it came
 * from. `employees.photo_hash` is sha256(photoUrl) and is already written in
 * step with the photo on every path that sets one (the payroll PATCH, device
 * enrolment, the Amino import), so an unchanged photo is never resized twice
 * and a changed one misses the cache by construction — no expiry to tune.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";

/** Big enough for an 80 px avatar on a 2x screen, and nothing shows one larger. */
export const THUMB_PX = 96;

/**
 * Bounded so a long-lived process cannot grow without limit as people are
 * re-photographed. One thumbnail is ~1 KB, so this is a megabyte or two at
 * full stretch — and the oldest entry to go is the one least likely to be
 * asked for again, since the roster re-reads the same faces every day.
 */
const MAX_ENTRIES = 4_000;
const cache = new Map<string, Buffer>();

function remember(key: string, buf: Buffer) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, buf);
}

const DATA_URL = /^data:image\/[\w.+-]+;base64,(.+)$/s;

/**
 * A 96 px JPEG of this photo, or null if there is no photo or it cannot be
 * read. Null rather than a throw: one unreadable row must not take down the
 * roster the whole gate is waiting on.
 *
 * `hash` is the row's `photoHash`. It is only a cache key, so a missing one
 * costs a hash of the photo rather than a wrong answer.
 */
export async function photoThumbnail(photoUrl: string | null, hash?: string | null): Promise<Buffer | null> {
  if (!photoUrl) return null;
  const m = DATA_URL.exec(photoUrl);
  if (!m) return null;
  const key = hash ?? createHash("sha256").update(photoUrl).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const buf = await sharp(Buffer.from(m[1]!, "base64"))
      .resize(THUMB_PX, THUMB_PX, { fit: "cover" })
      .jpeg({ quality: 80 })
      .toBuffer();
    remember(key, buf);
    return buf;
  } catch {
    return null;
  }
}

/** The same thumbnail as a data URL, for payloads that carry the image inline. */
export async function photoThumbnailDataUrl(photoUrl: string | null, hash?: string | null): Promise<string | null> {
  const buf = await photoThumbnail(photoUrl, hash);
  return buf && `data:image/jpeg;base64,${buf.toString("base64")}`;
}

/**
 * Thumbnail a whole roster, a few at a time.
 *
 * `Promise.all` over 180 photos hands sharp 180 decodes at once on a two-core
 * box; sequential makes the first kiosk of the morning wait through all of
 * them. A small pool keeps both ends off. Only ever pays this on a cold cache.
 */
export async function photoThumbnails<T extends { photoUrl: string | null; photoHash?: string | null }>(
  rows: T[],
  concurrency = 4,
): Promise<(string | null)[]> {
  const out = new Array<string | null>(rows.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < rows.length; i = next++) {
      out[i] = await photoThumbnailDataUrl(rows[i]!.photoUrl, rows[i]!.photoHash);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return out;
}
