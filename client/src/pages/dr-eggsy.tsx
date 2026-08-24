/**
 * Dr niko — what somebody found in a shed, sent for a first opinion.
 *
 * A worker photographs a post-mortem or anything that looks wrong, picks the
 * shed, and submits. Analyze sends the photos to a vision model together with
 * the flock's own record — age, breed, live birds, the last week of
 * production, mortality, feed and water — and the answer comes back as a
 * structured clinical remark.
 *
 * The remark is a first opinion from a model, not a diagnosis; the page says
 * so on its face. It is stored verbatim with the model's name.
 */
import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, Plus, Stethoscope, Trash2, X } from "lucide-react";
import { api } from "../api";
import { useApp } from "../lib/store";

interface ObsImage {
  id: string;
  fileName: string;
  mimeType: string;
}

interface Observation {
  id: string;
  houseId: string;
  houseCode: string;
  observedOn: string;
  note: string | null;
  aiRemark: string | null;
  aiModel: string | null;
  analyzedAt: string | null;
  createdAt: string;
  images: ObsImage[];
}

interface BoardRow {
  houseId: string;
  code: string;
  purpose: string;
}

const fmtDate = (d: string) =>
  new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

/** The **Category:** line of a remark, as a chip. */
function categoryOf(remark: string | null): { label: string; cls: string } | null {
  if (!remark) return null;
  const m = remark.match(/\*\*Category:\*\*\s*\[?([A-Z_]+)\]?/);
  if (!m) return null;
  const map: Record<string, { label: string; cls: string }> = {
    CRITICAL_INFECTIOUS: { label: "Critical · infectious", cls: "bg-destructive/10 text-destructive" },
    WARNING_MANAGEMENT: { label: "Warning · management", cls: "bg-warning/10 text-warning" },
    INFO_NUTRITIONAL: { label: "Info · nutritional", cls: "bg-info/10 text-info" },
  };
  return map[m[1]!] ?? { label: m[1]!, cls: "bg-muted text-muted-foreground" };
}

/** The one-sentence clinical remark, for the card. */
function summaryOf(remark: string | null): string | null {
  if (!remark) return null;
  const m = remark.match(/\*\*Clinical Remark:\*\*\s*([^\n*]+)/);
  return m ? m[1]!.trim() : null;
}

/**
 * The remark, readable. It arrives as markdown-ish text with **bold** and
 * bullet lists; rendered with a tiny translator rather than a library, because
 * the format is ours (the prompt dictates it) and a full renderer would be the
 * first dependency this page has.
 */
function Remark({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1 text-sm">
      {lines.map((line, i) => {
        const heading = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
        if (heading) {
          return (
            <p key={i} className="pt-1.5">
              <span className="font-semibold">{heading[1]}:</span>{" "}
              {heading[2]?.replace(/^\[|\]$/g, "")}
            </p>
          );
        }
        if (line.trim().startsWith("- ")) {
          const item = line.trim().slice(2);
          const label = item.match(/^([\w\s]+):\s*(.*)$/);
          return (
            <p key={i} className="pl-4 text-muted-foreground">
              •{" "}
              {label ? (
                <>
                  <span className="font-medium text-foreground">{label[1]}:</span> {label[2]}
                </>
              ) : (
                item
              )}
            </p>
          );
        }
        if (!line.trim()) return null;
        return (
          <p key={i} className="text-muted-foreground">
            {line}
          </p>
        );
      })}
    </div>
  );
}

