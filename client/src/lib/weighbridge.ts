/**
 * The platform, as one connection the whole app shares.
 *
 * A serial port can be open once. Weigh In and Weigh Out are two screens that
 * both want the same reading, and a truck walks from one to the other in a
 * single visit — so the connection cannot belong to either of them. It lives
 * here, module-level, and the panels subscribe.
 *
 * The line is fixed at what the indicator actually speaks rather than offered
 * as a choice: this is not the diagnostic screen, it is the one an operator
 * uses forty times a day, and a baud-rate dropdown beside a weight field is a
 * way to get the wrong number. `/office/weighbridge/indicator` remains the
 * place to change settings and look at raw bytes.
 */
import {
  FrameSplitter,
  type Reading,
  type WebSerialPort,
  parseReading,
  readPort,
  serialApi,
  settled,
} from "./serial";

/** Confirmed against the indicator's own display, 7 Sep 2026. */
const LINE = {
  baudRate: 2400,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
} as const;

/** Enough history for the stability check, and no more. */
const WINDOW = 12;

export type Status = "idle" | "connecting" | "open" | "error";

export interface WeighbridgeState {
  status: Status;
  /** The most recent decoded reading, stable or not. */
  reading: Reading | null;
  /** The reading only once it has held still. Null while a truck settles. */
  stable: Reading | null;
  error: string | null;
  /** Frames that arrived but did not decode — a state we have never captured. */
  unreadable: number;
}

const IDLE: WeighbridgeState = {
  status: "idle",
  reading: null,
  stable: null,
  error: null,
  unreadable: 0,
};

let state: WeighbridgeState = IDLE;
const listeners = new Set<() => void>();

function set(patch: Partial<WeighbridgeState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getSnapshot = (): WeighbridgeState => state;

/** True where the browser can open a port at all. */
export const canConnect = (): boolean => !!serialApi();

let port: WebSerialPort | null = null;
let stopReading: (() => Promise<void>) | null = null;
let opening = false;
const recent: Reading[] = [];
const splitter = new FrameSplitter();

function onChunk(bytes: Uint8Array) {
  const frames = splitter.push(bytes, Date.now());
  let unreadable = state.unreadable;
  let latest: Reading | null = null;
  for (const f of frames) {
    const r = parseReading(f.bytes);
    if (!r) {
      unreadable += 1;
      continue;
    }
    latest = r;
    recent.push(r);
    if (recent.length > WINDOW) recent.splice(0, recent.length - WINDOW);
  }
  if (latest || unreadable !== state.unreadable) {
    set({
      reading: latest ?? state.reading,
      stable: settled(recent),
      unreadable,
    });
  }
}

async function open(chosen: WebSerialPort) {
  port = chosen;
  splitter.reset();
  recent.length = 0;
  await chosen.open(LINE);
  try {
    await chosen.setSignals({ dataTerminalReady: true, requestToSend: true });
  } catch {
    // Not every driver implements the control lines, and the port is open
    // regardless. Never a reason to refuse a weight.
  }
  const { stop, done } = readPort(chosen, onChunk);
  stopReading = stop;
  set({ status: "open", error: null });
  void done.catch((e: unknown) => {
    set({
      status: "error",
      error: e instanceof Error ? e.message : "The platform stopped responding.",
    });
    void disconnect();
  });
}

/**
 * Open the port the browser already remembers, with no prompt.
 *
 * The grant persists per origin, so once the cabin has picked its port the
 * reading should simply be there — an operator should not have to answer a
 * browser dialog before weighing a lorry. Silent when there is nothing
 * remembered: that is the case the panel offers a button for.
 */
export async function connectRemembered(): Promise<void> {
  const api = serialApi();
  if (!api || port || opening) return;
  opening = true;
  try {
    const ports = await api.getPorts();
    const first = ports[0];
    if (!first) return;
    set({ status: "connecting" });
    await open(first);
  } catch (e) {
    set({ status: "error", error: e instanceof Error ? e.message : "Could not open the platform." });
    port = null;
  } finally {
    opening = false;
  }
}

/** Pick a port. Needs a click — the browser will not show the dialog without one. */
export async function choosePort(): Promise<void> {
  const api = serialApi();
  if (!api || opening) return;
  opening = true;
  try {
    const chosen = await api.requestPort();
    await disconnect();
    set({ status: "connecting" });
    await open(chosen);
  } catch (e) {
    // Dismissing the picker is a decision, not a fault.
    if (e instanceof DOMException && e.name === "NotFoundError") {
      set({ status: port ? "open" : "idle" });
    } else {
      set({ status: "error", error: e instanceof Error ? e.message : "Could not open the port." });
      port = null;
    }
  } finally {
    opening = false;
  }
}

export async function disconnect(): Promise<void> {
  const stop = stopReading;
  stopReading = null;
  if (stop) await stop();
  const open = port;
  port = null;
  if (open) {
    try {
      await open.close();
    } catch {
      // A port pulled out of its socket cannot be closed cleanly.
    }
  }
  recent.length = 0;
  splitter.reset();
  state = IDLE;
  for (const l of listeners) l();
}
