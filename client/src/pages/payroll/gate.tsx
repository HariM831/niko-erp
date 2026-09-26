/**
 * Gate — the browser kiosk. Point the camera at the worker, scan, confirm.
 *
 * Ported from Amino's gate: @vladmandic/human runs fully in the browser
 * (client/src/lib/face.ts), matching happens on-device against the gallery
 * from GET /api/payroll/employees/gallery, and the punch goes to
 * POST /api/payroll/punches. Manual selection appears only after a failed
 * scan so face recognition stays the primary flow.
 */
import { loadRoster, saveRoster } from "../../lib/roster-cache";
import { buildMatchIndex, findBestMatchIndexed } from "@shared/face-match";
import { centredOf, useCentredIndex } from "../../lib/face-model";
import { useAppOutdated } from "../../lib/app-version";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Camera, CameraOff, CheckCircle2, Loader2, LogIn, LogOut,
  MapPin, MapPinOff, ScanFace, SwitchCamera, UserSearch, XCircle,
} from "lucide-react";
import { ApiError, api } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DEFAULT_MATCH_THRESHOLD, MIN_MATCH_MARGIN, frameToDataUrl, getFaceEmbedding, loadFaceEngine, looksSpoofed,
} from "../../lib/face";
import { Avatar, Badge, ErrorBanner, PageHeader, fmtTime, istToday, useErr } from "../../components/payroll/ui";

interface GalleryEmployee {
  id: string;
  empCode: string;
  name: string;
  payType: string;
  /**
   * The enrolment descriptor first, then whatever the gate has taught itself
   * from this worker's own scans. A face is scored on its best one, so a
   * short gallery is only ever a weaker match, never a wrong one.
   */
  descriptors: number[][];
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
  name?: string;
  empCode?: string;
  /** Yesterday's entry on a night shift still in progress. */
  carryover?: boolean;
}
interface Position { latitude: number; longitude: number; accuracy: number }
/** Everybody active, faces or not — what the name list draws on. */
interface NameRow { id: string; empCode: string; name: string; payType: string; hasFace: boolean }
type ManualReason = "no_match" | "engine_failed" | "camera_blocked" | "not_enrolled";

