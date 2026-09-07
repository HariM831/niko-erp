/**
 * The camera over the platform.
 *
 * A weight on its own is a number somebody typed or a number a machine sent,
 * and a month later there is no way to tell which truck it belonged to. A
 * still taken at the moment of the reading is what makes it evidence.
 *
 * Two sources. A USB webcam through `getUserMedia` needs nothing installed and
 * is the fallback everywhere; an IP camera has the lens that actually reads a
 * number plate, and no browser can reach one — an HTTPS page may not fetch
 * http://, the cameras send no CORS headers, an <img> cannot do digest auth,
 * and nothing plays RTSP. `agent/weighbridge-cameras.mjs` bridges that from the
 * cabin desktop, and this offers its cameras only when it is answering.
 *
 * A capture is handed out as a `File`, not a blob URL, so it drops straight
 * into the attachment queue every other create screen already uses. There is
 * one way to attach a file in niko and this is not a second one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Download, RefreshCw } from "lucide-react";

/** The picked camera outlives the visit; a cabin has one and it does not move. */
const DEVICE_KEY = "niko.weighbridge.camera";
const SOURCE_KEY = "niko.weighbridge.camera-source";

/**
 * The cabin's camera relay, if somebody is running one.
 *
 * A webcam is what works with nothing installed, but it is a wide lens a metre
 * from a windscreen and a number plate in it is often a grey smudge. The mill
 * already owns IP cameras with proper lenses, and no browser can reach one: an
 * HTTPS page may not fetch http://, the cameras send no CORS headers, an <img>
 * cannot do digest auth, and nothing plays RTSP.
 *
 * `agent/weighbridge-cameras.mjs` bridges that from the cabin desktop. 127.0.0.1
 * is a trustworthy origin even to an HTTPS page, so this is the one address the
 * browser will let us ask.
 *
 * Probed, never required. If it is not running the webcam is still there, and a
 * missing photograph has never been allowed to stop a weighment.
 */
const RELAY = "http://127.0.0.1:9099";

/** Enough to see a number plate; more than a webcam usually gives. */
const IDEAL = { width: 1280, height: 720 };

/** Stills are held in memory, so the strip is short on purpose. */
const MAX_SHOTS = 12;

interface RelayCamera {
  name: string;
  label: string;
}

export interface Shot {
  id: string;
  at: Date;
  file: File;
  url: string;
  width: number;
  height: number;
  /** What the serial line was saying when the shutter went. */
  note: string | null;
}

/** getUserMedia's failures, in words that say what to do about them. */
function explain(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError")
    return "The browser blocked the camera. Allow it for this site — the padlock in the address bar — and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera answered. Check it is plugged in and not disabled in Windows privacy settings.";
  if (name === "NotReadableError")
    return "Windows handed the camera to another program. Close anything else using it (Teams, Camera, the old weighbridge software) and try again.";
  return e instanceof Error ? e.message : "Could not start the camera.";
}

