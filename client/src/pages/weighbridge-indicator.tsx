/**
 * What the weighbridge indicator is actually saying.
 *
 * The mill's platform streams its display down an RS232 line to the desktop in
 * the cabin. We know how to listen — the old FoxPro system's settings give us
 * COM3 at 2400,N,8,1 — but not what the bytes mean, and that gap is the whole
 * reason this screen exists before any parser does. A weight read off the
 * wrong offset is not a crash; it is a plausible number that quietly pays a
 * vendor the wrong amount. So: look first.
 *
 * It stays useful after the parser lands, as the answer to "the platform shows
 * a weight and the screen shows nothing" — the one place that says whether
 * bytes are arriving at all.
 *
 * Needs Chrome or Edge on a secure origin. Both hold on the cabin desktop
 * against aminofarms.com, and the port grant is remembered per origin, so the
 * picker is a one-time cost rather than a daily one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Copy, Download, Plug, Square } from "lucide-react";
import { useAuth } from "../auth";
import { WeighbridgeCamera } from "../components/weighbridge-camera";
import {
  FrameSplitter,
  type Frame,
  type WebSerialPort,
  describePort,
  escapeBytes,
  hexDump,
  numbersIn,
  parseReading,
  readPort,
  settled,
  type Reading,
  serialApi,
  toHex,
} from "../lib/serial";

/** Everything the old system had set for this platform, as the starting point. */
const LEGACY = { baudRate: 2400, dataBits: 8, parity: "none", stopBits: 1 } as const;

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

/** Keep a long shift from growing without bound. Both are generous for 2400 baud. */
const MAX_FRAMES = 400;
const MAX_RAW_BYTES = 32 * 1024;

/** Bytes arrive far faster than a screen needs to change. */
const FLUSH_MS = 250;

type View = "frames" | "raw" | "hex";

interface Counters {
  bytes: number;
  frames: number;
  openedAt: number;
  lastByteAt: number | null;
}

interface Settings {
  baudRate: number;
  dataBits: number;
  parity: "none" | "even" | "odd";
  stopBits: number;
  flowControl: "none" | "hardware";
  dtr: boolean;
  rts: boolean;
}

const DEFAULTS: Settings = {
  baudRate: LEGACY.baudRate,
  dataBits: LEGACY.dataBits,
  parity: LEGACY.parity,
  stopBits: LEGACY.stopBits,
  flowControl: "none",
  // Some indicators will not transmit until the host raises these. Asserting
  // them costs nothing on one that does not care, and a dead-looking port is
  // the most expensive thing to misdiagnose here.
  dtr: true,
  rts: true,
};

/**
 * What the traffic looks like, without claiming to understand it.
 *
 * A protocol gives itself away by shape: every frame the same length, and one
 * number inside it that moves while the rest sit still.
 *
 * The movement has to be read across the WHOLE capture, not a recent window. A
 * weight is unchanging most of the time — that is what a settled platform is —
 * so a field that has not moved lately says nothing at all. It is only worth
 * reporting against a capture taken while a truck rolls on.
 */
interface Analysis {
  dominantLength: number | null;
  lengths: Array<{ length: number; count: number }>;
  fields: Array<{ index: number; last: string; distinct: number; min: number; max: number }>;
  sampleSize: number;
}

function analyse(frames: Frame[]): Analysis {
  const lengths = new Map<number, number>();
  for (const f of frames) lengths.set(f.bytes.length, (lengths.get(f.bytes.length) ?? 0) + 1);
  const ranked = [...lengths.entries()]
    .map(([length, count]) => ({ length, count }))
    .sort((a, b) => b.count - a.count);
  const dominant = ranked[0]?.length ?? null;

  const sample = dominant == null ? [] : frames.filter((f) => f.bytes.length === dominant);
  const columns = new Map<number, string[]>();
  for (const f of sample) {
    numbersIn(f.bytes).forEach((n, i) => {
      const col = columns.get(i) ?? [];
      col.push(n);
      columns.set(i, col);
    });
  }

  const fields = [...columns.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, values]) => {
      const numeric = values.map(Number).filter((n) => Number.isFinite(n));
      return {
        index,
        last: values[values.length - 1] ?? "",
        distinct: new Set(values).size,
        min: numeric.length ? Math.min(...numeric) : 0,
        max: numeric.length ? Math.max(...numeric) : 0,
      };
    });

  return { dominantLength: dominant, lengths: ranked.slice(0, 4), fields, sampleSize: sample.length };
}

