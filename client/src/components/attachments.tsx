import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Image as ImageIcon, Paperclip, Trash2, Upload } from "lucide-react";
import { api } from "../api";

interface Attachment {
  filingRef: string | null;
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Paperclip button + dropdown panel for uploading and managing files on a
 * document (invoice, bill, expense, ...). Max 10 MB; pdf/images/sheets/docs.
 */
export function AttachmentsButton({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: files } = useQuery({
    queryKey: ["attachments", entityType, entityId],
    queryFn: () =>
      api<Attachment[]>(`/api/attachments?entityType=${entityType}&entityId=${entityId}`),
  });

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["attachments", entityType, entityId] });

  const uploadFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("entityType", entityType);
      form.append("entityId", entityId);
      form.append("file", file);
      const res = await fetch("/api/attachments", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Upload failed");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this attachment?")) return;
    await api(`/api/attachments/${id}`, { method: "DELETE" });
    await refresh();
  };

  const count = files?.length ?? 0;
  const [dragging, setDragging] = useState(false);

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn-ghost relative p-2"
        title="Attachments"
      >
        <Paperclip size={15} />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 w-4 place-items-center rounded-full bg-brand-500 text-[10px] font-bold text-white">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void uploadFile(f);
          }}
          className={`absolute right-0 top-10 z-30 w-80 rounded-xl border bg-white shadow-xl transition-colors ${
            dragging ? "border-brand-400 ring-2 ring-brand-100" : "border-gray-100"
          }`}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
            <span className="text-[13px] font-bold">Attachments</span>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="btn-primary px-2.5 py-1 text-xs"
            >
              <Upload size={12} /> {busy ? "Uploading…" : "Upload"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.xls,.xlsx,.docx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadFile(f);
              }}
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {!count ? (
              <p className="px-4 py-6 text-center text-[13px] text-gray-400">
                {dragging ? "Drop to upload" : "No files yet. Drag a file here or upload — PDF, images, sheets or docs up to 10 MB."}
              </p>
            ) : (
              files!.map((f) => (
                <div
                  key={f.id}
                  className="group flex items-center gap-2.5 border-b border-gray-50 px-4 py-2.5"
                >
                  <span className="chip h-8 w-8 bg-gray-100 text-gray-500">
                    {f.mimeType.startsWith("image/") ? <ImageIcon size={14} /> : <FileText size={14} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={`/api/attachments/${f.id}/download`}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-[13px] font-medium text-brand-600 hover:underline"
                    >
                      {f.fileName}
                    </a>
                    {/* The filing reference goes on the paper sheet before it
                        is filed, so the box and the scan find each other. */}
                    <div className="flex items-center gap-2 text-[11px] text-gray-400">
                      {f.filingRef && (
                        <span className="rounded border border-gray-200 px-1 font-medium tabular-nums text-gray-600">
                          {f.filingRef}
                        </span>
                      )}
                      <span>{formatSize(f.sizeBytes)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => void remove(f.id)}
                    className="rounded p-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
          {error && <p className="border-t border-gray-100 px-4 py-2 text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
