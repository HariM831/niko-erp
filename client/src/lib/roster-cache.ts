/**
 * The gate's face roster, kept in this browser between page loads.
 *
 * The roster is several megabytes — every enrolled person's descriptors — and
 * a reload started again from nothing. The server already answers "what changed
 * since this cursor", so a copy kept here turns a reload into a small delta.
 *
 * It is biometric data at rest in a browser, which is why it is small about it:
 * one record, dropped on logout, and distrusted when it is old or was made by a
 * different face model. A capture that has aged out of someone's gallery does
 * not move their cursor, so a cached copy would carry it for ever — a full
 * refresh once a day is what bounds that.
 *
 * Every failure here is silent and means "no cache": private windows, a full
 * disk and a blocked IndexedDB must leave the gate working exactly as before.
 */
const DB = "niko-gate";
const STORE = "roster";
const MAX_AGE_MS = 24 * 3_600_000;
/** Bump when the face model or the vector length changes. */
export const ROSTER_MODEL_TAG = "human@3.3.5/1024";

export interface CachedRoster<T> {
  cursor: number;
  people: T[];
  savedAt: number;
  modelTag: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<R>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<R>): Promise<R> {
  return open().then(
    (db) =>
      new Promise<R>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function loadRoster<T>(key: string): Promise<CachedRoster<T> | null> {
  try {
    const hit = (await run("readonly", (s) => s.get(key))) as CachedRoster<T> | undefined;
    if (!hit || hit.modelTag !== ROSTER_MODEL_TAG || Date.now() - hit.savedAt > MAX_AGE_MS) return null;
    return hit;
  } catch {
    return null;
  }
}

export async function saveRoster<T>(key: string, cursor: number, people: T[], savedAt: number): Promise<void> {
  try {
    await run("readwrite", (s) => s.put({ cursor, people, savedAt, modelTag: ROSTER_MODEL_TAG } satisfies CachedRoster<T>, key));
  } catch {
    /* no cache is a working gate */
  }
}

export async function clearRosters(): Promise<void> {
  try {
    await run("readwrite", (s) => s.clear());
  } catch {
    /* nothing to clear */
  }
}