function Notice({ tone, children }: { tone: "amber" | "red" | "blue"; children: React.ReactNode }) {
  const styles = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-700",
    blue: "border-brand-200 bg-brand-50 text-brand-800",
  } as const;
  return (
    <div className={`rounded-lg border px-3 py-2 text-[13px] ${styles[tone]}`}>{children}</div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums text-gray-900">{value}</div>
    </div>
  );
}

export function WeighbridgeIndicatorPage() {
  const { can } = useAuth();
  const mayUse = can("office", "weighbridge");

  const api = serialApi();
  const supported = !!api;
  const secure = typeof window !== "undefined" && window.isSecureContext;

  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [port, setPort] = useState<WebSerialPort | null>(null);
  const [remembered, setRemembered] = useState<WebSerialPort[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("frames");

  const [frames, setFrames] = useState<Frame[]>([]);
  const [raw, setRaw] = useState<Uint8Array>(new Uint8Array());
  const [counters, setCounters] = useState<Counters>({
    bytes: 0,
    frames: 0,
    openedAt: 0,
    lastByteAt: null,
  });
  /** Ticks once a second so "last byte 4s ago" stays honest on a silent line. */
  const [, setTick] = useState(0);

  // Buffers live in refs and flush on a timer: at 2400 baud a frame can land
  // ten times a second, and re-rendering a hex dump that often is wasted work.
  const framesRef = useRef<Frame[]>([]);
  const rawRef = useRef<number[]>([]);
  const countersRef = useRef<Counters>(counters);
  const dirtyRef = useRef(false);
  const splitterRef = useRef(new FrameSplitter());
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  const portRef = useRef<WebSerialPort | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.getPorts().then(setRemembered).catch(() => setRemembered([]));
  }, [api]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setFrames([...framesRef.current]);
      setRaw(Uint8Array.from(rawRef.current));
      setCounters({ ...countersRef.current });
    }, FLUSH_MS);
    return () => window.clearInterval(id);
  }, []);

  const onChunk = useCallback((bytes: Uint8Array) => {
    const counts = countersRef.current;
    counts.bytes += bytes.length;
    counts.lastByteAt = Date.now();

    for (const b of bytes) rawRef.current.push(b);
    if (rawRef.current.length > MAX_RAW_BYTES) {
      rawRef.current = rawRef.current.slice(-MAX_RAW_BYTES);
    }

    const fresh = splitterRef.current.push(bytes, Date.now() - counts.openedAt);
    if (fresh.length) {
      counts.frames += fresh.length;
      framesRef.current = [...framesRef.current, ...fresh].slice(-MAX_FRAMES);
    }
    dirtyRef.current = true;
  }, []);

  const disconnect = useCallback(async () => {
    const stop = stopRef.current;
    stopRef.current = null;
    if (stop) await stop();
    const open = portRef.current;
    portRef.current = null;
    if (open) {
      try {
        await open.close();
      } catch {
        // A port yanked out of the socket cannot be closed cleanly, and there
        // is nothing useful to tell anybody about that.
      }
    }
    setConnected(false);
  }, []);

  // Leaving the screen must hand the port back, or the next visit cannot open it.
  useEffect(() => () => void disconnect(), [disconnect]);

  const choosePort = async () => {
    if (!api) return;
    setError(null);
    try {
      // No filters. A true RS232 port off the motherboard has no USB identity,
      // and a filter would hide exactly the port most likely wanted here.
      const chosen = await api.requestPort();
      setPort(chosen);
      setRemembered(await api.getPorts().catch(() => []));
    } catch (e) {
      // Dismissing the picker is a decision, not a fault.
      if (e instanceof DOMException && e.name === "NotFoundError") return;
      setError(e instanceof Error ? e.message : "Could not open the port picker.");
    }
  };

  const connect = async () => {
    if (!port) return;
    setBusy(true);
    setError(null);
    try {
      await port.open({
        baudRate: settings.baudRate,
        dataBits: settings.dataBits,
        stopBits: settings.stopBits,
        parity: settings.parity,
        flowControl: settings.flowControl,
        bufferSize: 4096,
      });
      try {
        await port.setSignals({ dataTerminalReady: settings.dtr, requestToSend: settings.rts });
      } catch {
        // Not every driver implements the control lines. Never fatal: the port
        // is open, and most indicators talk regardless.
      }

      splitterRef.current.reset();
      framesRef.current = [];
      rawRef.current = [];
      countersRef.current = { bytes: 0, frames: 0, openedAt: Date.now(), lastByteAt: null };
      dirtyRef.current = true;

      const { stop, done } = readPort(port, onChunk);
      stopRef.current = stop;
      portRef.current = port;
      setConnected(true);
      void done.catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "The port stopped responding.");
        void disconnect();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the port.");
      try {
        await port.close();
      } catch {
        // It never opened; closing is best effort.
      }
    } finally {
      setBusy(false);
    }
  };

  const analysis = useMemo(() => analyse(frames), [frames]);

  /*
   * What the line means, not just what it says.
   *
   * Decoded here rather than in the read loop so a frame that stops matching
   * shows up as "not recognised" on screen instead of quietly holding the last
   * good number — an indicator in a state nobody has captured yet must look
   * different from one that agrees with us.
   */
  const readings = useMemo(() => {
    const out: Reading[] = [];
    for (const f of frames) {
      const r = parseReading(f.bytes);
      if (r) out.push(r);
    }
    return out;
  }, [frames]);
  const latest = readings.length ? readings[readings.length - 1]! : null;
  const stable = settled(readings);
  const unreadable = frames.length - readings.length;

  /** The newest thing the line said, for stamping a still. */
  const latestFrameText = frames.length ? escapeBytes((frames[frames.length - 1] as Frame).bytes) : null;

  const elapsed = counters.openedAt ? (Date.now() - counters.openedAt) / 1000 : 0;
  const rate = elapsed > 0 ? counters.bytes / elapsed : 0;
  const silentFor = counters.lastByteAt ? (Date.now() - counters.lastByteAt) / 1000 : null;

  /** The whole point of the screen: something I can paste into a conversation. */
  const report = useMemo(() => {
    const lines: string[] = [];
    lines.push("niko — weighbridge indicator capture");
    lines.push(`Taken       ${new Date().toISOString()}`);
    lines.push(`Origin      ${typeof window === "undefined" ? "?" : window.location.origin}`);
    lines.push(
      `Line        ${settings.baudRate} baud, ${settings.dataBits}${settings.parity[0]?.toUpperCase()}${settings.stopBits}` +
        `, flow ${settings.flowControl}, DTR ${settings.dtr ? "on" : "off"}, RTS ${settings.rts ? "on" : "off"}`,
    );
    lines.push(`Port        ${port ? describePort(port) : "—"}`);
    lines.push(
      `Traffic     ${counters.bytes} bytes over ${elapsed.toFixed(1)}s (${rate.toFixed(0)} B/s), ${counters.frames} frames`,
    );
    lines.push("");
    lines.push(
      `Frame lengths  ${
        analysis.lengths.map((l) => `${l.length}B x${l.count}`).join(", ") || "none"
      }`,
    );
    if (analysis.fields.length) {
      lines.push(`Numeric fields in the ${analysis.dominantLength}-byte frames (${analysis.sampleSize} sampled):`);
      for (const f of analysis.fields) {
        lines.push(
          `  #${f.index}  last ${f.last}  ${f.distinct} distinct  range ${f.min}..${f.max}` +
            (f.distinct === 1 ? "  (never changed in this capture)" : ""),
        );
      }
    }
    lines.push(
      `Decoded       ${
        latest ? `${latest.kg} kg  (${latest.raw} — ${latest.value} ${latest.unit}, mode ${latest.mode})` : "nothing recognised"
      }`,
    );
    lines.push(`              ${readings.length} of ${frames.length} frames decoded, ${stable ? "stable" : "settling"}`);
    lines.push("");
    lines.push(`Last ${Math.min(frames.length, 60)} frames (escaped, newest last):`);
    for (const f of frames.slice(-60)) {
      lines.push(
        `  ${String(f.at).padStart(7)}ms  ${String(f.bytes.length).padStart(3)}B  ${f.end.padEnd(5)}  ${escapeBytes(f.bytes)}`,
      );
    }
    lines.push("");
    lines.push(`Raw hex, last ${Math.min(raw.length, 2048)} bytes:`);
    lines.push(hexDump(raw.subarray(Math.max(0, raw.length - 2048))));
    return lines.join("\n");
  }, [analysis, counters, elapsed, frames, latest, port, rate, raw, readings, settings, stable]);

  const download = () => {
    const blob = new Blob([report], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weighbridge-capture-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!mayUse) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <Notice tone="amber">
          Reading the platform needs the Weighbridge permission on the Office module.
        </Notice>
      </div>
    );
  }

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="page-header -mx-4 mb-4 flex items-baseline justify-between gap-4 px-4 py-3 sm:-mx-6 sm:px-6">
        <h1 className="text-[19px] font-semibold text-gray-900">Weighbridge indicator</h1>
        <Link href="/office/unloading" className="flex items-center gap-1 text-[13px] text-brand-600 hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" />
          Weighment
        </Link>
      </div>

      <p className="mb-4 text-[13px] leading-relaxed text-gray-500">
        Reads the serial line raw and shows what arrives. Nothing here interprets a weight yet —
        put a truck on the platform, capture a minute of traffic, and the format follows from what
        the frames actually look like.
      </p>

      {!secure && (
        <div className="mb-3">
          <Notice tone="red">
            This page is not on a secure origin, so the browser will not open a serial port. Use
            the https address.
          </Notice>
        </div>
      )}
      {!supported && (
        <div className="mb-3">
          <Notice tone="amber">
            This browser has no Web Serial support. The cabin desktop needs Chrome or Edge —
            Firefox and Safari cannot open a COM port at all.
          </Notice>
        </div>
      )}
      {error && (
        <div className="mb-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}

      {/* ── The line ── */}
      <div className="card mb-4 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={choosePort} disabled={!supported || connected}>
            <Plug className="h-3.5 w-3.5" />
            {port ? "Choose a different port…" : "Choose port…"}
          </button>
          {!connected ? (
            <button className="btn-primary" onClick={() => void connect()} disabled={!port || busy}>
              {busy ? "Opening…" : "Connect"}
            </button>
          ) : (
            <button className="btn-secondary" onClick={() => void disconnect()}>
              <Square className="h-3.5 w-3.5" />
              Disconnect
            </button>
          )}
          {connected && (
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-green-600">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              Open
            </span>
          )}
        </div>

        <div className="mb-3 text-[12px] text-gray-500">
          {port ? describePort(port) : "No port chosen yet."}
          {!port && remembered.length > 0 && (
            <span className="ml-1">
              {remembered.length} port{remembered.length === 1 ? "" : "s"} already granted on this
              machine —{" "}
              <button
                className="text-brand-600 hover:underline"
                onClick={() => setPort(remembered[0] ?? null)}
              >
                use the first
              </button>
              .
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div>
            <label className="label">Baud</label>
            <select
              className="input"
              value={settings.baudRate}
              disabled={connected}
              onChange={(e) => set("baudRate", Number(e.target.value))}
            >
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Data bits</label>
            <select
              className="input"
              value={settings.dataBits}
              disabled={connected}
              onChange={(e) => set("dataBits", Number(e.target.value))}
            >
              <option value={7}>7</option>
              <option value={8}>8</option>
            </select>
          </div>
          <div>
            <label className="label">Parity</label>
            <select
              className="input"
              value={settings.parity}
              disabled={connected}
              onChange={(e) => set("parity", e.target.value as Settings["parity"])}
            >
              <option value="none">None</option>
              <option value="even">Even</option>
              <option value="odd">Odd</option>
            </select>
          </div>
          <div>
            <label className="label">Stop bits</label>
            <select
              className="input"
              value={settings.stopBits}
              disabled={connected}
              onChange={(e) => set("stopBits", Number(e.target.value))}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </div>
          <div>
            <label className="label">Flow control</label>
            <select
              className="input"
              value={settings.flowControl}
              disabled={connected}
              onChange={(e) => set("flowControl", e.target.value as Settings["flowControl"])}
            >
              <option value="none">None</option>
              <option value="hardware">Hardware</option>
            </select>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px] text-gray-600">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={settings.dtr}
              disabled={connected}
              onChange={(e) => set("dtr", e.target.checked)}
            />
            Assert DTR
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={settings.rts}
              disabled={connected}
              onChange={(e) => set("rts", e.target.checked)}
            />
            Assert RTS
          </label>
          <span className="text-gray-400">
            The old system used {LEGACY.baudRate},N,{LEGACY.dataBits},{LEGACY.stopBits} on COM3 —
            start there, and if the bytes look like rubbish, work up the baud rates.
          </span>
        </div>
      </div>

      {/* ── What is arriving ── */}
      {connected && (
        <div className="card mb-4 grid grid-cols-2 gap-4 p-4 sm:grid-cols-5">
          <Stat label="Bytes" value={counters.bytes.toLocaleString("en-IN")} />
          <Stat label="Rate" value={`${rate.toFixed(0)} B/s`} />
          <Stat label="Frames" value={counters.frames.toLocaleString("en-IN")} />
          <Stat label="Open for" value={`${elapsed.toFixed(0)}s`} />
          <Stat
            label="Last byte"
            value={silentFor == null ? "never" : `${silentFor.toFixed(1)}s ago`}
          />
        </div>
      )}

      {connected && counters.bytes === 0 && elapsed > 4 && (
        <div className="mb-4">
          <Notice tone="amber">
            The port is open but nothing has arrived. Either this is the wrong port, the indicator
            only speaks when polled, or the cable is a null-modem where a straight one is wanted.
            Try the other ports in the picker before changing the baud rate.
          </Notice>
        </div>
      )}

      {/* ── What it currently reads ── */}
      {connected && (
        <div className="card mb-4 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-400">
                Decoded weight
              </div>
              {latest ? (
                <div className="text-[34px] font-semibold leading-tight tabular-nums text-gray-900">
                  {latest.kg.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                  <span className="ml-1 text-[16px] font-normal text-gray-400">kg</span>
                </div>
              ) : (
                <div className="text-[20px] text-gray-400">—</div>
              )}
              {latest && (
                <div className="font-mono text-[11px] text-gray-400">
                  {latest.raw} · {latest.value} {latest.unit === "t" ? "tonnes" : latest.unit} ·
                  mode {latest.mode}
                </div>
              )}
            </div>
            <div className="text-right">
              {stable ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-[12px] font-medium text-green-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  Stable
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Settling
                </span>
              )}
              <div className="mt-1 text-[11px] text-gray-400">
                {readings.length} read
                {unreadable > 0 && <span className="text-amber-600"> · {unreadable} not recognised</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Shape of the traffic ── */}
      {analysis.dominantLength != null && (
        <div className="card mb-4 p-4">
          <div className="mb-2 text-[13px] font-semibold text-gray-900">Shape</div>
          <div className="mb-3 text-[12px] text-gray-500">
            Frame lengths:{" "}
            {analysis.lengths.map((l) => `${l.length} bytes × ${l.count}`).join(" · ")}
            {analysis.lengths.length === 1 && " — one fixed width, which is the easy case."}
          </div>
          {analysis.fields.length > 0 && (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="s-th">Number</th>
                  <th className="s-th text-right">Latest</th>
                  <th className="s-th text-right">Distinct</th>
                  <th className="s-th text-right">Range</th>
                  <th className="s-th">Reading</th>
                </tr>
              </thead>
              <tbody>
                {analysis.fields.map((f) => (
                  <tr key={f.index} className="border-b border-gray-100">
                    <td className="px-3 py-1.5 font-mono text-[12px] text-gray-500">#{f.index}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-[13px] font-semibold tabular-nums text-gray-900">
                      {f.last}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[12px] tabular-nums text-gray-500">
                      {f.distinct}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[12px] tabular-nums text-gray-500">
                      {f.min} … {f.max}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-gray-500">
                      {f.distinct === 1
                        ? "never changed in this capture"
                        : `moved across ${f.distinct} values`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
            A settled weight never changes either, so "never changed" does not rule a field out.
            Capture while the truck drives on: the number that climbs with the display is the one
            we want, and its position in the frame is the format.
          </p>
        </div>
      )}

      {/* ── The bytes ── */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2">
          <div className="flex gap-1" role="tablist">
            {(["frames", "raw", "hex"] as View[]).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-1 text-[12px] capitalize ${
                  view === v ? "bg-brand-50 font-semibold text-brand-700" : "text-gray-500"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              className="btn-ghost"
              disabled={!counters.bytes}
              onClick={() => void navigator.clipboard.writeText(report)}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </button>
            <button className="btn-secondary" disabled={!counters.bytes} onClick={download}>
              <Download className="h-3.5 w-3.5" />
              Save capture
            </button>
          </div>
        </div>

        {counters.bytes === 0 ? (
          <div className="p-8 text-center text-[13px] text-gray-400">
            Nothing captured yet.
          </div>
        ) : view === "frames" ? (
          <div className="max-h-[26rem] overflow-auto">
            <table className="w-full">
              <tbody>
                {[...frames].reverse().map((f, i) => {
                  const nums = numbersIn(f.bytes);
                  return (
                    <tr key={`${f.at}-${i}`} className="border-b border-gray-100">
                      <td className="whitespace-nowrap px-3 py-1 text-right font-mono text-[11px] tabular-nums text-gray-400">
                        {f.at}ms
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[11px] text-gray-400">
                        {f.bytes.length}B
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-gray-400">
                        {f.end}
                      </td>
                      <td className="w-full px-3 py-1 font-mono text-[12px] text-gray-900">
                        {escapeBytes(f.bytes)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1 text-right font-mono text-[12px] tabular-nums text-brand-700">
                        {nums.join(" · ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : view === "raw" ? (
          <pre className="max-h-[26rem] overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px] leading-relaxed text-gray-800">
            {escapeBytes(raw)}
          </pre>
        ) : (
          <pre className="max-h-[26rem] overflow-auto p-3 font-mono text-[12px] leading-relaxed text-gray-800">
            {hexDump(raw.subarray(Math.max(0, raw.length - 4096)))}
          </pre>
        )}
      </div>

      {/* The camera sits under the bytes because the pairing is the point: a
          still is only worth keeping if it can be tied to a reading. Each one
          is stamped with whatever the line was saying at the shutter. */}
      <div className="mt-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold text-gray-900">Camera</h2>
          <span className="text-[12px] text-gray-400">
            {latestFrameText
              ? "Stills are stamped with the live reading"
              : "Connect the port and stills carry the reading too"}
          </span>
        </div>
        <WeighbridgeCamera note={latestFrameText} />
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-gray-400">
        Save the capture with a known weight on the platform and tell us what the display read.
        One number on screen and the same number in the bytes is all the parser needs.
        {frames.length > 0 && analysis.dominantLength != null && (
          <>
            {" "}
            Latest frame:{" "}
            <span className="font-mono text-gray-600">
              {toHex((frames[frames.length - 1] as Frame).bytes)}
            </span>
          </>
        )}
      </p>
    </div>
  );
}