export function DrEggsyPage() {
  const { state } = useApp();
  const [observations, setObservations] = useState<Observation[]>([]);
  const [houses, setHouses] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Observation | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ observations: Observation[] }>("/api/farms/dr-eggsy")
      .then((d) => setObservations(d.observations))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    api<{ board: BoardRow[] }>("/api/farms/iot/board")
      .then((d) => setHouses(d.board))
      .catch(() => setHouses([]));
  }, []);

  const analyze = async (id: string) => {
    setAnalyzing(id);
    setError(null);
    try {
      const updated = await api<Observation>(`/api/farms/dr-eggsy/${id}/analyze`, { method: "POST" });
      await load();
      setOpen((cur) => (cur?.id === id ? { ...cur, ...updated } : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setAnalyzing(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this observation and its photos?")) return;
    await api(`/api/farms/dr-eggsy/${id}`, { method: "DELETE" });
    setOpen(null);
    load();
  };

  const isAdmin = state.currentUser?.isAdmin || false;

  return (
    <div className="min-h-full bg-soil-50 p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-yolk-400 to-yolk-600 text-white shadow-sm">
            <Stethoscope className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-soil-900">Dr niko</h1>
            <p className="text-sm text-soil-400">
              Field observations sent for diagnosis — a first opinion from a model, not a vet.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-yolk-500 px-3 py-2 text-sm font-medium text-white hover:bg-yolk-600"
        >
          <Plus className="h-4 w-4" /> New observation
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">reading…</div>
      ) : !observations.length ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Nothing observed yet. Photograph what you found and send it in.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {observations.map((o) => {
            const cat = categoryOf(o.aiRemark);
            const summary = summaryOf(o.aiRemark);
            return (
              <button
                key={o.id}
                onClick={() => setOpen(o)}
                className="flex flex-col overflow-hidden rounded-2xl bg-white text-left shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)] transition-shadow hover:shadow-md"
              >
                {/* First photo as the card face; the rest counted. */}
                {o.images[0] ? (
                  <div className="relative h-40 w-full bg-muted">
                    <img
                      src={`/api/farms/dr-eggsy/image/${o.images[0].id}`}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    {o.images.length > 1 && (
                      <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                        +{o.images.length - 1} more
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex h-40 w-full items-center justify-center bg-muted text-muted-foreground">
                    <Camera className="h-6 w-6" />
                  </div>
                )}
                <div className="flex flex-1 flex-col gap-1 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">{o.houseCode}</span>
                    <span className="text-xs text-muted-foreground">{fmtDate(o.observedOn)}</span>
                  </div>
                  {cat && (
                    <span className={`w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold ${cat.cls}`}>
                      {cat.label}
                    </span>
                  )}
                  {summary ? (
                    <p className="line-clamp-3 text-xs text-muted-foreground">{summary}</p>
                  ) : o.aiRemark ? (
                    <p className="line-clamp-3 text-xs text-muted-foreground">{o.aiRemark}</p>
                  ) : (
                    <p className="text-xs italic text-muted-foreground">Not analysed yet</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
          onClick={() => setOpen(null)}
        >
          <div
            className="mt-6 w-full max-w-3xl rounded-lg bg-background p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">
                  {open.houseCode} · {fmtDate(open.observedOn)}
                </h2>
                {open.aiModel && (
                  <p className="text-[11px] text-muted-foreground">
                    answered by {open.aiModel}
                    {open.analyzedAt &&
                      ` · ${new Date(open.analyzedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && (
                  <button
                    onClick={() => remove(open.id)}
                    className="rounded-md p-2 text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                <button onClick={() => setOpen(null)} className="rounded-md p-2 text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {open.images.map((img) => (
                <a
                  key={img.id}
                  href={`/api/farms/dr-eggsy/image/${img.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-md border border-border"
                >
                  <img src={`/api/farms/dr-eggsy/image/${img.id}`} alt="" className="h-28 w-full object-cover" />
                </a>
              ))}
            </div>

            {open.note && (
              <div className="mb-3 rounded-xl bg-soil-50 px-3 py-2 text-sm">
                <span className="font-medium">Field note:</span> {open.note}
              </div>
            )}

            {open.aiRemark ? (
              <div className="rounded-xl bg-yolk-50/60 p-3">
                <Remark text={open.aiRemark} />
              </div>
            ) : (
              <p className="text-sm italic text-muted-foreground">Not analysed yet.</p>
            )}

            <div className="mt-3 flex justify-end">
              <button
                onClick={() => analyze(open.id)}
                disabled={analyzing === open.id}
                className="inline-flex items-center gap-1.5 rounded-md bg-yolk-500 px-3 py-2 text-sm font-medium text-white hover:bg-yolk-600 disabled:opacity-50"
              >
                {analyzing === open.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Stethoscope className="h-4 w-4" />
                )}
                {open.aiRemark ? "Analyse again" : "Analyse"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showNew && (
        <NewObservation
          houses={houses}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function NewObservation({
  houses,
  onClose,
  onCreated,
}: {
  houses: BoardRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [houseId, setHouseId] = useState(houses[0]?.houseId ?? "");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!houseId) return setError("Pick a shed");
    if (!files.length) return setError("At least one photo — there is nothing to diagnose without one");
    setSaving(true);
    setError(null);
    try {
      const obs = await api<{ id: string }>("/api/farms/dr-eggsy", {
        method: "POST",
        body: { houseId, observedOn: date, note: note || undefined },
      });
      // Photos ride the shared attachments route, one request per file.
      for (const f of files) {
        const fd = new FormData();
        fd.append("entityType", "ai_observation");
        fd.append("entityId", obs.id);
        fd.append("file", f);
        const r = await fetch("/api/attachments", { method: "POST", body: fd, credentials: "same-origin" });
        if (!r.ok) throw new Error(`Photo "${f.name}" failed to upload`);
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="mt-10 w-full max-w-md rounded-lg bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-lg font-semibold">New observation</h2>

        <label className="mb-1 block text-xs font-medium text-muted-foreground">Shed</label>
        <select
          value={houseId}
          onChange={(e) => setHouseId(e.target.value)}
          className="mb-3 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
        >
          {houses.map((h) => (
            <option key={h.houseId} value={h.houseId}>
              {h.code}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs font-medium text-muted-foreground">Date</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mb-3 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
        />

        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          What did you find? (optional — the model reads this too)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          placeholder="e.g. three birds dead near the west fans, greenish droppings"
        />

        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])}
        />
        <button
          onClick={() => fileInput.current?.click()}
          className="btn-yolk-secondary mb-2"
        >
          <Camera className="h-4 w-4" /> Add photos
        </button>
        {files.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs">
                {f.name.length > 24 ? `${f.name.slice(0, 24)}…` : f.name}
                <button onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-yolk-500 px-3 py-2 text-sm font-medium text-white hover:bg-yolk-600 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