export function WeighbridgeCamera({
  note,
  onCapture,
}: {
  /** Stamped onto each still — the newest serial frame, when there is one. */
  note?: string | null;
  onCapture?: (shot: Shot) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shotsRef = useRef<Shot[]>([]);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(
    () => localStorage.getItem(DEVICE_KEY) ?? "",
  );
  const [live, setLive] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  /** Cameras the relay offers; empty when nothing is running on this desktop. */
  const [relayCams, setRelayCams] = useState<RelayCamera[]>([]);
  const [source, setSource] = useState<string>(() => localStorage.getItem(SOURCE_KEY) ?? "webcam");
  const [ipPreview, setIpPreview] = useState<string | null>(null);
  const ipPreviewRef = useRef<string | null>(null);

  const usingRelay = source.startsWith("ip:");
  const relayName = usingRelay ? source.slice(3) : null;

  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
    setSize(null);
  }, []);

  // Hold the camera light on only while the screen is open.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url));
    },
    [],
  );

  /**
   * Labels are blank until permission is granted, so the picker is only worth
   * filling in once a stream has been running.
   */
  const listDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "videoinput"));
    } catch {
      setDevices([]);
    }
  }, []);

  const start = async (id?: string) => {
    if (!supported) return;
    setBusy(true);
    setError(null);
    stop();
    try {
      const wanted = id ?? deviceId;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: wanted
          ? { deviceId: { exact: wanted }, ...idealSize() }
          : { ...idealSize() },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {
          // Autoplay can be refused; the stream is still attached and the
          // frame paints anyway. Not worth an error banner.
        });
        setSize({ w: video.videoWidth, h: video.videoHeight });
      }
      setLive(true);
      const actual = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (actual) {
        setDeviceId(actual);
        localStorage.setItem(DEVICE_KEY, actual);
      }
      await listDevices();
    } catch (e) {
      setError(explain(e));
      stop();
    } finally {
      setBusy(false);
    }
  };

  const keep = useCallback(
    (blob: Blob, width: number, height: number) => {
      const at = new Date();
      const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, "");
      const shot: Shot = {
        id: `${at.getTime()}`,
        at,
        file: new File([blob], `weighbridge-${stamp}.jpg`, { type: "image/jpeg" }),
        url: URL.createObjectURL(blob),
        width,
        height,
        note: note ?? null,
      };
      setShots((prev) => {
        const next = [shot, ...prev];
        for (const dropped of next.slice(MAX_SHOTS)) URL.revokeObjectURL(dropped.url);
        const kept = next.slice(0, MAX_SHOTS);
        shotsRef.current = kept;
        return kept;
      });
      onCapture?.(shot);
    },
    [note, onCapture],
  );

  /* Ask the relay what it has, once. Silence is the normal answer — most
     desktops are not running one — so a failure here is never shown. */
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    fetch(`${RELAY}/cameras`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { cameras?: RelayCamera[] } | null) => {
        if (!cancelled && d?.cameras?.length) setRelayCams(d.cameras);
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, []);

  /* A still every second and a half is a preview good enough to aim by, and
     it is all a snapshot API can give — these cameras have no stream a browser
     could play. Only while an IP camera is the chosen source. */
  useEffect(() => {
    if (!relayName) {
      if (ipPreviewRef.current) URL.revokeObjectURL(ipPreviewRef.current);
      ipPreviewRef.current = null;
      setIpPreview(null);
      return;
    }
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetch(`${RELAY}/snapshot/${encodeURIComponent(relayName)}?t=${Date.now()}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        const blob = await r.blob();
        if (stopped) return;
        const url = URL.createObjectURL(blob);
        if (ipPreviewRef.current) URL.revokeObjectURL(ipPreviewRef.current);
        ipPreviewRef.current = url;
        setIpPreview(url);
        setError(null);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : "The camera did not answer");
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [relayName]);

  /** A still straight off the IP camera, at whatever it actually shoots. */
  const captureIp = async () => {
    if (!relayName) return;
    setBusy(true);
    try {
      const r = await fetch(`${RELAY}/snapshot/${encodeURIComponent(relayName)}?t=${Date.now()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const blob = await r.blob();
      const bitmap = await createImageBitmap(blob).catch(() => null);
      keep(blob, bitmap?.width ?? 0, bitmap?.height ?? 0);
      setSize(bitmap ? { w: bitmap.width, h: bitmap.height } : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not take a still");
    } finally {
      setBusy(false);
    }
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => blob && keep(blob, canvas.width, canvas.height),
      "image/jpeg",
      0.9,
    );
  };

  if (!supported) {
    return (
      <div className="card p-4 text-[13px] text-gray-500">
        This browser cannot open a camera. Chrome or Edge on the cabin desktop can.
      </div>
    );
  }

  return (
    <div className="card p-4">
      {/* Only offered when a relay is actually answering. On a desktop without
          one there is nothing to choose between, and a dropdown with a single
          entry is a question nobody asked. */}
      {relayCams.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-gray-400">Source</span>
          <select
            className="input w-auto"
            value={source}
            onChange={(e) => {
              stop();
              setError(null);
              setSource(e.target.value);
              localStorage.setItem(SOURCE_KEY, e.target.value);
            }}
          >
            <option value="webcam">USB webcam</option>
            {relayCams.map((c) => (
              <option key={c.name} value={`ip:${c.name}`}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {usingRelay ? (
          <button className="btn-primary" onClick={() => void captureIp()} disabled={busy}>
            <Camera className="h-3.5 w-3.5" />
            {busy ? "Taking…" : "Take a still"}
          </button>
        ) : !live ? (
          <button className="btn-primary" onClick={() => void start()} disabled={busy}>
            <Camera className="h-3.5 w-3.5" />
            {busy ? "Starting…" : "Start camera"}
          </button>
        ) : (
          <>
            <button className="btn-primary" onClick={capture}>
              <Camera className="h-3.5 w-3.5" />
              Take a still
            </button>
            <button className="btn-secondary" onClick={stop}>
              <CameraOff className="h-3.5 w-3.5" />
              Stop
            </button>
          </>
        )}
        {!usingRelay && devices.length > 1 && (
          <select
            className="input w-auto"
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              localStorage.setItem(DEVICE_KEY, e.target.value);
              if (live) void start(e.target.value);
            }}
          >
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        {!usingRelay && live && (
          <button className="btn-ghost" onClick={() => void start()} title="Reopen the stream">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
        {size && (
          <span
            className={`text-[12px] tabular-nums ${
              size.h >= 720 ? "text-green-600" : "text-amber-600"
            }`}
          >
            {size.w} × {size.h}
            {size.h < 720 && !usingRelay && " — below 720p; a plate may not be legible"}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg bg-gray-900">
        {usingRelay ? (
          ipPreview ? (
            <img
              src={ipPreview}
              alt=""
              className="w-full"
              onLoad={(e) =>
                setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
            />
          ) : (
            <div className="flex h-40 items-center justify-center text-[13px] text-gray-400">
              Waiting for the camera…
            </div>
          )
        ) : (
          <>
            <video
              ref={videoRef}
              className={`w-full ${live ? "" : "hidden"}`}
              playsInline
              muted
              autoPlay
              onLoadedMetadata={(e) =>
                setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
              }
            />
            {!live && (
              <div className="flex h-40 items-center justify-center text-[13px] text-gray-400">
                Camera off.
              </div>
            )}
          </>
        )}
      </div>

      {shots.length > 0 && (
        <div className="mt-3">
          <div className="label">
            {shots.length} still{shots.length === 1 ? "" : "s"} — newest first
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {shots.map((s) => (
              <div key={s.id} className="w-40 shrink-0">
                <img src={s.url} alt="" className="w-full rounded-md border border-gray-200" />
                <div className="mt-1 text-[11px] tabular-nums text-gray-500">
                  {s.at.toLocaleTimeString("en-IN")} · {Math.round(s.file.size / 1024)} KB
                </div>
                {s.note && (
                  <div className="truncate font-mono text-[11px] text-brand-700" title={s.note}>
                    {s.note}
                  </div>
                )}
                <a
                  href={s.url}
                  download={s.file.name}
                  className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
                >
                  <Download className="h-3 w-3" />
                  Save
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Asked for, not demanded — a camera that cannot do 720p should still open. */
const idealSize = () => ({
  width: { ideal: IDEAL.width },
  height: { ideal: IDEAL.height },
});
