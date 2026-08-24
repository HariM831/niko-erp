/**
 * Face enrolment — turn each employee's photo into a face descriptor the gate
 * matches against. Runs fully in the browser (lib/face.ts); the server only
 * stores the numbers.
 *
 * Two paths per employee: enrol from the photo on file, or upload a fresh
 * photo (which becomes both the photo and the descriptor). "Enrol all" walks
 * everyone with a photo and no face, one at a time.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, ScanFace, Search, Trash2, Upload } from "lucide-react";
import { api } from "../../api";
import { getFaceEmbedding, loadFaceEngine, loadImage, resizePhotoFile } from "../../lib/face";
import { Avatar, Badge, Empty, ErrorBanner, PageHeader, Pager, Spinner, Td, Th, useEmployees, useErr, usePaged } from "../../components/payroll/ui";

type RowState = { status: "working" } | { status: "done" } | { status: "error"; message: string } | undefined;

export function PayrollFaceEnrollmentPage() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const [search, setSearch] = useState("");
  const [engineState, setEngineState] = useState<"loading" | "ready" | "failed">("loading");
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [batch, setBatch] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 });

  const empQ = useEmployees();

  useEffect(() => {
    let cancelled = false;
    loadFaceEngine()
      .then(() => !cancelled && setEngineState("ready"))
      .catch(() => !cancelled && setEngineState("failed"));
    return () => { cancelled = true; };
  }, []);

  const active = empQ.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return active;
    return active.filter((e) => e.name.toLowerCase().includes(q) || e.empCode.toLowerCase().includes(q) || (e.department ?? "").toLowerCase().includes(q));
  }, [active, search]);
  const paged = usePaged(filtered);

  const stats = useMemo(() => ({
    enrolled: active.filter((e) => e.hasFace).length,
    pending: active.filter((e) => !e.hasFace && e.hasPhoto).length,
    noPhoto: active.filter((e) => !e.hasPhoto).length,
  }), [active]);

  const setRow = (id: string, s: RowState) => setRowState((prev) => ({ ...prev, [id]: s }));
  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "employees"] });

  /** Enrol from the photo on file. Returns an error message or null. */
  async function enrollFromPhoto(id: string): Promise<string | null> {
    try {
      const full = await api<{ photoUrl: string | null }>(`/api/payroll/employees/${id}`);
      if (!full.photoUrl) return "No photo on file";
      const img = await loadImage(full.photoUrl);
      const face = await getFaceEmbedding(img);
      if (!face.ok || !face.embedding) return "No face found in the photo — upload a clearer one";
      if (face.faceCount > 1) return `${face.faceCount} faces in the photo — upload one with only the employee`;
      await api(`/api/payroll/employees/${id}/face`, { method: "POST", body: { descriptor: face.embedding } });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Enrolment failed";
    }
  }

  async function handleEnrollOne(id: string) {
    setRow(id, { status: "working" });
    const error = await enrollFromPhoto(id);
    if (error) setRow(id, { status: "error", message: error });
    else { setRow(id, { status: "done" }); invalidate(); }
  }

  async function handleEnrollAll() {
    const targets = active.filter((e) => e.hasPhoto && !e.hasFace);
    if (!targets.length) { setErr("Nobody left to enrol — everyone with a photo already has a face."); return; }
    setBatch({ running: true, done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      setRow(t.id, { status: "working" });
      const error = await enrollFromPhoto(t.id);
      setRow(t.id, error ? { status: "error", message: error } : { status: "done" });
      setBatch({ running: true, done: i + 1, total: targets.length });
    }
    setBatch((b) => ({ ...b, running: false }));
    invalidate();
  }

  async function handleUpload(id: string, file: File | undefined) {
    if (!file) return;
    setRow(id, { status: "working" });
    try {
      const photoUrl = await resizePhotoFile(file, 512);
      const img = await loadImage(photoUrl);
      const face = await getFaceEmbedding(img);
      if (!face.ok || !face.embedding) { setRow(id, { status: "error", message: "No face found in that photo" }); return; }
      if (face.faceCount > 1) { setRow(id, { status: "error", message: "More than one face in that photo" }); return; }
      await api(`/api/payroll/employees/${id}`, { method: "PATCH", body: { photoUrl } });
      await api(`/api/payroll/employees/${id}/face`, { method: "POST", body: { descriptor: face.embedding } });
      setRow(id, { status: "done" });
      invalidate();
    } catch (e) {
      setRow(id, { status: "error", message: e instanceof Error ? e.message : "Upload failed" });
    }
  }

  async function handleRemove(id: string) {
    try {
      await api(`/api/payroll/employees/${id}/face`, { method: "DELETE" });
      setRow(id, undefined);
      invalidate();
    } catch (e) { fail(e); }
  }

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Face enrolment" sub={`${stats.enrolled} enrolled · ${stats.pending} with a photo waiting · ${stats.noPhoto} without a photo`}>
        <button className="btn-primary" onClick={() => void handleEnrollAll()} disabled={engineState !== "ready" || batch.running}>
          {batch.running ? <Loader2 size={14} className="animate-spin" /> : <ScanFace size={14} />}
          {batch.running ? `Enrolling ${batch.done}/${batch.total}…` : "Enrol all with photos"}
        </button>
      </PageHeader>
      <ErrorBanner message={err} onClose={() => setErr(null)} />

      {engineState === "loading" && (
        <div className="card mb-3 flex items-center gap-2 p-3 text-sm text-gray-500">
          <Loader2 size={15} className="animate-spin" /> Loading face engine (first time ~8 MB, then cached)…
        </div>
      )}
      {engineState === "failed" && (
        <div className="card mb-3 flex items-center gap-2 p-3 text-sm text-red-600">
          <AlertTriangle size={15} /> Face engine failed to load. Check internet and reload.
        </div>
      )}

      <div className="relative mb-3 w-64">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-gray-400" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code or department" className="input pl-8" />
      </div>

      <div className="table-surface">
        {empQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr><Th>Employee</Th><Th>Department</Th><Th>Photo</Th><Th>Face</Th><Th /></tr>
            </thead>
            <tbody>
              {paged.page.map((e) => {
                const rs = rowState[e.id];
                return (
                  <tr key={e.id} className="table-row">
                    <Td>
                      <span className="flex items-center gap-2">
                        <Avatar name={e.name} size="sm" src={e.hasPhoto ? `/api/payroll/employees/${e.id}/photo` : null} />
                        <span className="font-medium">{e.name}</span>
                        <span className="text-[11px] text-gray-400">{e.empCode}</span>
                      </span>
                    </Td>
                    <Td>{e.department ?? "—"}</Td>
                    <Td>{e.hasPhoto ? <Badge tone="green">on file</Badge> : <Badge tone="gray">none</Badge>}</Td>
                    <Td>
                      {rs?.status === "working" ? (
                        <span className="inline-flex items-center gap-1 text-[12px] text-gray-500"><Loader2 size={12} className="animate-spin" /> working…</span>
                      ) : rs?.status === "error" ? (
                        <span className="inline-flex items-center gap-1 text-[12px] text-red-600" title={rs.message}><AlertTriangle size={12} /> {rs.message}</span>
                      ) : e.hasFace || rs?.status === "done" ? (
                        <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700"><CheckCircle2 size={12} /> enrolled</span>
                      ) : (
                        <Badge tone="amber">not enrolled</Badge>
                      )}
                    </Td>
                    <Td right>
                      <span className="flex justify-end gap-1">
                        {e.hasPhoto && !e.hasFace && (
                          <button className="btn-secondary" disabled={engineState !== "ready" || rs?.status === "working"} onClick={() => void handleEnrollOne(e.id)}>
                            <ScanFace size={13} /> Enrol
                          </button>
                        )}
                        <label className="btn-secondary cursor-pointer">
                          <Upload size={13} /> Upload
                          <input type="file" accept="image/*" capture="user" className="hidden" onChange={(ev) => void handleUpload(e.id, ev.target.files?.[0])} />
                        </label>
                        {e.hasFace && (
                          <button className="btn-ghost text-red-600" onClick={() => void handleRemove(e.id)} title="Remove face">
                            <Trash2 size={13} />
                          </button>
                        )}
                      </span>
                    </Td>
                  </tr>
                );
              })}
              {!paged.page.length && <tr><Td colSpan={5}><Empty>No employees match.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>
    </div>
  );
}
