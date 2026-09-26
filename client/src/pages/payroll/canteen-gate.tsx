/**
 * The Canteen Gate — a counter in a browser. A face, a plate, a token.
 *
 * It records the same rows the phones once sent, with no device behind them:
 * the server stamps who was logged in. Three things it deliberately does not
 * decide for itself:
 *
 *   Which meal it is. The server reads the clock when the plate is recorded;
 *   this page only ASKS what meal it is, to say so on screen. Amino's canteen
 *   gate sent the meal, and while its page was still loading it sent "lunch" —
 *   breakfast plates went down as lunch, outside their window.
 *
 *   Whether someone may eat. Breakfast or dinner for someone not on the list is
 *   warned about and served all the same; the server marks it, and it shows
 *   under Exceptions. The counter is not where that argument is won.
 *
 *   Who someone is, when it is not sure. As at the attendance gate, a name is
 *   picked by hand only after a scan has failed, or when no scan is possible.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Camera, CameraOff, CheckCircle2, Loader2, ScanFace, SwitchCamera, UserSearch, Utensils } from "lucide-react";
import { ApiError, api } from "../../api";
import { SearchSelect } from "../../components/search-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge, ErrorBanner, PageHeader, istToday, useErr } from "../../components/payroll/ui";
import { DateInput } from "../../components/date-input";
import { DEFAULT_MATCH_THRESHOLD, MIN_MATCH_MARGIN, getFaceEmbedding, looksSpoofed } from "../../lib/face";
import { useCamera } from "../../lib/use-camera";
import { buildMatchIndex, findBestMatchIndexed } from "@shared/face-match";
import { centredOf, useCentredIndex, type CentredResult } from "../../lib/face-model";
import { useAppOutdated } from "../../lib/app-version";
import { matchesTerms } from "@shared/search";

interface Person { id: string; empCode: string; name: string; payType: string; descriptors: number[][]; breakfast: boolean; dinner: boolean }
interface CanteenRow { id: string; code: string; name: string }
interface GateState {
  meal: "breakfast" | "lunch" | "dinner";
  mealLabel: string;
  outsideWindow: boolean;
  served: { employeeId: string | null; servedAt: string; personName: string; state: string; tokenNumber: string }[];
}
interface Served { personName: string; mealLabel: string; tokenNumber: string; ineligible: boolean; outsideWindow: boolean; attendancePresent: boolean | null }
/** The day's tally, by meal — no names, just how many plates went out. */
interface Counts { date: string; breakfast: number; lunch: number; dinner: number; total: number }

type Stage =
  | { kind: "idle" }
  | { kind: "matching" }
  | { kind: "confirm"; person: Person; method: "face" | "manual"; score: number | null; centred?: CentredResult | null }
  | { kind: "nomatch"; spoofed?: boolean }
  | { kind: "posting" }
  | { kind: "served"; plate: Served }
  | { kind: "duplicate"; name: string; message: string; token: string; at: string };