type Stage =
  | { kind: "idle" }
  | { kind: "matching" }
  | { kind: "confirm"; employee: GalleryEmployee; score: number; photo: string; embedding: number[] }
  | {
      kind: "nomatch";
      score: number;
      closest: GalleryEmployee | null;
      photo: string | null;
      spoofed?: boolean;
      /** The runner-up's score and name, when it was the margin that failed rather than the cutoff. */
      runnerUp?: { name: string; score: number } | null;
    }
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
  /**
   * The calm half of `err`. A re-scan inside the cooldown is not a failure to
   * put right — the punch it repeats is already on the board — so it must not
   * arrive as a red banner the guard tries to act on.
   */
  const [notice, setNotice] = useState<string | null>(null);
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
  const [manualCapture, setManualCapture] = useState<{ photo: string; embedding: number[] | null } | null>(null);
  const [capturing, setCapturing] = useState(false);
  // Why the name list is open at all, sent with the punch: a refused camera is
  // not a face failing to match, and the failure report should not count it so.
  const [manualReason, setManualReason] = useState<ManualReason>("no_match");
  // The server's refusal of a face that is clearly somebody else's. Stays up,
  // inside the dialog, until the guard picks again or gives up the capture.
  const [manualError, setManualError] = useState<string | null>(null);
  const threshold = DEFAULT_MATCH_THRESHOLD;

  /**
   * The roster, accumulated rather than re-downloaded.
   *
   * Each worker now carries several descriptors, so a full roster is several
   * megabytes and it was being re-fetched every five minutes for the sake of
   * the handful of rows that had actually changed. The server answers from a
   * cursor: send what changed since, and name whoever has gone. A reload
   * picks up from the copy this browser kept (lib/roster-cache.ts), so it too
   * is a delta; the copy is dropped after a day, which is the one time a full
   * roster is fetched again.
   */
  const roster = useRef({ cursor: 0, byId: new Map<string, GalleryEmployee>(), savedAt: 0, seeded: false });
  const { data: gallery = [], isLoading: galleryLoading } = useQuery({
    queryKey: ["payroll", "gallery"],
    queryFn: async () => {
      const r = roster.current;
      if (!r.seeded) {
        r.seeded = true;
        const kept = await loadRoster<GalleryEmployee>("attendance");
        if (kept) {
          r.cursor = kept.cursor;
          r.savedAt = kept.savedAt;
          r.byId = new Map(kept.people.map((p) => [p.id, p]));
        }
      }
      const page = await api<{ cursor: number; people: GalleryEmployee[]; deleted: string[] }>(
        `/api/payroll/employees/gallery?since=${r.cursor}`,
      );
      for (const id of page.deleted) r.byId.delete(id);
      for (const p of page.people) r.byId.set(p.id, p);
      r.cursor = page.cursor;
      const people = [...r.byId.values()];
      // The age runs from the last FULL fetch, not the last delta — otherwise a
      // gate left open would renew its own copy for ever and never refresh.
      if (!r.savedAt) r.savedAt = Date.now();
      void saveRoster("attendance", r.cursor, people, r.savedAt);
      return people;
    },
    staleTime: 5 * 60_000,
  });
  const today = istToday();
  const { data: punchData } = useQuery({
    queryKey: ["payroll", "punches-today", today],
    queryFn: () => api<{ rows: PunchRow[]; total: number }>(`/api/payroll/punches?date=${today}&limit=200&offset=0`),
    refetchInterval: 60_000,
  });
  // People who came in last night and have not left. Their next punch is an
  // OUT that belongs to yesterday, so the board has to know about them even
  // though they have punched nothing today.
  const { data: carried = [] } = useQuery({
    queryKey: ["payroll", "punches-today", today, "carried"],
    queryFn: () => api<PunchRow[]>("/api/payroll/punches/carried"),
    refetchInterval: 60_000,
  });
  // Each person's latest punch today, one row each. The list above is the
  // newest 200 for the board; deciding IN or OUT from it lost the morning's
  // arrivals once the day passed 200 punches, and offered them IN again.
  const { data: latestToday = [] } = useQuery({
    queryKey: ["payroll", "punches-today", today, "latest"],
    queryFn: () => api<Array<{ employeeId: string; type: "in" | "out"; punchedAt: string }>>(`/api/payroll/punches/latest?date=${today}`),
    refetchInterval: 60_000,
  });
  const todays = punchData?.rows ?? [];
  const punches = useMemo(
    () => [...todays, ...carried.filter((c) => !todays.some((p) => p.employeeId === c.employeeId))],
    [todays, carried],
  );

  const enrolled = useMemo(() => gallery.filter((e) => e.descriptors?.length > 0), [gallery]);
  const empById = useMemo(() => new Map(gallery.map((e) => [e.id, e])), [gallery]);
  // Every roster vector scaled to unit length once per roster change, not once
  // per scan: a score is then a dot product. See shared/face-match.ts.
  const candidates = useMemo(() => enrolled.map((e) => ({ id: e.id, descriptors: e.descriptors })), [enrolled]);
  const matchIndex = useMemo(() => buildMatchIndex(candidates), [candidates]);
  // Centred matching, scored beside the raw match and recorded with the
  // punch; it decides nothing yet (lib/face-model.ts).
  const centred = useCentredIndex(candidates);

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

  const latestById = useMemo(() => new Map(latestToday.map((p) => [p.employeeId, p.type])), [latestToday]);
  // A new build went out: reload while nobody is mid-punch, so the gate never
  // runs last deploy's code all day (lib/app-version.ts).
  const outdated = useAppOutdated();
  useEffect(() => {
    if (outdated && stage.kind === "idle" && !manualOpen) window.location.reload();
  }, [outdated, stage.kind, manualOpen]);

  const suggestedType = (employeeId: string): "in" | "out" => {
    const last = latestById.get(employeeId);
    if (last) return last === "in" ? "out" : "in";
    // Nothing today: still inside from last night means the next punch is OUT.
    return carried.some((c) => c.employeeId === employeeId) ? "out" : "in";
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
      const match = findBestMatchIndexed(face.embedding, matchIndex);
      const employee = match.id ? empById.get(match.id) ?? null : null;
      // Auto-accept needs BOTH the absolute score over the threshold AND a
      // clear margin over the runner-up — 0.66 vs 0.64 goes to manual.
      const decisiveMargin = match.score - match.secondScore >= MIN_MATCH_MARGIN;
      if (employee && match.score >= threshold && decisiveMargin) {
        if (navigator.vibrate) navigator.vibrate(50);
        setStage({ kind: "confirm", employee, score: match.score, photo, embedding: face.embedding });
      } else {
        // Two different refusals, and the guard must be able to tell them
        // apart: the face resembled nobody enough (under the cutoff), or it
        // resembled two people almost equally (the margin). Saying "below the
        // cutoff" for a 73% match, as this did, reads as a broken gate.
        const second = match.secondId ? empById.get(match.secondId) ?? null : null;
        setStage({
          kind: "nomatch",
          score: match.score,
          closest: employee,
          photo,
          runnerUp:
            employee && match.score >= threshold && second
              ? { name: second.name, score: match.secondScore }
              : null,
        });
      }
    } catch (e) {
      setStage({ kind: "idle" });
      fail(e);
    }
  }

  /**
   * `embedding` is the vector of the face actually scanned, and it is what
   * teaches this worker's gallery. A hand-picked name teaches too — the
   * workers who need teaching are exactly the ones who never auto-match, so
   * auto-only teaching never reaches them — but only when a face was really
   * captured. Picking a name off the list with the camera off teaches nothing,
   * because there is nothing to teach from.
   */
  async function submitPunch(
    employee: GalleryEmployee,
    punchType: "in" | "out",
    method: "face" | "manual",
    score: number | null,
    photo: string | null,
    embedding: number[] | null,
    reason: ManualReason | null = null,
  ) {
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
          faceEmbedding: embedding,
          manualReason: method === "manual" ? reason : null,
          centred: centredOf(embedding, centred),
        },
      });
      qc.invalidateQueries({ queryKey: ["payroll", "punches-today"] });
      qc.invalidateQueries({ queryKey: ["payroll", "attendance-today"] });
      if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
      setStage({ kind: "success", employee, punchType, time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) });
      setTimeout(() => setStage((s) => (s.kind === "success" ? { kind: "idle" } : s)), 2500);
    } catch (e) {
      setStage({ kind: "idle" });
      // 409 + repeatPunch: the server refused a scan that repeats one already
      // recorded. Refresh the board so the guard sees the punch that stands.
      // 409 + faceConflict: the face beside the picked name is clearly somebody
      // else's. Nothing was saved. Back to the photo step with everything as it
      // was, so the guard can pick the right person or punch without teaching.
      if (e instanceof ApiError && e.status === 409 && e.data?.faceConflict === true && method === "manual") {
        setManualSelected({ employee, punchType });
        setManualCapture(photo ? { photo, embedding } : null);
        setManualError(e.message);
        setManualOpen(true);
        return;
      }
      // Also 409 + expected: the punch has to go the other way — still inside
      // from last night, or already IN today. Said calmly — nothing went wrong,
      // the board was stale.
      if (e instanceof ApiError && e.status === 409 && (e.data?.repeatPunch === true || e.data?.expected === "out" || e.data?.expected === "in")) {
        setNotice(e.message);
        qc.invalidateQueries({ queryKey: ["payroll", "punches-today"] });
        setTimeout(() => setNotice(null), 4000);
        return;
      }
      fail(e);
    }
  }

  async function captureManualPhoto() {
    const video = videoRef.current;
    if (!cameraOn || !video || video.videoWidth === 0) { setErr("Start the camera first, then capture the worker's face."); return; }
    setCapturing(true);
    try {
      const photo = frameToDataUrl(video);
      // With the face engine down there is nothing to check the frame with and
      // nothing to learn from it. The picture is still worth keeping: it is the
      // only record of who stood at the gate when a name was picked by hand.
      if (engineState !== "ready") {
        setManualCapture({ photo, embedding: null });
        setErr(null);
        return;
      }
      const face = await getFaceEmbedding(video);
      if (!face.ok) { setManualCapture(null); setErr("No face detected — face the camera in good light and capture again."); return; }
      if (looksSpoofed(face)) { setManualCapture(null); setErr("That looks like a photo or a screen, not a live face."); return; }
      setManualCapture({ photo, embedding: face.embedding ?? null });
      setErr(null);
      if (navigator.vibrate) navigator.vibrate(50);
    } catch (e) {
      setManualCapture(null);
      fail(e);
    } finally {
      setCapturing(false);
    }
  }

  // Everybody, fetched only when the list is actually opened. The gallery
  // holds just the people a camera can match; a new joiner not yet enrolled is
  // not in it, and used to be impossible to punch at the gate at all.
  const namesQ = useQuery({
    queryKey: ["payroll", "employee-names"],
    queryFn: () => api<NameRow[]>("/api/payroll/employees/names"),
    enabled: manualOpen,
    staleTime: 5 * 60_000,
  });
  const notEnrolled = useMemo<GalleryEmployee[]>(
    () =>
      (namesQ.data ?? [])
        .filter((n) => !empById.has(n.id))
        .map((n) => ({ id: n.id, empCode: n.empCode, name: n.name, payType: n.payType, descriptors: [], photoUrl: null })),
    [namesQ.data, empById],
  );
  const manualLists = useMemo(() => {
    const q = manualSearch.trim().toLowerCase();
    const hit = (e: GalleryEmployee) => !q || e.name.toLowerCase().includes(q) || e.empCode.toLowerCase().includes(q);
    const known = gallery.filter(hit);
    return { enrolled: known.slice(0, 30), others: notEnrolled.filter(hit).slice(0, Math.max(0, 30 - known.length)) };
  }, [gallery, notEnrolled, manualSearch]);

  const busy = stage.kind === "matching" || stage.kind === "posting";

  /**
   * The name list is the fallback after a failed scan, and stays that way
   * while a scan is possible — picking a name must never be the quick way
   * through the gate. But a camera the browser refuses, or a face engine that
   * never loaded, means there is no scan to fail, and until now that meant
   * nobody could be recorded at all.
   */
  const nobodyEnrolled = !galleryLoading && enrolled.length === 0;
  const scanImpossible = engineState === "failed" || cameraError !== null || nobodyEnrolled;
  const openManual = (reason: ManualReason) => {
    setStage({ kind: "idle" }); setManualCapture(null); setManualSearch(""); setManualError(null);
    setManualReason(reason); setManualOpen(true);
  };
  const whyNoScan: ManualReason = engineState === "failed" ? "engine_failed" : cameraError !== null ? "camera_blocked" : "not_enrolled";

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <PageHeader title="Gate" sub="Point the camera at the worker and tap Scan.">
        {position
          ? <Badge tone="green"><MapPin size={11} className="mr-1" /> Location on</Badge>
          : <Badge tone="amber"><MapPinOff size={11} className="mr-1" /> No location</Badge>}
        <Badge tone="gray">{enrolled.length}/{gallery.length} enrolled</Badge>
      </PageHeader>
      <ErrorBanner message={err} onClose={() => setErr(null)} />
      {notice && (
        <div className="mb-3 rounded-md bg-yolk-50 px-3 py-2 text-[13px] text-soil-700">{notice}</div>
      )}

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
      {scanImpossible && (
        <div className="card flex flex-wrap items-center gap-2 p-3 text-sm text-amber-800">
          <AlertTriangle size={15} />
          <span className="flex-1">Faces cannot be scanned right now. Attendance can still be recorded by name.</span>
          <button className="btn-primary" onClick={() => openManual(whyNoScan)} disabled={galleryLoading}>
            <UserSearch size={14} /> Record by name
          </button>
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
                  className={`inline-flex items-center gap-2 rounded-lg px-10 py-3 text-[15px] font-semibold text-white ${next === "in" ? "bg-emerald-600" : "bg-brand-600"}`}
                  onClick={() => void submitPunch(stage.employee, next, "face", stage.score, stage.photo, stage.embedding)}
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
                ) : stage.runnerUp ? (
                  <div className="mt-1 text-sm text-white/70">
                    {stage.closest!.name} {(stage.score * 100).toFixed(0)}% and {stage.runnerUp.name}{" "}
                    {(stage.runnerUp.score * 100).toFixed(0)}% — too alike to choose between. Pick the worker by name.
                  </div>
                ) : stage.closest ? (
                  <div className="mt-1 text-sm text-white/70">
                    Closest: {stage.closest.name} ({(stage.score * 100).toFixed(0)}% — under the {(threshold * 100).toFixed(0)}% cutoff)
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
                  onClick={() => openManual("no_match")}
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
        <h2 className="mb-3 text-[14px] font-semibold">Today's punches ({punchData?.total ?? todays.length})</h2>
        {punches.length === 0 ? (
          <p className="text-sm text-gray-400">No punches yet today.</p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {punches.map((p) => {
              const emp = empById.get(p.employeeId);
              return (
                <div key={p.id} className="flex items-center gap-3 border-b border-gray-100 pb-2 text-sm last:border-0 last:pb-0">
                  <Avatar src={emp?.photoUrl} name={p.name ?? emp?.name ?? "?"} size="sm" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{p.name ?? emp?.name ?? p.empCode}</span>
                    <span className="text-gray-400"> · {p.carryover ? "yesterday " : ""}{fmtTime(p.punchedAt)}</span>
                  </div>
                  {p.carryover && <Badge tone="blue">night shift</Badge>}
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
      <Dialog open={manualOpen} onOpenChange={(o) => { setManualOpen(o); if (!o) { setManualSelected(null); setManualCapture(null); setManualSearch(""); setManualError(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Manual punch</DialogTitle></DialogHeader>
          {!manualSelected ? (
            <>
              <input className="input" placeholder="Search name or code…" value={manualSearch} onChange={(e) => setManualSearch(e.target.value)} autoFocus />
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {[...manualLists.enrolled, ...manualLists.others].map((emp, i) => {
                  const next = suggestedType(emp.id);
                  const firstOther = i === manualLists.enrolled.length;
                  return (
                    <Fragment key={emp.id}>
                    {firstOther && (
                      <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase text-gray-400">Not enrolled — no face on file</div>
                    )}
                    <div className="flex items-center gap-2 rounded p-2 hover:bg-gray-50">
                      <Avatar src={emp.photoUrl} name={emp.name} size="sm" />
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="truncate font-medium">{emp.name}</div>
                        <div className="text-xs text-gray-400">{emp.empCode}</div>
                      </div>
                      <button
                        className={`btn-secondary ${next === "in" ? "!text-emerald-700" : "!text-brand-700"}`}
                        onClick={() => {
                          setManualSelected({ employee: emp, punchType: next }); setManualCapture(null); setManualError(null);
                          // Someone with no face on file could never have matched, whatever brought the list up.
                          if (firstOther || i > manualLists.enrolled.length) setManualReason("not_enrolled");
                        }}
                      >
                        {next === "in" ? <><LogIn size={13} /> In</> : <><LogOut size={13} /> Out</>}
                      </button>
                    </div>
                    </Fragment>
                  );
                })}
                {manualLists.enrolled.length + manualLists.others.length === 0 && (
                  <p className="p-2 text-sm text-gray-400">{namesQ.isLoading ? "Loading names…" : "No employees found"}</p>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-3">
              {manualError && (
                <div className="rounded-md border border-red-300 bg-red-50 p-2 text-[13px] text-red-800">
                  {manualError}
                  <button
                    type="button"
                    className="mt-1 block underline"
                    onClick={() => {
                      const { employee, punchType } = manualSelected;
                      const cap = manualCapture;
                      setManualOpen(false); setManualSelected(null); setManualError(null);
                      // The photograph stays as the record of who stood there; the face is not learned.
                      void submitPunch(employee, punchType, "manual", null, cap?.photo ?? null, null, manualReason);
                    }}
                  >
                    Punch {manualSelected.employee.name} without teaching
                  </button>
                </div>
              )}
              <button type="button" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800" onClick={() => { setManualSelected(null); setManualCapture(null); setManualError(null); }}>
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
                  <button className="btn-secondary flex-1" onClick={() => void captureManualPhoto()} disabled={capturing || !cameraOn || engineState === "loading"}>
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
                  setManualError(null);
                  void submitPunch(employee, punchType, "manual", null, cap?.photo ?? null, cap?.embedding ?? null, manualReason);
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
