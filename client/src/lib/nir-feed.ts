/**
 * The NIR analyser's results, read straight off the bench PC by the browser.
 *
 * IAS Pro2 — the analyser's own Windows software — has no export to anything
 * but its vendor's cloud. What it does have is a plain SQLite file beside its
 * exe, `pro2.db`, holding every scan in `DBResult` and the model list (with
 * the name behind each "1", "2", "3" reading) in `DBDevice`. Chrome can read a
 * local file the user has picked once, and remember the pick per origin, so —
 * like the weighbridge's serial port — nothing is installed on that machine.
 *
 * The file is re-read every few seconds while niko is open on the bench, and
 * any scan new or changed since the last read is posted. The last three days
 * are always re-read rather than only new rows, because IAS lets a sample be
 * renamed after the scan and the rename is how a mistyped GR is fixed.
 *
 * Module-level and shared, like the weighbridge: the Weighment page starts it,
 * and it keeps running while the app is open at that desk.
 */
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { NirUploadModel, NirUploadRow } from "@shared/nir";
import { api } from "../api";

// ───────────────── File System Access — not all of it is in the DOM lib ─────────────────

interface ReadHandle {
  name: string;
  getFile(): Promise<File>;
  queryPermission(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission(o: { mode: "read" }): Promise<PermissionState>;
}
type Picker = (o: {
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
}) => Promise<ReadHandle[]>;
const picker = (): Picker | undefined => (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker;

/** True where this browser can read a local file again without asking each time. */
export const canRead = (): boolean => !!picker() && !!window.indexedDB;

// ───────────────────────────── Remembering the pick ─────────────────────────────

const IDB = "niko-nir";
const STORE = "handles";
const KEY = "pro2";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveHandle(h: ReadHandle | null) {
  const d = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    if (h) tx.objectStore(STORE).put(h, KEY);
    else tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function loadHandle(): Promise<ReadHandle | null> {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as ReadHandle | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

// ─────────────────────────────────── State ───────────────────────────────────

export type Status =
  | "unsupported" // no File System Access — not Chrome/Edge, or not https
  | "idle" // nothing picked yet
  | "needs-permission" // picked before, Chrome wants a click to read it again
  | "ok"
  | "error";

export interface NirFeedState {
  status: Status;
  fileName: string | null;
  /** When the file was last read cleanly. */
  readAt: number | null;
  /** When niko last took scans from this browser. */
  uploadedAt: number | null;
  /** Scans in the last three days, as the file holds them. */
  scansInWindow: number;
  error: string | null;
}

let state: NirFeedState = {
  status: canRead() ? "idle" : "unsupported",
  fileName: null,
  readAt: null,
  uploadedAt: null,
  scansInWindow: 0,
  error: null,
};
const listeners = new Set<() => void>();
function set(patch: Partial<NirFeedState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export const getSnapshot = (): NirFeedState => state;

// ─────────────────────────────────── Reading ───────────────────────────────────

const POLL_MS = 5_000;
const WINDOW_DAYS = 3;
const BATCH = 100;

let handle: ReadHandle | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
let lastModified = -1;
let sqlJs: Promise<SqlJsStatic> | null = null;
/** resultSn → what was last sent, so an unchanged scan is not re-posted. */
const sent = new Map<string, string>();
let modelsSent = "";

const loadSql = () => (sqlJs ??= initSqlJs({ locateFile: () => wasmUrl }));

/** IAS writes local wall-clock time with no zone; the bench is in IST. */
function withIst(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  return /([+-]\d{2}:?\d{2}|Z)$/.test(s) ? s : `${s}+05:30`;
}

/** Now minus the window, as IAS's own local-time text, for a plain string compare. */
function windowStartIst(): string {
  return new Date(Date.now() + 5.5 * 3_600_000 - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 19);
}

function all<T>(db: Database, sql: string, params: (string | number)[] = []): T[] {
  const st = db.prepare(sql);
  st.bind(params);
  const out: T[] = [];
  while (st.step()) out.push(st.getAsObject() as T);
  st.free();
  return out;
}

interface IasModel {
  ShortName?: string;
  ModelName?: string;
  ModelVersion?: string;
  MatterNames?: Record<string, string>;
}

/** The model list IAS keeps on the device record — the names behind "1", "2", "3". */
function modelsOf(db: Database): IasModel[] {
  const rows = all<{ info: string | null }>(db, "SELECT info FROM DBDevice ORDER BY lastdate DESC");
  const seen = new Map<string, IasModel>();
  for (const r of rows) {
    try {
      const info = JSON.parse(r.info ?? "{}") as Record<string, unknown>;
      const list = (info["产品列表"] ?? []) as IasModel[];
      for (const m of list) if (m.ShortName && !seen.has(m.ShortName)) seen.set(m.ShortName, m);
    } catch {
      // A device record IAS has not filled in yet. Its scans still carry
      // numbered readings; they just cannot be named until it is.
    }
  }
  return [...seen.values()];
}

interface IasItems {
  TestValues?: Record<string, number>;
  ResultColors?: Record<string, number>;
  ShowMatter?: string[];
  ShortName?: string;
  Version?: string;
}

function toRow(
  r: {
    id: number;
    devicesn: string;
    modelname: string | null;
    samplename: string | null;
    items: string | null;
    status: number | null;
    generatedate: string | null;
    resultsn: string | null;
  },
  models: Map<string, IasModel>,
): NirUploadRow | null {
  const scannedAt = withIst(r.generatedate);
  if (!r.resultsn || !scannedAt) return null;
  let items: IasItems = {};
  try {
    items = JSON.parse(r.items ?? "{}") as IasItems;
  } catch {
    return null;
  }
  const model = items.ShortName || r.modelname || "";
  if (!model) return null;
  const names = models.get(model)?.MatterNames ?? {};
  const values = items.TestValues ?? {};
  const ids = items.ShowMatter?.length ? items.ShowMatter : Object.keys(values);
  const readings: Record<string, number> = {};
  const flags: Record<string, number> = {};
  for (const id of ids) {
    const v = Number(values[id]);
    if (!Number.isFinite(v)) continue;
    const name = names[id] ?? `#${id}`;
    readings[name] = v;
    flags[name] = Number(items.ResultColors?.[id] ?? 0);
  }
  return {
    iasId: Number(r.id),
    resultSn: r.resultsn,
    deviceSn: r.devicesn,
    model,
    modelVersion: items.Version ?? null,
    sampleName: r.samplename,
    scannedAt,
    iasStatus: r.status == null ? null : Number(r.status),
    readings,
    flags,
    raw: items,
  };
}

async function readOnce(force = false) {
  if (!handle || busy) return;
  busy = true;
  try {
    const file = await handle.getFile();
    if (!force && file.lastModified === lastModified) return;
    const SQL = await loadSql();
    let db: Database;
    try {
      db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
    } catch {
      // Caught IAS half-way through a write. The next read gets it.
      return;
    }
    try {
      const models = modelsOf(db);
      const byShort = new Map(models.map((m) => [m.ShortName!, m]));
      const rows = all<Parameters<typeof toRow>[0]>(
        db,
        `SELECT id, devicesn, modelname, samplename, items, status, generatedate, resultsn
           FROM DBResult WHERE generatedate >= ? ORDER BY id`,
        [windowStartIst()],
      )
        .map((r) => toRow(r, byShort))
        .filter((r): r is NirUploadRow => !!r);

      const fresh = rows.filter((r) => sent.get(r.resultSn) !== signature(r));
      const uploadModels: NirUploadModel[] = models.map((m) => ({
        shortName: m.ShortName!,
        modelName: m.ModelName ?? null,
        version: m.ModelVersion ?? null,
        matterNames: m.MatterNames ?? {},
      }));
      const modelsSig = JSON.stringify(uploadModels);
      const deviceSn = rows[rows.length - 1]?.deviceSn ?? null;

      if (fresh.length || modelsSig !== modelsSent) {
        for (let i = 0; i < Math.max(fresh.length, 1); i += BATCH) {
          const batch = fresh.slice(i, i + BATCH);
          await api("/api/office/nir/results", {
            method: "POST",
            body: { deviceSn, models: i === 0 ? uploadModels : [], rows: batch },
          });
          for (const r of batch) sent.set(r.resultSn, signature(r));
        }
        modelsSent = modelsSig;
        set({ uploadedAt: Date.now() });
      }
      lastModified = file.lastModified;
      set({ status: "ok", error: null, readAt: Date.now(), scansInWindow: rows.length, fileName: handle.name });
    } finally {
      db.close();
    }
  } catch (e) {
    if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
      stop();
      set({ status: "needs-permission", error: null });
    } else if (e instanceof DOMException && e.name === "NotFoundError") {
      stop();
      set({ status: "error", error: "The IAS file is not where it was — pick pro2.db again." });
    } else {
      set({ status: "error", error: e instanceof Error ? e.message : "Could not read the IAS file." });
    }
  } finally {
    busy = false;
  }
}

const signature = (r: NirUploadRow) => `${r.sampleName}|${r.iasStatus}|${JSON.stringify(r.readings)}`;

function run() {
  stop();
  lastModified = -1;
  void readOnce(true);
  timer = setInterval(() => void readOnce(), POLL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Pick the remembered file back up, with no prompt where Chrome allows it.
 * Safe to call on every mount.
 */
export async function start(): Promise<void> {
  if (!canRead() || handle) return;
  try {
    const h = await loadHandle();
    if (!h) return;
    handle = h;
    set({ fileName: h.name });
    if ((await h.queryPermission({ mode: "read" })) === "granted") run();
    else set({ status: "needs-permission" });
  } catch (e) {
    set({ status: "error", error: e instanceof Error ? e.message : "Could not reopen the IAS file." });
  }
}

/** Pick pro2.db. Needs a click. */
export async function chooseFile(): Promise<void> {
  const open = picker();
  if (!open) return;
  try {
    const [h] = await open({
      types: [{ description: "IAS database (pro2.db)", accept: { "application/octet-stream": [".db"] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    });
    if (!h) return;
    handle = h;
    sent.clear();
    modelsSent = "";
    await saveHandle(h);
    set({ fileName: h.name, error: null });
    run();
  } catch (e) {
    // Closing the picker is a decision, not a fault.
    if (e instanceof DOMException && e.name === "AbortError") return;
    set({ status: "error", error: e instanceof Error ? e.message : "Could not open the file." });
  }
}

/** Chrome asks again after a restart unless "allow on every visit" was ticked. Needs a click. */
export async function grant(): Promise<void> {
  if (!handle) return;
  try {
    if ((await handle.requestPermission({ mode: "read" })) === "granted") run();
  } catch (e) {
    set({ status: "error", error: e instanceof Error ? e.message : "Chrome refused the file." });
  }
}

export async function forget(): Promise<void> {
  stop();
  handle = null;
  sent.clear();
  modelsSent = "";
  await saveHandle(null);
  set({ status: canRead() ? "idle" : "unsupported", fileName: null, readAt: null, scansInWindow: 0, error: null });
}
