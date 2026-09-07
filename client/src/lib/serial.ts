/**
 * The weighbridge indicator, over RS232, straight into the browser.
 *
 * The platform in the mill cabin streams its display over a serial line to the
 * desktop sitting beside it. Chrome and Edge can open that line themselves on
 * a secure origin, so nothing needs installing on that machine — no agent, no
 * Windows service, no serial-to-Ethernet box. This module is the thin part:
 * the types the DOM lib does not ship, opening a port, and turning the byte
 * stream into frames.
 *
 * It deliberately knows NOTHING about what a weight looks like. We have the
 * line settings out of the old FoxPro system (COM3, 2400,N,8,1) but not the
 * frame format, and a parser guessed wrong reads a plausible number off the
 * wrong offset and pays a vendor against it. So this reads bytes and shows
 * them; the parser comes after somebody has seen what actually arrives.
 */

// ─────────────────────────── The Web Serial API ───────────────────────────
// Not in TypeScript's DOM lib. Declared here under our own names rather than
// the spec's, so that this keeps compiling on the day the DOM lib does ship
// `Serial` and `SerialPort`.

export interface WebSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface WebSerialOpenOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: "none" | "even" | "odd";
  bufferSize?: number;
  flowControl?: "none" | "hardware";
}

export interface WebSerialSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

export interface WebSerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: WebSerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): WebSerialPortInfo;
  setSignals(signals: WebSerialSignals): Promise<void>;
}

export interface WebSerial {
  getPorts(): Promise<WebSerialPort[]>;
  requestPort(options?: { filters?: WebSerialPortInfo[] }): Promise<WebSerialPort>;
}

/** The API, or undefined on a browser or an origin that cannot offer it. */
export const serialApi = (): WebSerial | undefined =>
  (navigator as Navigator & { serial?: WebSerial }).serial;

/**
 * The USB-to-UART bridge shipped with the weighbridge, for naming a port the
 * operator has picked. NOT used as a picker filter: a true RS232 port off the
 * motherboard has no USB identity at all, and filtering would hide the very
 * port we are most likely looking for.
 */
export const MA112 = { usbVendorId: 0x0e6a, usbProductId: 0x0122 } as const;

export function describePort(port: WebSerialPort): string {
  const info = port.getInfo();
  if (info.usbVendorId == null) return "Serial port (no USB identity — likely an onboard RS232 port)";
  const id = (n: number) => n.toString(16).padStart(4, "0").toUpperCase();
  const known =
    info.usbVendorId === MA112.usbVendorId && info.usbProductId === MA112.usbProductId
      ? " — Megawin MA112, the adapter that came with the weighbridge"
      : "";
  return `USB ${id(info.usbVendorId)}:${id(info.usbProductId ?? 0)}${known}`;
}

// ──────────────────────────────── Framing ────────────────────────────────

/** Control bytes worth naming when we print a frame back to a human. */
const CONTROL_NAMES: Record<number, string> = {
  0x00: "NUL",
  0x01: "SOH",
  0x02: "STX",
  0x03: "ETX",
  0x04: "EOT",
  0x05: "ENQ",
  0x06: "ACK",
  0x07: "BEL",
  0x08: "BS",
  0x09: "TAB",
  0x0a: "LF",
  0x0b: "VT",
  0x0c: "FF",
  0x0d: "CR",
  0x15: "NAK",
  0x16: "SYN",
  0x17: "ETB",
  0x1b: "ESC",
  0x7f: "DEL",
};

/** A byte stream as a person can read it: printable kept, the rest named. */
export function escapeBytes(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `<${CONTROL_NAMES[b] ?? b.toString(16).padStart(2, "0").toUpperCase()}>`;
  }
  return out;
}

export function toHex(bytes: Uint8Array, separator = " "): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(separator);
}

