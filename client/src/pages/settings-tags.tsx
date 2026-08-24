import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { api } from "../api";
import {
  Badge,
  Banner,
  Modal,
  RowAction,
  RowActions,
  SettingsHeader,
} from "../components/settings-ui";

interface TagOption {
  id: string;
  tagId: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  usageCount: number;
}

interface ReportingTag {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  options: TagOption[];
}

export function ReportingTagsSection() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ReportingTag | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: tags, isLoading } = useQuery({
    queryKey: ["reporting-tags"],
    queryFn: () => api<ReportingTag[]>("/api/reporting-tags"),
  });

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["reporting-tags"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div>
      <SettingsHeader
        title="Reporting Tags"
        description="A dimension you can slice the P&L by — vehicle, shed, cost centre. Tag a journal line with an option and the profit and loss can be read for that option alone, without a GL account per truck."
        actions={
          <button onClick={() => setAdding(true)} className="btn-primary">
            + New Tag
          </button>
        }
      />
      {error && <Banner tone="error">{error}</Banner>}

      {isLoading && <p className="text-[13px] text-gray-500">Loading…</p>}
      {tags?.length === 0 && (
        <div className="rounded-md border border-dashed border-gray-200 px-5 py-10 text-center text-[13px] text-gray-500">
          No tags yet. A farm might start with &ldquo;Vehicle&rdquo; or &ldquo;Shed&rdquo;.
        </div>
      )}

      <div className="space-y-4">
        {tags?.map((tag) => (
          <div key={tag.id} className="rounded-md border border-gray-200">
            {/* gap + shrink-0 so the actions stay on one line and the name
                truncates instead, rather than the whole row wrapping. */}
            <div className="flex items-center justify-between gap-4 border-b bg-[#fafafc] px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-medium">{tag.name}</span>
                {!tag.isActive && <Badge tone="gray">Inactive</Badge>}
                <span className="shrink-0 text-[12px] text-gray-500">
                  {tag.options.length} option{tag.options.length === 1 ? "" : "s"}
                </span>
              </div>
              <RowActions>
                <RowAction onClick={() => setEditing(tag)}>Manage options</RowAction>
                <RowAction
                  onClick={() =>
                    void run(() =>
                      api(`/api/reporting-tags/${tag.id}`, {
                        method: "PATCH",
                        body: { isActive: !tag.isActive },
                      }),
                    )
                  }
                >
                  {tag.isActive ? "Deactivate" : "Activate"}
                </RowAction>
                <RowAction
                  tone="danger"
                  onClick={() => {
                    if (!confirm(`Delete the "${tag.name}" tag and all its options?`)) return;
                    void run(() => api(`/api/reporting-tags/${tag.id}`, { method: "DELETE" }));
                  }}
                >
                  Delete
                </RowAction>
              </RowActions>
            </div>
            {tag.description && (
              <p className="border-b px-4 py-2 text-[12px] text-gray-500">{tag.description}</p>
            )}
            <div className="flex flex-wrap gap-2 px-4 py-3">
              {tag.options.length === 0 && (
                <span className="text-[13px] text-gray-400">
                  No options yet — a tag does nothing until it has some.
                </span>
              )}
              {tag.options.map((o) => (
                <span
                  key={o.id}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${
                    o.isActive
                      ? "border-gray-200 bg-white text-gray-700"
                      : "border-gray-100 bg-gray-50 text-gray-400 line-through"
                  }`}
                >
                  {o.name}
                  {o.usageCount > 0 && (
                    <span className="text-[11px] text-gray-400">{o.usageCount}</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {adding && (
        <NewTagModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ["reporting-tags"] });
          }}
        />
      )}
      {editing && (
        <OptionsModal
          tag={tags?.find((t) => t.id === editing.id) ?? editing}
          onClose={() => setEditing(null)}
          onChanged={() => void qc.invalidateQueries({ queryKey: ["reporting-tags"] })}
        />
      )}
    </div>
  );
}

function NewTagModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/reporting-tags", {
        method: "POST",
        body: { name: name.trim(), description: description.trim() || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Reporting Tag"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
            className="btn-primary"
          >
            Create Tag
          </button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      <div className="grid gap-4">
        <div>
          <label className="label-required">Tag Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Vehicle"
            className="input"
            autoFocus
          />
        </div>
        <div>
          <label className="label">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Which vehicle a fuel or repair cost belongs to"
            className="input"
          />
        </div>
      </div>
      <p className="mt-3 text-[12px] text-gray-500">
        Add the individual values — each vehicle, each shed — once the tag exists.
      </p>
    </Modal>
  );
}

function OptionsModal({
  tag,
  onClose,
  onChanged,
}: {
  tag: ReportingTag;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const value = name.trim();
    if (!value) return;
    void run(async () => {
      await api(`/api/reporting-tags/${tag.id}/options`, {
        method: "POST",
        body: { name: value },
      });
      setName("");
    });
  };

  return (
    <Modal
      title={`${tag.name} options`}
      onClose={onClose}
      width="w-[560px]"
      footer={
        <button onClick={onClose} className="btn-secondary">
          Done
        </button>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}

      <div className="mb-4 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="e.g. Creta - 3333"
          className="input flex-1"
          autoFocus
        />
        <button onClick={add} disabled={busy || !name.trim()} className="btn-primary">
          <Plus size={14} /> Add
        </button>
      </div>

      {tag.options.length === 0 ? (
        <p className="text-[13px] text-gray-500">
          No options yet. Add one per vehicle, shed or cost centre you want to report on.
        </p>
      ) : (
        <ul className="divide-y">
          {tag.options.map((o) => (
            <li key={o.id} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-2">
                <span className={`text-[13px] ${o.isActive ? "" : "text-gray-400 line-through"}`}>
                  {o.name}
                </span>
                {o.usageCount > 0 && (
                  <span className="text-[12px] text-gray-400">
                    used on {o.usageCount} line{o.usageCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-[13px]">
                <button
                  onClick={() =>
                    void run(() =>
                      api(`/api/reporting-tags/options/${o.id}`, {
                        method: "PATCH",
                        body: { isActive: !o.isActive },
                      }),
                    )
                  }
                  className="text-[#e06d05] hover:underline"
                >
                  {o.isActive ? "Retire" : "Restore"}
                </button>
                {o.usageCount === 0 && (
                  <button
                    onClick={() =>
                      void run(() =>
                        api(`/api/reporting-tags/options/${o.id}`, { method: "DELETE" }),
                      )
                    }
                    className="text-gray-400 hover:text-red-600"
                    aria-label={`Delete ${o.name}`}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-[12px] text-gray-500">
        An option already used on a journal line can be retired but not deleted — the lines
        charged to it still need something to point at.
      </p>
    </Modal>
  );
}
