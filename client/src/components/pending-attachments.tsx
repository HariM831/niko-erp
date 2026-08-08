import { useRef, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";

/**
 * File queue for create forms: pick files before the document exists,
 * the parent uploads them after save. Mirrors the "Attach File(s)"
 * section on transaction create screens.
 */
export function PendingAttachments({
  files,
  onChange,
  label = "Attach File(s)",
}: {
  files: File[];
  onChange: (files: File[]) => void;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const add = (incoming: FileList | null) => {
    if (!incoming) return;
    const next = [...files, ...Array.from(incoming)].slice(0, 10);
    onChange(next);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div>
      <div className="label">{label}</div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        className={`rounded-xl border border-dashed p-3 transition-colors ${
          dragging ? "border-brand-400 bg-brand-50/50" : "border-gray-300 bg-gray-50/50"
        }`}
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-1.5 text-[13px] font-medium text-brand-600 hover:underline"
        >
          <Paperclip size={13} />
          Upload files or drag them here
        </button>
        <p className="mt-0.5 text-[11px] text-gray-400">
          Up to 10 files, 10 MB each — PDF, images, sheets, docs
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.xls,.xlsx,.docx"
          className="hidden"
          onChange={(e) => add(e.target.files)}
        />
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-[12px]"
              >
                {f.type.startsWith("image/") ? (
                  <ImageIcon size={12} className="text-gray-400" />
                ) : (
                  <FileText size={12} className="text-gray-400" />
                )}
                <span className="max-w-40 truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => onChange(files.filter((_, j) => j !== i))}
                  className="text-gray-300 hover:text-red-500"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Upload queued files against a just-created entity. Failures are collected, not thrown. */
export async function uploadPending(
  entityType: string,
  entityId: string,
  files: File[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const file of files) {
    const form = new FormData();
    form.append("entityType", entityType);
    form.append("entityId", entityId);
    form.append("file", file);
    const res = await fetch("/api/attachments", {
      method: "POST",
      body: form,
      credentials: "same-origin",
    }).catch(() => null);
    if (!res?.ok) failed.push(file.name);
  }
  return failed;
}
