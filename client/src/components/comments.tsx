import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Send, Trash2 } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";

interface Comment {
  id: string;
  body: string;
  createdAt: string;
  createdBy: string;
  authorName: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** Inline comment timeline — used by the drawer and the contact Comments tab. */
export function CommentsTimeline({
  entityType,
  entityId,
  history,
}: {
  entityType: string;
  entityId: string;
  history?: Array<{ label: string; at: string | null | undefined }>;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: rows } = useQuery({
    queryKey: ["comments", entityType, entityId],
    queryFn: () => api<Comment[]>(`/api/comments?entityType=${entityType}&entityId=${entityId}`),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["comments", entityType, entityId] });

  const post = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await api("/api/comments", {
        method: "POST",
        body: { entityType, entityId, body: draft.trim() },
      });
      setDraft("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api(`/api/comments/${id}`, { method: "DELETE" });
    await refresh();
  };

  const count = rows?.length ?? 0;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-3">
            {history
              ?.filter((h) => h.at)
              .map((h, i) => (
                <div key={`h-${i}`} className="mb-3 flex items-start gap-2.5">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-gray-300" />
                  <div className="text-[13px]">
                    <span className="text-gray-600">{h.label}</span>
                    <span className="ml-2 text-[11px] text-gray-400">{timeAgo(h.at!)}</span>
                  </div>
                </div>
              ))}

            {rows?.map((c) => (
              <div key={c.id} className="group mb-3.5 flex items-start gap-2.5">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-yolk-400 to-yolk-600 text-[11px] font-bold text-white">
                  {c.authorName[0]?.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold">{c.authorName}</span>
                    <span className="text-[11px] text-gray-400">{timeAgo(c.createdAt)}</span>
                    {(c.createdBy === user?.id || user?.permissions["*"]?.includes("*")) && (
                      <button
                        onClick={() => void remove(c.id)}
                        className="hidden rounded p-0.5 text-gray-300 hover:text-red-500 group-hover:block"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-[13px] text-gray-700">{c.body}</p>
                </div>
              </div>
            ))}

            {!count && !history?.some((h) => h.at) && (
              <p className="py-4 text-center text-[13px] text-gray-400">No activity yet.</p>
            )}
          </div>

          <div className="flex items-end gap-2 border-t border-gray-100 p-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void post();
                }
              }}
              rows={2}
              placeholder="Write a comment… (Enter to post)"
              className="input flex-1 resize-none"
            />
            <button
              onClick={() => void post()}
              disabled={busy || !draft.trim()}
              className="btn-primary p-2"
              title="Post comment"
            >
              <Send size={14} />
            </button>
      </div>
    </>
  );
}

/** Toolbar button + drawer wrapping the timeline. */
export function CommentsButton({
  entityType,
  entityId,
  history,
}: {
  entityType: string;
  entityId: string;
  history?: Array<{ label: string; at: string | null | undefined }>;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const { data: rows } = useQuery({
    queryKey: ["comments", entityType, entityId],
    queryFn: () => api<Comment[]>(`/api/comments?entityType=${entityType}&entityId=${entityId}`),
  });
  const count = rows?.length ?? 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={panelRef}>
      <button onClick={() => setOpen((o) => !o)} className="btn-ghost relative p-2" title="Comments & History">
        <MessageSquare size={15} />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 w-4 place-items-center rounded-full bg-brand-500 text-[10px] font-bold text-white">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-30 flex max-h-[480px] w-96 flex-col rounded-xl border border-gray-100 bg-white shadow-xl">
          <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-bold">
            Comments &amp; History
          </div>
          <CommentsTimeline entityType={entityType} entityId={entityId} history={history} />
        </div>
      )}
    </div>
  );
}
