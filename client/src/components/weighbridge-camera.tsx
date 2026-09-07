/**
 * The camera over the platform.
 *
 * A weight on its own is a number somebody typed or a number a machine sent,
 * and a month later there is no way to tell which truck it belonged to. A
 * still taken at the moment of the reading is what makes it evidence.
 *
 * A plain USB webcam through `getUserMedia`, deliberately, rather than the
 * Hikvision the old system was configured for: that camera is on the farm LAN
 * over plain HTTP, and a page served over HTTPS cannot fetch it at all — mixed
 * content, and no CORS even if it could. Reaching it would mean a relay process
 * on the cabin desktop, which is the thing this whole approach avoids.
 *
 * A capture is handed out as a `File`, not a blob URL, so it drops straight
 * into the attachment queue every other create screen already uses. There is
 * one way to attach a file in niko and this is not a second one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Download, RefreshCw } from "lucide-react";

/** The picked camera outlives the visit; a cabin has one and it does not move. */
const DEVICE_KEY = "niko.weighbridge.camera";

/** Enough to see a number plate; more than a webcam usually gives. */
const IDEAL = { width: 1280, height: 720 };

/** Stills are held in memory, so the strip is short on purpose. */
const MAX_SHOTS = 12;

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
      (blob) => {
        if (!blob) return;
        const at = new Date();
        const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, "");
        const shot: Shot = {
          id: `${at.getTime()}`,
          at,
          file: new File([blob], `weighbridge-${stamp}.jpg`, { type: "image/jpeg" }),
          url: URL.createObjectURL(blob),
          width: canvas.width,
          height: canvas.height,
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!live ? (
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
        {devices.length > 1 && (
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
        {live && (
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
            {size.h < 720 && " — below 720p; a plate may not be legible"}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg bg-gray-900">
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