const CANTEEN_KEY = "niko.canteen-gate.canteen";
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function PayrollCanteenGatePage() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const { videoRef, cameraOn, setCameraOn, cameraError, facingMode, setFacingMode, engineState } = useCamera();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [manualOpen, setManualOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [canteenId, setCanteenId] = useState<string>(() => {
    try { return localStorage.getItem(CANTEEN_KEY) ?? ""; } catch { return ""; }
  });

  /**
   * The tally at the top has its own day, because the question it answers is
   * usually "how many did we do yesterday" — and the counter must not have to
   * leave the page it is serving from to answer it. Serving is always today's
   * business whatever this says.
   */
  const [countDate, setCountDate] = useState(istToday());

  const canteensQ = useQuery({ queryKey: ["canteen-gate", "canteens"], queryFn: () => api<CanteenRow[]>("/api/canteen/gate/canteens") });
  const countsQ = useQuery({
    queryKey: ["canteen-gate", "counts", canteenId, countDate],
    queryFn: () => api<Counts>(`/api/canteen/gate/counts?date=${countDate}&canteenId=${canteenId}`),
    enabled: !!canteenId,
    refetchInterval: 60_000,
  });
  const rosterQ = useQuery({ queryKey: ["canteen-gate", "roster"], queryFn: () => api<Person[]>("/api/canteen/gate/roster"), staleTime: 5 * 60_000 });
  // What the SERVER says the meal is, asked again every half minute so the
  // label turns over with the clock. Nothing is served until it has answered.
  const stateQ = useQuery({
    queryKey: ["canteen-gate", "state", canteenId],
    queryFn: () => api<GateState>(`/api/canteen/gate/state?canteenId=${canteenId}`),
    enabled: !!canteenId,
    refetchInterval: 30_000,
  });

  // A remembered canteen that has since been closed is forgotten; a site with
  // one canteen never has to be asked.
  useEffect(() => {
    const list = canteensQ.data;
    if (!list) return;
    if (canteenId && !list.some((c) => c.id === canteenId)) setCanteenId("");
    else if (!canteenId && list.length === 1) setCanteenId(list[0]!.id);
  }, [canteensQ.data, canteenId]);
  useEffect(() => {
    try { if (canteenId) localStorage.setItem(CANTEEN_KEY, canteenId); } catch { /* private window */ }
  }, [canteenId]);

  const people = rosterQ.data ?? [];
  const enrolled = useMemo(() => people.filter((p) => p.descriptors.length > 0), [people]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const candidates = useMemo(() => enrolled.map((p) => ({ id: p.id, descriptors: p.descriptors })), [enrolled]);
  const index = useMemo(() => buildMatchIndex(candidates), [candidates]);
  // Centred matching, scored beside the raw match and recorded with the plate;
  // it decides nothing yet (lib/face-model.ts).
  const centredIdx = useCentredIndex(candidates);
  const servedIds = useMemo(() => new Set((stateQ.data?.served ?? []).map((s) => s.employeeId)), [stateQ.data]);

  const meal = stateQ.data?.meal ?? null;
  const ready = !!canteenId && !!meal && !rosterQ.isLoading;
  const scanImpossible = engineState === "failed" || cameraError !== null || (!rosterQ.isLoading && enrolled.length === 0);
  const busy = stage.kind === "matching" || stage.kind === "posting";

  const onList = (p: Person) => meal === "lunch" || (meal === "breakfast" ? p.breakfast : p.dinner);

  // A new build went out: reload while nobody is mid-punch, so the gate never
  // runs last deploy's code all day (lib/app-version.ts).
  const outdated = useAppOutdated();
  useEffect(() => {
    if (outdated && stage.kind === "idle" && !manualOpen) window.location.reload();
  }, [outdated, stage.kind, manualOpen]);

  async function scan() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) { setErr("Camera not ready."); return; }
    setErr(null);
    setStage({ kind: "matching" });
    try {
      const face = await getFaceEmbedding(video);
      if (!face.ok || !face.embedding) { setStage({ kind: "nomatch" }); return; }
      if (looksSpoofed(face)) { setStage({ kind: "nomatch", spoofed: true }); return; }
      const m = findBestMatchIndexed(face.embedding, index);
      const person = m.id ? byId.get(m.id) ?? null : null;
      if (person && m.score >= DEFAULT_MATCH_THRESHOLD && m.score - m.secondScore >= MIN_MATCH_MARGIN) {
        if (navigator.vibrate) navigator.vibrate(50);
        setStage({ kind: "confirm", person, method: "face", score: m.score, centred: centredOf(face.embedding, centredIdx) });
      } else {
        setStage({ kind: "nomatch" });
      }
    } catch (e) {
      setStage({ kind: "idle" });
      fail(e);
    }
  }

  async function serve(person: Person, method: "face" | "manual", score: number | null, centred: CentredResult | null = null) {
    setStage({ kind: "posting" });
    try {
      // Minted here so a retry on a bad connection is the same plate, not a second.
      const plate = await api<Served>("/api/canteen/gate/servings", {
        method: "POST",
        body: { clientId: crypto.randomUUID(), canteenId, employeeId: person.id, method, matchScore: score, centred },
      });
      setStage({ kind: "served", plate });
      qc.invalidateQueries({ queryKey: ["canteen-gate", "state"] });
      qc.invalidateQueries({ queryKey: ["canteen-gate", "counts"] });
      setTimeout(() => setStage((s) => (s.kind === "served" ? { kind: "idle" } : s)), 3000);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.duplicate === true) {
        setStage({ kind: "duplicate", name: person.name, message: e.message, token: String(e.data.tokenNumber ?? ""), at: String(e.data.servedAt ?? "") });
        qc.invalidateQueries({ queryKey: ["canteen-gate", "state"] });
      qc.invalidateQueries({ queryKey: ["canteen-gate", "counts"] });
        return;
      }
      setStage({ kind: "idle" });
      fail(e);
    }
  }

  const manualList = useMemo(() => people.filter((p) => matchesTerms(`${p.empCode} ${p.name}`, search)).slice(0, 40), [people, search]);
  const openManual = () => { setStage({ kind: "idle" }); setSearch(""); setManualOpen(true); };

  return (
    <div className="mx-auto max-w-2xl p-4 md:p-6">
      <PageHeader title="Canteen Gate" sub="Scan a face, serve a plate.">
        {meal && (
          <Badge tone={stateQ.data?.outsideWindow ? "amber" : "green"}>
            <Utensils size={12} className="mr-1 inline" />
            {stateQ.data!.mealLabel}{stateQ.data?.outsideWindow ? " · outside its hours" : ""}
          </Badge>
        )}
      </PageHeader>
      <ErrorBanner message={err} onClose={() => setErr(null)} />

      {canteenId && (
        <div className="card mb-3 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[13px] font-medium text-gray-700">Plates</span>
            <DateInput
              className="input h-8 w-auto text-[13px]"
              value={countDate}
              onChange={(e) => setCountDate(e.target.value || istToday())}
            />
            {countDate !== istToday() && (
              <button className="btn-ghost text-[12px]" onClick={() => setCountDate(istToday())}>
                Today
              </button>
            )}
            <span className="ml-auto text-[13px] tabular-nums text-gray-500">
              {countsQ.data ? `${countsQ.data.total} in all` : "—"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {(["breakfast", "lunch", "dinner"] as const).map((m) => (
              <div
                key={m}
                className={`rounded-md px-2 py-2 ${meal === m && countDate === istToday() ? "bg-brand-50 ring-1 ring-brand-200" : "bg-gray-50"}`}
              >
                <div className="text-[11px] uppercase tracking-wide text-gray-500">{m}</div>
                <div className="text-xl font-semibold tabular-nums text-gray-900">
                  {countsQ.data ? countsQ.data[m] : "—"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(canteensQ.data?.length ?? 0) > 1 || !canteenId ? (
        <div className="card mb-3 flex items-center gap-2 p-3 text-sm">
          <span className="text-gray-500">Canteen</span>
          <SearchSelect
            className="flex-1"
            value={canteenId || null}
            onChange={(id) => setCanteenId(id ?? "")}
            placeholder="Choose the canteen this counter is in…"
            options={(canteensQ.data ?? []).map((c) => ({ id: c.id, label: c.name, sub: c.code }))}
          />
        </div>
      ) : null}
      {canteensQ.data && canteensQ.data.length === 0 && (
        <div className="card mb-3 p-3 text-sm text-amber-800">No canteen has been set up yet — add one under Payroll › Canteen.</div>
      )}

      {engineState === "loading" && (
        <div className="card mb-3 flex items-center gap-2 p-3 text-sm text-gray-500">
          <Loader2 size={15} className="animate-spin" /> Loading face engine (first time ~8 MB, then cached)…
        </div>
      )}
      {scanImpossible && (
        <div className="card mb-3 flex flex-wrap items-center gap-2 p-3 text-sm text-amber-800">
          <AlertTriangle size={15} />
          <span className="flex-1">
            {engineState === "failed" ? "The face engine failed to load." : cameraError ? cameraError : "Nobody has an enrolled face yet."} Plates can still be served by name.
          </span>
          <button className="btn-primary" onClick={openManual} disabled={!ready}><UserSearch size={14} /> Serve by name</button>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="relative flex aspect-[4/3] items-center justify-center bg-black">
          <video ref={videoRef} playsInline muted className={`absolute inset-0 h-full w-full object-cover ${cameraOn ? "" : "hidden"} ${facingMode === "user" ? "scale-x-[-1]" : ""}`} />
          {!cameraOn && <div className="p-6 text-center text-sm text-white/70">{cameraError ?? "Camera is off"}</div>}

          {stage.kind === "matching" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white">
              <Loader2 size={36} className="animate-spin" /> Looking…
            </div>
          )}

          {stage.kind === "confirm" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center text-white">
              <div className="text-xl font-bold">{stage.person.name}</div>
              <div className="text-sm text-white/70">{stage.person.empCode}{stage.score != null ? ` · ${(stage.score * 100).toFixed(0)}%` : ""}</div>
              {servedIds.has(stage.person.id) && <div className="rounded bg-amber-500/90 px-2 py-1 text-sm text-black">Already had {stateQ.data?.mealLabel.toLowerCase()} today</div>}
              {!onList(stage.person) && (
                <div className="rounded bg-amber-500/90 px-2 py-1 text-sm text-black">
                  Not on the {stateQ.data?.mealLabel.toLowerCase()} list — it will be recorded as such
                </div>
              )}
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => setStage({ kind: "idle" })}>Cancel</button>
                <button className="btn-primary !h-10 !px-5" onClick={() => void serve(stage.person, stage.method, stage.score, stage.centred ?? null)}>
                  Serve {stateQ.data?.mealLabel.toLowerCase()}
                </button>
              </div>
            </div>
          )}

          {stage.kind === "nomatch" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center text-white">
              <div className="text-lg font-semibold">{stage.spoofed ? "That looks like a photo or a screen" : "Not recognised"}</div>
              <div className="text-sm text-white/70">Face the camera in good light and try again.</div>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => setStage({ kind: "idle" })}>Try again</button>
                <button className="inline-flex items-center gap-1.5 rounded-md border border-white/40 px-3 py-1.5 text-[13px] text-white" onClick={openManual}>
                  <UserSearch size={14} /> Select by name
                </button>
              </div>
            </div>
          )}

          {stage.kind === "served" && (
            <div className={`absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-white ${stage.plate.ineligible || stage.plate.attendancePresent === false ? "bg-amber-600/95" : "bg-emerald-600/95"}`}>
              <CheckCircle2 size={56} />
              <div className="text-xl font-bold">{stage.plate.personName}</div>
              <div className="text-sm">{stage.plate.mealLabel} · token {stage.plate.tokenNumber}</div>
              {stage.plate.ineligible && <div className="text-sm">Not on the list — recorded</div>}
              {stage.plate.attendancePresent === false && <div className="text-sm">No attendance punch today — recorded</div>}
            </div>
          )}

          {stage.kind === "duplicate" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-red-700/95 p-4 text-center text-white">
              <AlertTriangle size={48} />
              <div className="text-xl font-bold">{stage.name}</div>
              <div className="text-sm">{stage.message}{stage.at ? ` — at ${fmtTime(stage.at)}` : ""}{stage.token ? `, token ${stage.token}` : ""}</div>
              <button className="btn-secondary mt-2" onClick={() => setStage({ kind: "idle" })}>OK</button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 p-3">
          {!cameraOn ? (
            <button className="btn-primary !h-10 !px-5" onClick={() => setCameraOn(true)}><Camera size={16} /> Start camera</button>
          ) : (
            <>
              {/* Disabled until the server has said which meal it is: a plate is never served against a guess. */}
              <button className="btn-primary !h-10 !px-5" onClick={() => void scan()} disabled={busy || engineState !== "ready" || !ready || enrolled.length === 0}>
                {stage.kind === "matching" ? <Loader2 size={16} className="animate-spin" /> : <ScanFace size={16} />} Scan face
              </button>
              <button className="btn-secondary !h-10" onClick={() => setFacingMode((m) => (m === "user" ? "environment" : "user"))} disabled={busy} title="Switch camera"><SwitchCamera size={16} /></button>
              <button className="btn-secondary !h-10" onClick={() => setCameraOn(false)} disabled={busy} title="Stop camera"><CameraOff size={16} /></button>
            </>
          )}
        </div>
      </div>

      <div className="card mt-3 p-4">
        <h2 className="mb-3 text-[14px] font-semibold">
          {stateQ.data ? `${stateQ.data.mealLabel} served today (${stateQ.data.served.length})` : "Served today"}
        </h2>
        {!stateQ.data?.served.length ? (
          <p className="text-sm text-gray-400">No plates yet.</p>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto text-sm">
            {stateQ.data.served.map((s) => (
              <div key={s.tokenNumber + s.servedAt} className="flex items-center gap-2 border-b border-gray-100 pb-1.5 last:border-0">
                <span className="min-w-0 flex-1 truncate font-medium">{s.personName}</span>
                <span className="tabular-nums text-gray-400">{fmtTime(s.servedAt)}</span>
                <span className="tabular-nums text-[11px] text-gray-400">{s.tokenNumber}</span>
                {s.state === "name_matched" && <Badge tone="amber">manual</Badge>}
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Serve by name</DialogTitle></DialogHeader>
          <input className="input" placeholder="Search name or code…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {manualList.map((p) => (
              <button
                key={p.id}
                className="flex w-full items-center gap-2 rounded p-2 text-left text-sm hover:bg-gray-50"
                onClick={() => { setManualOpen(false); setStage({ kind: "confirm", person: p, method: "manual", score: null }); }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block text-xs text-gray-400">{p.empCode}</span>
                </span>
                {servedIds.has(p.id) && <Badge tone="amber">served</Badge>}
              </button>
            ))}
            {manualList.length === 0 && <p className="p-2 text-sm text-gray-400">No employees found</p>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
