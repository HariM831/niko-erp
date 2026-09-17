/**
 * A camera and the face engine, for a page that recognises people.
 *
 * Lifted from the attendance gate so the Canteen Gate starts a camera the same
 * way and fails the same way: the same retry without a facing constraint for
 * devices with one camera, the same words when the browser refuses. The
 * attendance gate still carries its own copy of this; it is the older page and
 * is left as it was until it can be tested against a real camera.
 */
import { useEffect, useRef, useState } from "react";
import { loadFaceEngine } from "./face";

export function cameraErrorMessage(err: any): string {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera permission was blocked. Tap the lock icon in the address bar, allow the camera, then reload.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No camera found on this device.";
  if (name === "NotReadableError" || name === "TrackStartError") return "Another app is using the camera. Close it and try again.";
  if (name === "OverconstrainedError") return "This device doesn't have the requested camera. Tap the switch-camera button.";
  if (name === "AbortError") return "Camera was interrupted. Tap Start camera again.";
  return `Camera failed to start${err?.message ? `: ${err.message}` : ""}.`;
}

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [engineState, setEngineState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    loadFaceEngine()
      .then(() => !cancelled && setEngineState("ready"))
      .catch(() => !cancelled && setEngineState("failed"));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const stopStream = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    async function start() {
      stopStream();
      setCameraError(null);
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) {
          setCameraError(
            location.protocol !== "https:" && location.hostname !== "localhost"
              ? "Camera needs a secure (https) URL."
              : "This browser doesn't support camera access. Open in Chrome or Safari.",
          );
          setCameraOn(false);
        }
        return;
      }
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e: any) {
        // Retry without a facing constraint — some devices expose only one camera.
        if (e?.name === "OverconstrainedError" || e?.name === "NotFoundError") {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
          } catch (retryErr) { e = retryErr; }
        }
        if (!stream) {
          if (!cancelled) { setCameraError(cameraErrorMessage(e)); setCameraOn(false); }
          return;
        }
      }
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); }
        catch { if (!cancelled) setCameraError("Tap the video area to start the preview."); }
      }
    }
    if (cameraOn) void start(); else stopStream();
    return () => { cancelled = true; stopStream(); };
  }, [cameraOn, facingMode]);

  return { videoRef, cameraOn, setCameraOn, cameraError, facingMode, setFacingMode, engineState };
}
