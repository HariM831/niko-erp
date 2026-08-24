/**
 * Gate — the browser kiosk. Point the camera at the worker, scan, confirm.
 *
 * Ported from Amino's gate: @vladmandic/human runs fully in the browser
 * (client/src/lib/face.ts), matching happens on-device against the gallery
 * from GET /api/payroll/employees/gallery, and the punch goes to
 * POST /api/payroll/punches. Manual selection appears only after a failed
 * scan so face recognition stays the primary flow.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Camera, CameraOff, CheckCircle2, Loader2, LogIn, LogOut,
  MapPin, MapPinOff, ScanFace, SwitchCamera, UserSearch, XCircle,
} from "lucide-react";
import { api } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DEFAULT_MATCH_THRESHOLD, MIN_MATCH_MARGIN, findBestMatch, frameToDataUrl, getFaceEmbedding, loadFaceEngine, looksSpoofed,
} from "../../lib/face";
import { Avatar, Badge, ErrorBanner, PageHeader, fmtTime, istToday, useErr } from "../../components/payroll/ui";

interface GalleryEmployee {
  id: string;
  empCode: string;
  name: string;
  payType: string;
  faceDescriptor: number[] | null;
  photoUrl: string | null;
  department?: string | null;
}
interface PunchRow {
  id: string;
  employeeId: string;
  type: "in" | "out";
  punchedAt: string;
  punchDate: string;
  method: string;
  latitude: number | null;
  employeeName?: string;
  empCode?: string;
}
interface Position { latitude: number; longitude: number; accuracy: number }

type Stage =
  | { kind: "idle" }
  | { kind: "matching" }
  | { kind: "confirm"; employee: GalleryEmployee; score: number; photo: string }
  | { kind: "nomatch"; score: number; closest: GalleryEmployee | null; photo: string | null; spoofed?: boolean }
  | { kind: "posting" }
  | { kind: "success"; employee: GalleryEmployee; punchType: "in" | "out"; time: string };

function cameraErrorMessage(err: any): string {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera permission was blocked. Tap the lock icon in the address bar, allow the camera, then reload.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No camera found on this device.";
  if (name === "NotReadableError" || name === "TrackStartError") return "Another app is using the camera. Close it and try again.";
  if (name === "OverconstrainedError") return "This device doesn't have the requested camera. Tap the switch-camera button.";
  if (name === "AbortError") return "Camera was interrupted. Tap Start camera again.";
  return `Camera failed to start${err?.message ? `: ${err.message}` : ""}.`;
}

function getPositionOnce(options: PositionOptions): Promise<Position | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      options,
    );
  });
}
// GPS cold-start routinely outlives a short timeout; give the precise fix
// real time to lock, then fall back to a fast network-based one.
async function getPosition(): Promise<Position | null> {
  const precise = await getPositionOnce({ enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  if (precise) return precise;
  return getPositionOnce({ enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 });
}

export function PayrollGatePage() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [engineState, setEngineState] = useState<"loading" | "ready" | "failed">("loading");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("environment");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [position, setPosition] = useState<Position | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSearch, setManualSearch] = useState("");
  // Picking a name moves to a photo step instead of punching immediately, so
  // the punch photo is aimed at the worker, not the floor.
  const [manualSelected, setManualSelected] = useState<{ employee: GalleryEmployee; punchType: "in" | "out" } | null>(null);
  const [manualCapture, setManualCapture] = useState<{ photo: string } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const threshold = DEFAULT_MATCH_THRESHOLD;

  const { data: gallery = [], isLoading: galleryLoading } = useQuery({
    queryKey: ["payroll", "gallery"],
    queryFn: () => api<GalleryEmployee[]>("/api/payroll/employees/gallery"),
    staleTime: 5 * 60_000,
  });
  const today = istToday();
  const { data: punchData } = useQuery({
    queryKey: ["payroll", "punches-today", today],
    queryFn: () => api<{ rows: PunchRow[]; total: number }>(`/api/payroll/punches?date=${today}&limit=200&offset=0`),
    refetchInterval: 60_000,
  });
  const punches = punchData?.rows ?? [];

  const enrolled = useMemo(() => gallery.filter((e) => Array.isArray(e.faceDescriptor) && e.faceDescriptor.length > 0), [gallery]);
  const empById = useMemo(() => new Map(gallery.map((e) => [e.id, e])), [gallery]);

  useEffect(() => {
    let cancelled = false;
    loadFaceEngine()
      .then(() => !cancelled && setEngineState("ready"))
      .catch(() => !cancelled && setEngineState("failed"));
    getPosition().then((p) => !cancelled && p && setPosition(p));
    let watchId: number | null = null;
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (p) => !cancelled && setPosition({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => {},
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
      );
    }
    return () => {
      cancelled = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  // Camera lifecycle
  useEffect(() => {
    let cancelled = false;
    function stopStream() {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
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

  const suggestedType = (employeeId: string): "in" | "out" => {
    const todays = punches
      .filter((p) => p.employeeId === employeeId)
      .sort((a, b) => new Date(b.punchedAt).getTime() - new Date(a.punchedAt).getTime());
    return todays[0]?.type === "in" ? "out" : "in";
  };

  async function handleCapture() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) { setErr("Camera not ready."); return; }
    if (enrolled.length === 0) { setErr("No enrolled faces — enrol employees on the Face enrolment page first."); return; }
    setErr(null);
    setStage({ kind: "matching" });
    getPosition().then((p) => p && setPosition(p));
    try {
      const photo = frameToDataUrl(video);
      const face = await getFaceEmbedding(video);
      if (!face.ok || !face.embedding) {
        setStage({ kind: "nomatch", score: 0, closest: null, photo });
        return;
      }
      // Anti-spoofing: a printed photo or a phone screen is rejected outright.
      if (looksSpoofed(face)) {
        setStage({ kind: "nomatch", score: 0, closest: null, photo, spoofed: true });
        return;
      }
      const match = findBestMatch(
        face.embedding,
        enrolled.map((e) => ({ id: e.id, descriptors: [e.faceDescriptor!] })),
      );
      const employee = match.id ? empById.get(match.id) ?? null : null;
      // Auto-accept needs BOTH the absolute score over the threshold AND a
      // clear margin over the runner-up — 0.66 vs 0.64 goes to manual.
      const decisiveMargin = match.score - match.secondScore >= MIN_MATCH_MARGIN;
      if (employee && match.score >= threshold && decisiveMargin) {
        if (navigator.vibrate) navigator.vibrate(50);
        setStage({ kind: "confirm", employee, score: match.score, photo });
      } else {
        setStage({ kind: "nomatch", score: match.score, closest: employee, photo });
      }
    } catch (e) {
      setStage({ kind: "idle" });
      fail(e);
    }
  }

  async function submitPunch(employee: GalleryEmployee, punchType: "in" | "out", method: "face" | "manual", score: number | null, photo: string | null) {
    setStage({ kind: "posting" });
    try {
      const pos = position ?? (await getPosition());
      if (pos) setPosition(pos);
      await api("/api/payroll/punches", {
        method: "POST",
        body: {
          employeeId: employee.id,
          type: punchType,
          method,
          matchScore: score,
          latitude: pos?.latitude ?? null,
          longitude: pos?.longitude ?? null,
          accuracyM: pos?.accuracy ?? null,
          photoUrl: photo,
        },
      });
      qc.invalidateQueries({ queryKey: ["payroll", "punches-today"] });
      qc.invalidateQueries({ queryKey: ["payroll", "attendance-today"] });
      if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
      setStage({ kind: "success", employee, punchType, time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) });
      setTimeout(() => setStage((s) => (s.kind === "success" ? { kind: "idle" } : s)), 2500);
    } catch (e) {
      setStage({ kind: "idle" });
      fail(e);
    }
  }

  async function captureManualPhoto() {
    const video = videoRef.current;
    if (!cameraOn || !video || video.videoWidth === 0) { setErr("Start the camera first, then capture the worker's face."); return; }
    setCapturing(true);
    try {
      const photo = frameToDataUrl(video);
      const face = await getFaceEmbedding(video);
      if (!face.ok) { setManualCapture(null); setErr("No face detected — face the camera in good light and capture again."); return; }
      if (looksSpoofed(face)) { setManualCapture(null); setErr("That looks like a photo or a screen, not a live face."); return; }
      setManualCapture({ photo });
      setErr(null);
      if (navigator.vibrate) navigator.vibrate(50);
    } catch (e) {
      setManualCapture(null);
      fail(e);
    } finally {
      setCapturing(false);
    }
  }

  const manualFiltered = useMemo(() => {
    const q = manualSearch.trim().toLowerCase();
    const list = q ? gallery.filter((e) => e.name.toLowerCase().includes(q) || e.empCode.toLowerCase().includes(q)) : gallery;
    return list.slice(0, 30);
  }, [gallery, manualSearch]);

  const busy = stage.kind === "matching" || stage.kind === "posting";

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <PageHeader title="Gate" sub="Point the camera at the worker and tap Scan.">
        {position
          ? <Badge tone="green"><MapPin size={11} className="mr-1" /> Location on</Badge>
          : <Badge tone="amber"><MapPinOff size={11} className="mr-1" /> No location</Badge>}
        <Badge tone="gray">{enrolled.length}/{gallery.length} enrolled</Badge>
      </PageHeader>
      <ErrorBanner message={err} onClose={() => setErr(null)} />

      {engineState === "loading" && (
        <div className="card flex items-center gap-2 p-3 text-sm text-gray-500">
          <Loader2 size={15} className="animate-spin" /> Loading face engine (first time ~8 MB, then cached)…
        </div>
      )}
      {engineState === "failed" && (
        <div className="card flex items-center gap-2 p-3 text-sm text-red-600">
          <AlertTriangle size={15} /> Face engine failed to load. Check internet and reload the page.
        </div>
      )}

      {/* Camera */}
      <div className="card overflow-hidden">
        <div className="relative flex aspect-[4/3] items-center justify-center bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            className={`absolute inset-0 h-full w-full object-cover ${cameraOn ? "" : "hidden"} ${facingMode === "user" ? "scale-x-[-1]" : ""}`}
          />
          {!cameraOn && (
            <div className="p-6 text-center text-sm text-white/70">{cameraError ?? "Camera is off"}</div>
          )}

          {stage.kind === "matching" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white">
              <Loader2 size={32} className="animate-spin" />
              <span className="text-sm">Recognising…</span>
            </div>
          )}

          {stage.kind === "confirm" && (() => {
            const next = suggestedType(stage.employee.id);
            return (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-white">
                {stage.employee.photoUrl && <img src={stage.employee.photoUrl} alt="" className="h-20 w-20 rounded-full border-2 border-emerald-400 object-cover" />}
                <div className="text-center">
                  <div className="text-lg font-bold">{stage.employee.name}</div>
                  <div className="text-sm text-white/70">{stage.employee.empCode}</div>
                  <div className="mt-1 text-xs text-white/50">Match {(stage.score * 100).toFixed(0)}%</div>
                </div>
                {/* One action only — the next logical punch */}
                <button
                  className={`inline-flex items-center gap-2 rounded-lg px-10 py-3 text-[15px] font-semibold text-white ${next === "in" ? "bg-emerald-600" : "bg-sky-600"}`}
                  onClick={() => void submitPunch(stage.employee, next, "face", stage.score, stage.photo)}
                >
                  {next === "in" ? <><LogIn size={18} /> Punch IN</> : <><LogOut size={18} /> Punch OUT</>}
                </button>
                <button className="inline-flex items-center gap-1 text-sm text-white/70" onClick={() => setStage({ kind: "idle" })}>
                  <XCircle size={14} /> Not this person
                </button>
              </div>
            );
          })()}

          {stage.kind === "nomatch" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-white">
              <AlertTriangle size={30} className="text-amber-400" />
              <div className="text-center">
                <div className="font-bold">
                  {stage.spoofed ? "Photo or screen detected" : stage.closest || stage.score > 0 ? "No confident match" : "No face detected"}
                </div>
                {stage.spoofed ? (
                  <div className="mt-1 text-sm text-white/70">This looks like a photo, not a live person. The worker must be at the gate.</div>
                ) : stage.closest ? (
                  <div className="mt-1 text-sm text-white/70">
                    Closest: {stage.closest.name} ({(stage.score * 100).toFixed(0)}% — below the {(threshold * 100).toFixed(0)}% cutoff)
                  </div>
                ) : (
                  <div className="mt-1 text-sm text-white/70">Ask the worker to face the camera in good light, then try again.</div>
                )}
              </div>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => setStage({ kind: "idle" })}>Try again</button>
                {/* Manual selection is the fallback after a failed scan only */}
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/40 px-3 py-1.5 text-[13px] text-white"
                  onClick={() => { setStage({ kind: "idle" }); setManualCapture(null); setManualSearch(""); setManualOpen(true); }}
                >
                  <UserSearch size={14} /> Select manually
                </button>
              </div>
            </div>
          )}

          {stage.kind === "success" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-emerald-600/95 text-white">
              <CheckCircle2 size={56} />
              <div className="text-xl font-bold">{stage.employee.name}</div>
              <div className="text-sm">Punched {stage.punchType.toUpperCase()} at {stage.time}</div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 p-3">
          {!cameraOn ? (
            <button className="btn-primary !h-10 !px-5" onClick={() => setCameraOn(true)}>
              <Camera size={16} /> Start camera
            </button>
          ) : (
            <>
              <button className="btn-primary !h-10 !px-5" onClick={() => void handleCapture()} disabled={busy || engineState !== "ready" || galleryLoading}>
                {stage.kind === "matching" ? <Loader2 size={16} className="animate-spin" /> : <ScanFace size={16} />} Scan face
              </button>
              <button className="btn-secondary !h-10" onClick={() => setFacingMode((m) => (m === "user" ? "environment" : "user"))} disabled={busy} title="Switch camera">
                <SwitchCamera size={16} />
              </button>
              <button className="btn-secondary !h-10" onClick={() => setCameraOn(false)} disabled={busy} title="Stop camera">
                <CameraOff size={16} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Today's punches */}
      <div className="card p-4">
        <h2 className="mb-3 text-[14px] font-semibold">Today's punches ({punches.length})</h2>
        {punches.length === 0 ? (
          <p className="text-sm text-gray-400">No punches yet today.</p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {punches.map((p) => {
              const emp = empById.get(p.employeeId);
              return (
                <div key={p.id} className="flex items-center gap-3 border-b border-gray-100 pb-2 text-sm last:border-0 last:pb-0">
                  <Avatar src={emp?.photoUrl} name={p.employeeName ?? emp?.name ?? "?"} size="sm" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{p.employeeName ?? emp?.name ?? p.empCode}</span>
                    <span className="text-gray-400"> · {fmtTime(p.punchedAt)}</span>
                  </div>
                  <Badge tone={p.type === "in" ? "green" : "gray"}>{p.type.toUpperCase()}</Badge>
                  {p.method === "manual" && <Badge tone="amber">manual</Badge>}
                  {p.latitude == null && <MapPinOff size={13} className="text-amber-500" />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Manual selection */}
      <Dialog open={manualOpen} onOpenChange={(o) => { setManualOpen(o); if (!o) { setManualSelected(null); setManualCapture(null); setManualSearch(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Manual punch</DialogTitle></DialogHeader>
          {!manualSelected ? (
            <>
              <input className="input" placeholder="Search name or code…" value={manualSearch} onChange={(e) => setManualSearch(e.target.value)} autoFocus />
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {manualFiltered.map((emp) => {
                  const next = suggestedType(emp.id);
                  return (
                    <div key={emp.id} className="flex items-center gap-2 rounded p-2 hover:bg-gray-50">
                      <Avatar src={emp.photoUrl} name={emp.name} size="sm" />
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="truncate font-medium">{emp.name}</div>
                        <div className="text-xs text-gray-400">{emp.empCode}</div>
                      </div>
                      <button
                        className={`btn-secondary ${next === "in" ? "!text-emerald-700" : "!text-sky-700"}`}
                        onClick={() => { setManualSelected({ employee: emp, punchType: next }); setManualCapture(null); }}
                      >
                        {next === "in" ? <><LogIn size={13} /> In</> : <><LogOut size={13} /> Out</>}
                      </button>
                    </div>
                  );
                })}
                {manualFiltered.length === 0 && <p className="p-2 text-sm text-gray-400">No employees found</p>}
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <button type="button" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800" onClick={() => { setManualSelected(null); setManualCapture(null); }}>
                <ArrowLeft size={13} /> Change worker
              </button>
              <div className="flex items-center gap-2">
                <Avatar src={manualSelected.employee.photoUrl} name={manualSelected.employee.name} />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="truncate font-medium">{manualSelected.employee.name}</div>
                  <div className="text-xs text-gray-400">{manualSelected.employee.empCode}</div>
                </div>
                <Badge tone={manualSelected.punchType === "in" ? "green" : "blue"}>{manualSelected.punchType.toUpperCase()}</Badge>
              </div>

              {/* Punch photo — the guard sees and can retake the frame before it's saved */}
              <div className="space-y-2 rounded-md bg-gray-50 p-2">
                {manualCapture ? (
                  <img src={manualCapture.photo} alt="Captured punch" className="max-h-48 w-full rounded-md object-cover" />
                ) : (
                  <div className="flex h-32 items-center justify-center rounded-md bg-gray-100 text-xs text-gray-400">
                    {cameraOn ? "No photo yet" : "Camera is off"}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button className="btn-secondary flex-1" onClick={() => void captureManualPhoto()} disabled={capturing || !cameraOn || engineState !== "ready"}>
                    {capturing ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
                    {manualCapture ? "Retake photo" : "Take photo"}
                  </button>
                  {manualCapture && (
                    <button className="btn-ghost" onClick={() => setManualCapture(null)} title="Discard photo"><XCircle size={14} /></button>
                  )}
                </div>
                <p className="text-xs text-gray-400">
                  {!cameraOn
                    ? "Start the camera to take a punch photo, or confirm without one."
                    : manualCapture
                      ? "Check the framing — retake if it isn't the worker's face."
                      : "Point the camera at the worker's face, then take the photo."}
                </p>
              </div>

              <button
                className="btn-primary w-full !h-10"
                disabled={stage.kind === "posting"}
                onClick={() => {
                  const { employee, punchType } = manualSelected;
                  const cap = manualCapture;
                  setManualOpen(false);
                  setManualSelected(null);
                  void submitPunch(employee, punchType, "manual", null, cap?.photo ?? null);
                }}
              >
                Confirm {manualSelected.punchType === "in" ? "In" : "Out"}
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