/** A classic hex dump — offset, sixteen bytes, then the printable gutter. */
export function hexDump(bytes: Uint8Array, perRow = 16): string {
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += perRow) {
    const slice = bytes.subarray(i, i + perRow);
    const hex = toHex(slice).padEnd(perRow * 3 - 1, " ");
    let gutter = "";
    for (const b of slice) gutter += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
    rows.push(`${i.toString(16).padStart(6, "0")}  ${hex}  ${gutter}`);
  }
  return rows.join("\n");
}

export interface Frame {
  /** Milliseconds since the connection opened. */
  at: number;
  bytes: Uint8Array;
  /** What ended it: CR, LF, CRLF, ETX, or "none" for an undelimited run. */
  end: string;
}

/** Bytes we treat as the end of a frame, and what to call each. */
const TERMINATORS: Record<number, string> = { 0x0d: "CR", 0x0a: "LF", 0x03: "ETX" };

/**
 * A frame is whatever arrives between terminators.
 *
 * Chunks off the port do not respect frame boundaries, so the tail of one read
 * has to wait for the next — hence the retained buffer rather than a pure
 * function.
 *
 * Some indicators send a fixed-width record with no delimiter at all. Waiting
 * for a terminator that never comes would leave the screen blank on exactly
 * the protocol hardest to guess, so an over-long run is emitted anyway and
 * marked as undelimited.
 */
export class FrameSplitter {
  private pending: number[] = [];
  private last: Frame | null = null;

  constructor(private readonly maxUndelimited = 120) {}

  push(chunk: Uint8Array, at: number): Frame[] {
    const out: Frame[] = [];
    for (const byte of chunk) {
      const terminator = TERMINATORS[byte];
      if (terminator) {
        if (this.pending.length > 0) {
          const frame: Frame = { at, bytes: Uint8Array.from(this.pending), end: terminator };
          this.pending = [];
          this.last = frame;
          out.push(frame);
        } else if (terminator === "LF" && this.last?.end === "CR") {
          // A CRLF pair, not an empty frame between two terminators.
          this.last.end = "CRLF";
        }
        continue;
      }
      // STX opens a record; anything still buffered belonged to the last one.
      if (byte === 0x02 && this.pending.length > 0) {
        const frame: Frame = { at, bytes: Uint8Array.from(this.pending), end: "STX" };
        this.pending = [];
        this.last = frame;
        out.push(frame);
        continue;
      }
      if (byte === 0x02) continue;
      this.pending.push(byte);
      if (this.pending.length >= this.maxUndelimited) {
        const frame: Frame = { at, bytes: Uint8Array.from(this.pending), end: "none" };
        this.pending = [];
        this.last = frame;
        out.push(frame);
      }
    }
    return out;
  }

  reset() {
    this.pending = [];
    this.last = null;
  }
}

/**
 * Every number visible in a frame, in order.
 *
 * Not a parser — a hint. If one of these tracks the platform's display as a
 * truck rolls on, that is the field, and its position tells us the format.
 */
export function numbersIn(bytes: Uint8Array): string[] {
  let text = "";
  for (const b of bytes) text += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : " ";
  return text.match(/[+-]?\d+(?:\.\d+)?/g) ?? [];
}

/**
 * Read a port until stopped.
 *
 * Resolves when the stream ends or `stop()` is called; rejects only on a real
 * device error, so a caller can tell a cable pulled out from a clean close.
 */
export function readPort(
  port: WebSerialPort,
  onChunk: (bytes: Uint8Array) => void,
): { done: Promise<void>; stop: () => Promise<void> } {
  const stream = port.readable;
  if (!stream) {
    return { done: Promise.reject(new Error("The port has no readable stream.")), stop: async () => {} };
  }
  const reader = stream.getReader();
  let stopping = false;

  const done = (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        if (value && value.length > 0) onChunk(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released by cancel(); nothing to do.
      }
    }
  })();

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await reader.cancel();
    } catch {
      // The port may already be gone — closing is still the right next move.
    }
    await done.catch(() => {});
  };

  return { done, stop };
}
