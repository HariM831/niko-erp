/**
 * The NIR bench on the Weighment page: is the IAS file being read, which
 * recent scans have not found their truck and why, and which material each
 * calibration model is for.
 *
 * The scans that DID find a truck are not listed here — they show up filled
 * in on that truck's QC panel, which is where the technician is looking.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Plug, X } from "lucide-react";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { canRead, chooseFile, getSnapshot, grant, start, subscribe } from "../lib/nir-feed";

interface ScanView {
  resultSn: string;
  model: string;
  sampleName: string | null;
  scannedAt: string;
  readings: Record<string, number>;
  flagged: string[];
}

interface BenchStatus {
  lastUploadAt: string | null;
  lastScanAt: string | null;
  models: Array<{
    shortName: string;
    modelName: string | null;
    version: string | null;
    matterNames: Record<string, string>;
    items: Array<{ itemId: string; itemName: string }>;
  }>;
  specItems: Array<{ id: string; name: string; hasSpec: boolean }>;
  waiting: Array<{ scan: ScanView; receiptNumber: string | null; itemName: string | null }>;
  unplaced: Array<{ scan: ScanView; receiptNumber: string | null; reason: string }>;
}

const time = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function ago(ms: number | null): string {
  if (ms == null) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * Start the reader and keep the screens that depend on it fresh.
 *
 * Called by the Weighment page whatever tab is open: the weighbridge operator
 * and the technician share the desk, and the page is open there all day.
 */
export function useNirFeed() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const allowed = can("office", "quality_control") || can("office", "weighbridge");
  const feed = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (allowed) void start();
  }, [allowed]);
  const seen = useRef(feed.uploadedAt);
  useEffect(() => {
    if (feed.uploadedAt && feed.uploadedAt !== seen.current) {
      seen.current = feed.uploadedAt;
      void qc.invalidateQueries({ queryKey: ["office", "qc-context"] });
      void qc.invalidateQueries({ queryKey: ["office", "nir"] });
    }
  }, [feed.uploadedAt, qc]);
  return { feed, allowed };
}

/** One line for the page header: is the bench's file being read. */
export function NirFeedStatus() {
  const { feed, allowed } = useNirFeed();
  // Re-render the "read 4s ago" text without waiting on the next read.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);
  if (!allowed) return null;

  const pill = "flex items-center gap-1.5 text-[12px]";
  if (feed.status === "unsupported" || !canRead()) {
    return <span className={`${pill} text-gray-400`} title="Needs Chrome or Edge on the bench PC">
      <FlaskConical size={14} /> NIR: this browser cannot read the IAS file
    </span>;
  }
  if (feed.status === "idle") {
    return (
      <button className={`${pill} rounded-md border border-gray-200 px-2 py-1 text-gray-700 hover:bg-gray-50`} onClick={() => void chooseFile()}
        title="Pick pro2.db from the IAS folder on this PC">
        <Plug size={14} /> Connect NIR (pro2.db)
      </button>
    );
  }
  if (feed.status === "needs-permission") {
    return (
      <button className={`${pill} rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800`} onClick={() => void grant()}
        title="Chrome asks again after a restart. Tick “Allow on every visit” to stop it asking.">
        <Plug size={14} /> Allow NIR reading
      </button>
    );
  }
  if (feed.status === "error") {
    return (
      <button className={`${pill} text-red-600`} onClick={() => void chooseFile()} title={feed.error ?? ""}>
        <FlaskConical size={14} /> NIR: {feed.error} — pick the file again
      </button>
    );
  }
  return (
    <span className={`${pill} text-gray-500`} title={`${feed.fileName} · uploaded ${ago(feed.uploadedAt)}`}>
      <span className="h-2 w-2 rounded-full bg-green-500" />
      NIR · read {ago(feed.readAt)} · {feed.scansInWindow} scan{feed.scansInWindow === 1 ? "" : "s"} in 3 days
    </span>
  );
}

function Readings({ scan }: { scan: ScanView }) {
  return (
    <span className="text-[11px] text-gray-500">
      {Object.entries(scan.readings).map(([n, v], i) => (
        <span key={n} className={scan.flagged.includes(n) ? "text-amber-700" : ""}>
          {i > 0 ? " · " : ""}
          {n} {Number(v.toFixed(3))}
          {scan.flagged.includes(n) ? "⚑" : ""}
        </span>
      ))}
    </span>
  );
}

/** The QC tab's footer: scans that found nothing, and the model links. */
export function NirBench() {
  const { allowed } = useNirFeed();
  const { can } = useAuth();
  const mayLink = can("office", "manage_rules");
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [showModels, setShowModels] = useState(false);

  const { data } = useQuery<BenchStatus>({
    queryKey: ["office", "nir", "status"],
    queryFn: () => api("/api/office/nir/status"),
    refetchInterval: 15_000,
    enabled: allowed,
  });

  const link = useMutation({
    mutationFn: ({ shortName, itemIds }: { shortName: string; itemIds: string[] }) =>
      api(`/api/office/nir/models/${encodeURIComponent(shortName)}/items`, { method: "PUT", body: { itemIds } }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["office"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save the link"),
  });

  if (!allowed || !data) return null;
  const unlinked = data.models.filter((m) => !m.items.length).length;
  const linkedElsewhere = new Set(data.models.flatMap((m) => m.items.map((i) => i.itemId)));

  return (
    <div className="card mt-4 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[14px] font-semibold text-gray-900">NIR scans not on a truck</h2>
        <button className="text-[12px] text-brand-700 hover:underline" onClick={() => setShowModels((v) => !v)}>
          {showModels ? "Hide models" : `Models${unlinked ? ` · ${unlinked} not linked` : ""}`}
        </button>
      </div>
      {error && <p className="mb-2 text-[12px] text-red-600">{error}</p>}

      {!data.unplaced.length ? (
        <p className="text-[12px] text-gray-400">
          Every scan from the last three days has found its truck
          {data.waiting.length ? ` — ${data.waiting.length} waiting on QC to be saved` : ""}.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {data.unplaced.map((u) => (
            <li key={u.scan.resultSn} className="py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] text-gray-900">
                  <span className="font-mono">{u.scan.sampleName || "—"}</span>
                  <span className="ml-2 text-[11px] text-gray-400">{u.scan.model}</span>
                </span>
                <span className="text-[11px] text-gray-400">{time(u.scan.scannedAt)}</span>
              </div>
              <div className="text-[12px] text-amber-700">{u.reason}</div>
              <Readings scan={u.scan} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-gray-400">
        Fix a mistyped GR by renaming the sample in IAS — the scan moves to the right truck on the next read.
      </p>

      {showModels && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          {!data.models.length && (
            <p className="text-[12px] text-gray-400">No models yet — they arrive with the first read of the IAS file.</p>
          )}
          {data.models.map((m) => (
            <div key={m.shortName} className="py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-gray-900">
                  {m.modelName || m.shortName}
                  <span className="ml-2 font-mono text-[11px] text-gray-400">{m.shortName}{m.version ? ` v${m.version}` : ""}</span>
                </span>
              </div>
              <div className="text-[11px] text-gray-500">{Object.values(m.matterNames).join(" · ")}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {m.items.map((i) => (
                  <span key={i.itemId} className="flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[12px] text-brand-700">
                    {i.itemName}
                    {mayLink && (
                      <button
                        title="Unlink"
                        onClick={() => link.mutate({ shortName: m.shortName, itemIds: m.items.filter((x) => x.itemId !== i.itemId).map((x) => x.itemId) })}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </span>
                ))}
                {!m.items.length && <span className="text-[12px] text-gray-400">Not linked to a material</span>}
                {mayLink && (
                  <select
                    className="input h-7 w-auto py-0 text-[12px]"
                    value=""
                    onChange={(e) =>
                      e.target.value &&
                      link.mutate({ shortName: m.shortName, itemIds: [...m.items.map((x) => x.itemId), e.target.value] })
                    }
                  >
                    <option value="">Link a material…</option>
                    {data.specItems
                      .filter((s) => !linkedElsewhere.has(s.id))
                      .map((s) => (
                        <option key={s.id} value={s.id}>{s.name}{s.hasSpec ? "" : " (no spec yet)"}</option>
                      ))}
                  </select>
                )}
              </div>
            </div>
          ))}
          <p className="mt-2 text-[11px] text-gray-400">
            A material is scanned with one model; one model may serve several materials. A material with no spec yet keeps its NIR readings unjudged, for comparing once a spec is written.
          </p>
        </div>
      )}
    </div>
  );
}
