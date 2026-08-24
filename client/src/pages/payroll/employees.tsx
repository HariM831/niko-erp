/**
 * Employees — one people table. Salaried staff carry a salary structure,
 * daily-wage workers carry a rate-card role; everything else is shared.
 *
 * The list is the light shape (no photo/docs/descriptor); the editor loads
 * the full row when it opens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, ScanFace, Search, Upload } from "lucide-react";
import { api, formatMoney } from "../../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Avatar, Badge, Empty, EmployeeRow, ErrorBanner, Field, PageHeader, Pager, Spinner, Td, Th, dmy, fileToDataUrl, num, useErr, usePaged,
} from "../../components/payroll/ui";

interface Department { id: string; name: string; isActive: boolean; designations: { id: string; name: string; displayOrder: number; isActive: boolean }[] }
interface WageRole { id: string; name: string; dailyRate: number; isActive: boolean }
interface Shift { id: string; name: string; startTime: string; endTime: string; isActive: boolean }
interface Location { id: string; code: string; name: string }
interface ShiftAssignment { id: string; employeeId: string; shiftId: string; shiftName?: string; shift?: { name: string }; effectiveFrom: string; effectiveTo: string | null; notes: string | null }

interface EmployeeFull {
  id: string;
  empCode: string;
  name: string;
  payType: "salaried" | "daily_wage";
  departmentId: string | null;
  designationId: string | null;
  wageRoleId: string | null;
  locationId: string | null;
  reportingTo: string | null;
  dateOfJoining: string | null;
  dateOfLeaving: string | null;
  contactNumber: string | null;
  email: string | null;
  panNumber: string | null;
  aadharNumber: string | null;
  uanNumber: string | null;
  esiNumber: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  basicSalary: string | number;
  hra: string | number;
  allowances: string | number;
  pfEnabled: boolean;
  esiEnabled: boolean;
  openingCl: number;
  openingSl: number;
  emergencyContactName: string | null;
  emergencyContactNumber: string | null;
  emergencyContactRelation: string | null;
  photoUrl: string | null;
  panDocUrl: string | null;
  aadharDocUrl: string | null;
  faceEnrolledAt: string | null;
  isActive: boolean;
}

type Form = Omit<EmployeeFull, "id" | "faceEnrolledAt" | "basicSalary" | "hra" | "allowances" | "openingCl" | "openingSl"> & {
  basicSalary: string;
  hra: string;
  allowances: string;
  openingCl: string;
  openingSl: string;
};

const blank = (): Form => ({
  empCode: "",
  name: "",
  payType: "salaried",
  departmentId: null,
  designationId: null,
  wageRoleId: null,
  locationId: null,
  reportingTo: null,
  dateOfJoining: null,
  dateOfLeaving: null,
  contactNumber: "",
  email: "",
  panNumber: "",
  aadharNumber: "",
  uanNumber: "",
  esiNumber: "",
  bankName: "",
  bankAccountNumber: "",
  bankIfsc: "",
  basicSalary: "0",
  hra: "0",
  allowances: "0",
  pfEnabled: true,
  esiEnabled: true,
  openingCl: "0",
  openingSl: "0",
  emergencyContactName: "",
  emergencyContactNumber: "",
  emergencyContactRelation: "",
  photoUrl: null,
  panDocUrl: null,
  aadharDocUrl: null,
  isActive: true,
});

const toForm = (e: EmployeeFull): Form => ({
  ...e,
  basicSalary: String(e.basicSalary ?? 0),
  hra: String(e.hra ?? 0),
  allowances: String(e.allowances ?? 0),
  openingCl: String(e.openingCl ?? 0),
  openingSl: String(e.openingSl ?? 0),
});

const str = (v: string | null) => (v && v.trim() ? v.trim() : null);

/** Minimal CSV parser — quoted fields, commas, CRLF. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  const [head = [], ...body] = rows;
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function PayrollEmployeesPage() {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [payType, setPayType] = useState("");
  const [active, setActive] = useState("1");
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (dept) params.set("department", dept);
  if (payType) params.set("payType", payType);
  if (active) params.set("active", active);
  const listQ = useQuery({
    queryKey: ["payroll", "employees", params.toString()],
    queryFn: () => api<EmployeeRow[]>(`/api/payroll/employees?${params}`),
  });
  const deptQ = useQuery({ queryKey: ["payroll", "departments"], queryFn: () => api<Department[]>("/api/payroll/departments") });

  const rows = useMemo(() => [...(listQ.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [listQ.data]);
  const paged = usePaged(rows);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payroll", "employees"] });

  const importM = useMutation({
    mutationFn: (body: Record<string, string>[]) => api<{ created?: number; updated?: number }>("/api/payroll/employees/import", { method: "POST", body }),
    onSuccess: () => { invalidate(); setImportOpen(false); },
    onError: fail,
  });

  const counts = useMemo(() => ({
    salaried: rows.filter((r) => r.payType === "salaried").length,
    wage: rows.filter((r) => r.payType === "daily_wage").length,
    faces: rows.filter((r) => r.hasFace).length,
  }), [rows]);

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Employees" sub={`${rows.length} listed · ${counts.salaried} salaried · ${counts.wage} daily wage · ${counts.faces} with a face`}>
        <Link href="/payroll/face-enrollment" className="btn-secondary"><ScanFace size={14} /> Face enrolment</Link>
        <button className="btn-secondary" onClick={() => setImportOpen(true)}><Upload size={14} /> Import CSV</button>
        <button className="btn-primary" onClick={() => setEditing("new")}><Plus size={14} /> New employee</button>
      </PageHeader>
      <ErrorBanner message={err} onClose={() => setErr(null)} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or code" className="input w-56 pl-8" />
        </div>
        <select value={dept} onChange={(e) => setDept(e.target.value)} className="input w-44">
          <option value="">All departments</option>
          {(deptQ.data ?? []).map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <select value={payType} onChange={(e) => setPayType(e.target.value)} className="input w-36">
          <option value="">All pay types</option>
          <option value="salaried">Salaried</option>
          <option value="daily_wage">Daily wage</option>
        </select>
        <select value={active} onChange={(e) => setActive(e.target.value)} className="input w-32">
          <option value="1">Active</option>
          <option value="0">Inactive</option>
          <option value="">All</option>
        </select>
      </div>

      <div className="table-surface overflow-x-auto">
        {listQ.isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full">
            <thead className="table-head">
              <tr>
                <Th>Employee</Th>
                <Th>Code</Th>
                <Th>Department</Th>
                <Th>Designation / role</Th>
                <Th>Pay</Th>
                <Th right>Gross / rate</Th>
                <Th>Shift</Th>
                <Th>Joined</Th>
                <Th>Phone</Th>
                <Th>Face</Th>
              </tr>
            </thead>
            <tbody>
              {paged.page.map((e) => (
                <tr key={e.id} className="table-row cursor-pointer" onClick={() => setEditing(e.id)}>
                  <Td>
                    <span className="flex items-center gap-2">
                      <Avatar name={e.name} size="sm" src={e.hasPhoto ? `/api/payroll/employees/${e.id}/photo` : null} />
                      <span className="font-medium">{e.name}</span>
                      {!e.isActive && <Badge tone="gray">inactive</Badge>}
                    </span>
                  </Td>
                  <Td className="tabular-nums text-gray-500">{e.empCode}</Td>
                  <Td>{e.department ?? "—"}</Td>
                  <Td>{e.payType === "daily_wage" ? e.wageRole ?? <span className="text-red-600">no role</span> : e.designation ?? "—"}</Td>
                  <Td><Badge tone={e.payType === "salaried" ? "blue" : "gray"}>{e.payType === "salaried" ? "Salaried" : "Daily wage"}</Badge></Td>
                  <Td right>{e.payType === "salaried" ? formatMoney(e.gross) : e.dailyRate != null ? `${formatMoney(e.dailyRate)}/day` : "—"}</Td>
                  <Td>{typeof e.shift === "string" ? e.shift : e.shift?.name ?? "—"}</Td>
                  <Td className="tabular-nums">{dmy(e.dateOfJoining)}</Td>
                  <Td className="tabular-nums">{e.contactNumber ?? "—"}</Td>
                  <Td>{e.hasFace ? <Badge tone="green">enrolled</Badge> : e.hasPhoto ? <Badge tone="amber">photo only</Badge> : <Badge tone="gray">none</Badge>}</Td>
                </tr>
              ))}
              {!paged.page.length && <tr><Td colSpan={10}><Empty>No employees match.</Empty></Td></tr>}
            </tbody>
          </table>
        )}
        <Pager total={paged.total} offset={paged.offset} onChange={paged.setOffset} />
      </div>

      {editing && (
        <EmployeeEditor
          id={editing === "new" ? null : editing}
          departments={deptQ.data ?? []}
          employees={rows}
          onClose={() => setEditing(null)}
          onSaved={() => { invalidate(); }}
        />
      )}

      <Dialog open={importOpen} onOpenChange={(v) => !v && setImportOpen(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Import employees from CSV</DialogTitle></DialogHeader>
          <p className="text-[13px] text-gray-600">
            Header row with any of: <code className="text-[12px]">empCode, name, payType, department, designation, wageRole, location, dateOfJoining, contactNumber, email, basicSalary, hra, allowances, bankName, bankAccountNumber, bankIfsc, panNumber, aadharNumber, uanNumber, esiNumber</code>.
            Rows are upserted by <code>empCode</code>.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            className="mt-3 text-[13px]"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const parsed = parseCsv(await f.text());
                if (!parsed.length) throw new Error("No rows found in the file");
                importM.mutate(parsed);
              } catch (x) { fail(x); }
            }}
          />
          {importM.isPending && <Spinner label="Importing…" />}
          {importM.isError && <ErrorBanner message={(importM.error as Error).message} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── Editor ────────────────────────────────────────────────────────────── */
function EmployeeEditor({ id, departments, employees, onClose, onSaved }: {
  id: string | null;
  departments: Department[];
  employees: EmployeeRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const { err, setErr, fail } = useErr();
  const [form, setForm] = useState<Form>(blank());
  const [section, setSection] = useState<"basic" | "pay" | "ids" | "docs" | "shift">("basic");
  const [faceEnrolledAt, setFaceEnrolledAt] = useState<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const fullQ = useQuery({
    queryKey: ["payroll", "employee", id],
    queryFn: () => api<EmployeeFull>(`/api/payroll/employees/${id}`),
    enabled: !!id,
  });
  useEffect(() => {
    if (fullQ.data) { setForm(toForm(fullQ.data)); setFaceEnrolledAt(fullQ.data.faceEnrolledAt); }
  }, [fullQ.data]);

  const rolesQ = useQuery({ queryKey: ["payroll", "wage-roles"], queryFn: () => api<WageRole[]>("/api/payroll/wage-roles") });
  const locQ = useQuery({ queryKey: ["locations"], queryFn: () => api<Location[]>("/api/locations") });
  const shiftsQ = useQuery({ queryKey: ["payroll", "shifts"], queryFn: () => api<Shift[]>("/api/payroll/shifts") });
  const assignQ = useQuery({
    queryKey: ["payroll", "shift-assignments", id],
    queryFn: () => api<ShiftAssignment[]>(`/api/payroll/shift-assignments?employeeId=${id}`),
    enabled: !!id,
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const designations = departments.find((d) => d.id === form.departmentId)?.designations.filter((x) => x.isActive) ?? [];

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        empCode: form.empCode.trim(),
        name: form.name.trim(),
        contactNumber: str(form.contactNumber),
        email: str(form.email),
        panNumber: str(form.panNumber)?.toUpperCase() ?? null,
        aadharNumber: str(form.aadharNumber),
        uanNumber: str(form.uanNumber),
        esiNumber: str(form.esiNumber),
        bankName: str(form.bankName),
        bankAccountNumber: str(form.bankAccountNumber),
        bankIfsc: str(form.bankIfsc)?.toUpperCase() ?? null,
        emergencyContactName: str(form.emergencyContactName),
        emergencyContactNumber: str(form.emergencyContactNumber),
        emergencyContactRelation: str(form.emergencyContactRelation),
        dateOfJoining: form.dateOfJoining || null,
        dateOfLeaving: form.dateOfLeaving || null,
        departmentId: form.departmentId || null,
        designationId: form.designationId || null,
        wageRoleId: form.payType === "daily_wage" ? form.wageRoleId || null : null,
        locationId: form.locationId || null,
        reportingTo: form.reportingTo || null,
        basicSalary: form.payType === "salaried" ? Number(form.basicSalary) || 0 : 0,
        hra: form.payType === "salaried" ? Number(form.hra) || 0 : 0,
        allowances: form.payType === "salaried" ? Number(form.allowances) || 0 : 0,
        openingCl: Number(form.openingCl) || 0,
        openingSl: Number(form.openingSl) || 0,
      };
      return id
        ? api<EmployeeFull>(`/api/payroll/employees/${id}`, { method: "PATCH", body })
        : api<EmployeeFull>("/api/payroll/employees", { method: "POST", body });
    },
    onSuccess: () => { onSaved(); qc.invalidateQueries({ queryKey: ["payroll", "employee", id] }); onClose(); },
    onError: fail,
  });

  const removeFace = useMutation({
    mutationFn: () => api(`/api/payroll/employees/${id}/face`, { method: "DELETE" }),
    onSuccess: () => { setFaceEnrolledAt(null); onSaved(); },
    onError: fail,
  });

  const [newShift, setNewShift] = useState({ shiftId: "", effectiveFrom: "", notes: "" });
  const assign = useMutation({
    mutationFn: () => api("/api/payroll/shift-assignments", { method: "POST", body: { employeeId: id, ...newShift, notes: str(newShift.notes) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll", "shift-assignments", id] }); onSaved(); setNewShift({ shiftId: "", effectiveFrom: "", notes: "" }); },
    onError: fail,
  });
  const unassign = useMutation({
    mutationFn: (aid: string) => api(`/api/payroll/shift-assignments/${aid}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll", "shift-assignments", id] }); onSaved(); },
    onError: fail,
  });

  const pickFile = async (key: "photoUrl" | "panDocUrl" | "aadharDocUrl", file: File | undefined) => {
    if (!file) return;
    try {
      set(key, await fileToDataUrl(file, key === "photoUrl" ? 512 : 1200));
    } catch (x) { fail(x); }
  };

  const gross = (Number(form.basicSalary) || 0) + (Number(form.hra) || 0) + (Number(form.allowances) || 0);
  const shiftName = (a: ShiftAssignment) => a.shiftName ?? a.shift?.name ?? shiftsQ.data?.find((s) => s.id === a.shiftId)?.name ?? "—";
  const sections: { key: typeof section; label: string }[] = [
    { key: "basic", label: "Basic" },
    { key: "pay", label: "Pay & statutory" },
    { key: "ids", label: "IDs & bank" },
    { key: "docs", label: "Photo & documents" },
    ...(id ? [{ key: "shift" as const, label: "Shift" }] : []),
  ];

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{id ? `Edit ${form.name || "employee"}` : "New employee"}</DialogTitle>
        </DialogHeader>
        <ErrorBanner message={err} onClose={() => setErr(null)} />
        {id && fullQ.isLoading ? (
          <Spinner />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-1 border-b border-gray-200">
              {sections.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setSection(s.key)}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${section === s.key ? "border-brand-500 font-medium text-brand-700" : "border-transparent text-gray-500"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="max-h-[65vh] overflow-y-auto pr-1">
              {section === "basic" && (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  <Field label="Employee code" required>
                    <input className="input" value={form.empCode} onChange={(e) => set("empCode", e.target.value)} />
                  </Field>
                  <Field label="Full name" required className="md:col-span-2">
                    <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
                  </Field>
                  <Field label="Pay type" required>
                    <div className="flex rounded-md bg-gray-100 p-0.5 text-[13px]">
                      {(["salaried", "daily_wage"] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => set("payType", p)}
                          className={`flex-1 rounded px-2 py-1 ${form.payType === p ? "bg-white font-medium shadow-sm" : "text-gray-500"}`}
                        >
                          {p === "salaried" ? "Salaried" : "Daily wage"}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="Department">
                    <select className="input" value={form.departmentId ?? ""} onChange={(e) => { set("departmentId", e.target.value || null); set("designationId", null); }}>
                      <option value="">—</option>
                      {departments.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </Field>
                  {form.payType === "salaried" ? (
                    <Field label="Designation">
                      <select className="input" value={form.designationId ?? ""} onChange={(e) => set("designationId", e.target.value || null)}>
                        <option value="">—</option>
                        {designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </Field>
                  ) : (
                    <Field label="Wage role" required hint="The rate card sets the daily rate">
                      <select className="input" value={form.wageRoleId ?? ""} onChange={(e) => set("wageRoleId", e.target.value || null)}>
                        <option value="">—</option>
                        {(rolesQ.data ?? []).filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{r.name} · {formatMoney(r.dailyRate)}/day</option>)}
                      </select>
                    </Field>
                  )}
                  <Field label="Location">
                    <select className="input" value={form.locationId ?? ""} onChange={(e) => set("locationId", e.target.value || null)}>
                      <option value="">—</option>
                      {(locQ.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Reporting to">
                    <select className="input" value={form.reportingTo ?? ""} onChange={(e) => set("reportingTo", e.target.value || null)}>
                      <option value="">—</option>
                      {employees.filter((e) => e.id !== id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Date of joining">
                    <input type="date" className="input" value={form.dateOfJoining ?? ""} onChange={(e) => set("dateOfJoining", e.target.value || null)} />
                  </Field>
                  <Field label="Date of leaving">
                    <input type="date" className="input" value={form.dateOfLeaving ?? ""} onChange={(e) => set("dateOfLeaving", e.target.value || null)} />
                  </Field>
                  <Field label="Contact number">
                    <input className="input" value={form.contactNumber ?? ""} onChange={(e) => set("contactNumber", e.target.value)} />
                  </Field>
                  <Field label="Email">
                    <input type="email" className="input" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
                  </Field>
                  <Field label="Active">
                    <label className="flex h-8 items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} /> On the rolls
                    </label>
                  </Field>
                  <div className="col-span-full mt-2 text-[11px] font-semibold uppercase text-gray-400">Emergency contact</div>
                  <Field label="Name">
                    <input className="input" value={form.emergencyContactName ?? ""} onChange={(e) => set("emergencyContactName", e.target.value)} />
                  </Field>
                  <Field label="Phone">
                    <input className="input" value={form.emergencyContactNumber ?? ""} onChange={(e) => set("emergencyContactNumber", e.target.value)} />
                  </Field>
                  <Field label="Relationship">
                    <input className="input" value={form.emergencyContactRelation ?? ""} onChange={(e) => set("emergencyContactRelation", e.target.value)} />
                  </Field>
                </div>
              )}

              {section === "pay" && (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {form.payType === "salaried" ? (
                    <>
                      <Field label="Basic salary">
                        <input type="number" className="input tabular-nums" value={form.basicSalary} onChange={(e) => set("basicSalary", e.target.value)} />
                      </Field>
                      <Field label="HRA">
                        <input type="number" className="input tabular-nums" value={form.hra} onChange={(e) => set("hra", e.target.value)} />
                      </Field>
                      <Field label="Allowances">
                        <input type="number" className="input tabular-nums" value={form.allowances} onChange={(e) => set("allowances", e.target.value)} />
                      </Field>
                      <div className="col-span-full text-[13px] text-gray-600">
                        Monthly gross <strong className="tabular-nums">{formatMoney(gross)}</strong>
                      </div>
                    </>
                  ) : (
                    <div className="col-span-full text-[13px] text-gray-600">
                      Daily-wage pay comes from the wage role's rate card: rate × (present + ½ half-days). No HRA or allowances.
                    </div>
                  )}
                  <Field label="PF applicable">
                    <label className="flex h-8 items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={form.pfEnabled} onChange={(e) => set("pfEnabled", e.target.checked)} /> Deduct PF
                    </label>
                  </Field>
                  <Field label="ESI applicable">
                    <label className="flex h-8 items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={form.esiEnabled} onChange={(e) => set("esiEnabled", e.target.checked)} /> Deduct ESI
                    </label>
                  </Field>
                  <div />
                  <Field label="Opening CL (days)">
                    <input type="number" step="0.5" className="input tabular-nums" value={form.openingCl} onChange={(e) => set("openingCl", e.target.value)} />
                  </Field>
                  <Field label="Opening SL (days)">
                    <input type="number" step="0.5" className="input tabular-nums" value={form.openingSl} onChange={(e) => set("openingSl", e.target.value)} />
                  </Field>
                </div>
              )}

              {section === "ids" && (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  <Field label="PAN"><input className="input uppercase" maxLength={10} value={form.panNumber ?? ""} onChange={(e) => set("panNumber", e.target.value)} /></Field>
                  <Field label="Aadhaar"><input className="input tabular-nums" maxLength={12} value={form.aadharNumber ?? ""} onChange={(e) => set("aadharNumber", e.target.value)} /></Field>
                  <Field label="UAN"><input className="input tabular-nums" maxLength={12} value={form.uanNumber ?? ""} onChange={(e) => set("uanNumber", e.target.value)} /></Field>
                  <Field label="ESI number"><input className="input tabular-nums" maxLength={17} value={form.esiNumber ?? ""} onChange={(e) => set("esiNumber", e.target.value)} /></Field>
                  <div className="col-span-full mt-2 text-[11px] font-semibold uppercase text-gray-400">Bank</div>
                  <Field label="Bank name"><input className="input" value={form.bankName ?? ""} onChange={(e) => set("bankName", e.target.value)} /></Field>
                  <Field label="Account number"><input className="input tabular-nums" maxLength={30} value={form.bankAccountNumber ?? ""} onChange={(e) => set("bankAccountNumber", e.target.value)} /></Field>
                  <Field label="IFSC"><input className="input uppercase" maxLength={11} value={form.bankIfsc ?? ""} onChange={(e) => set("bankIfsc", e.target.value)} /></Field>
                </div>
              )}

              {section === "docs" && (
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <div className="label">Photo</div>
                    <div className="flex items-center gap-3">
                      <Avatar src={form.photoUrl} name={form.name || "?"} size="xl" />
                      <div className="space-y-1">
                        <button type="button" className="btn-secondary" onClick={() => photoRef.current?.click()}>Choose…</button>
                        {form.photoUrl && <button type="button" className="btn-ghost" onClick={() => set("photoUrl", null)}>Remove</button>}
                        <input ref={photoRef} type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => void pickFile("photoUrl", e.target.files?.[0])} />
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-gray-400">Resized to 512 px. Used for face enrolment and the gate.</div>
                  </div>
                  <DocField label="PAN card" value={form.panDocUrl} onPick={(f) => void pickFile("panDocUrl", f)} onClear={() => set("panDocUrl", null)} />
                  <DocField label="Aadhaar card" value={form.aadharDocUrl} onPick={(f) => void pickFile("aadharDocUrl", f)} onClear={() => set("aadharDocUrl", null)} />
                  {id && (
                    <div className="col-span-full rounded-md bg-gray-50 px-3 py-2 text-[13px]">
                      <span className="font-medium">Face</span>{" "}
                      {faceEnrolledAt ? (
                        <>
                          <Badge tone="green">enrolled</Badge> <span className="text-gray-500">{dmy(faceEnrolledAt.slice(0, 10))}</span>
                          <button type="button" className="btn-ghost ml-2 text-red-600" disabled={removeFace.isPending} onClick={() => removeFace.mutate()}>Remove face</button>
                        </>
                      ) : (
                        <>
                          <Badge tone="gray">not enrolled</Badge>{" "}
                          <Link href="/payroll/face-enrollment" className="text-brand-600 hover:underline">Enrol on the face page</Link>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {section === "shift" && id && (
                <div className="space-y-3">
                  <div className="table-surface">
                    <table className="w-full">
                      <thead className="table-head"><tr><Th>Shift</Th><Th>From</Th><Th>To</Th><Th>Notes</Th><Th /></tr></thead>
                      <tbody>
                        {(assignQ.data ?? []).map((a) => (
                          <tr key={a.id} className="table-row">
                            <Td>{shiftName(a)}</Td>
                            <Td className="tabular-nums">{dmy(a.effectiveFrom)}</Td>
                            <Td className="tabular-nums">{a.effectiveTo ? dmy(a.effectiveTo) : <Badge tone="green">current</Badge>}</Td>
                            <Td>{a.notes ?? ""}</Td>
                            <Td right><button className="btn-ghost text-red-600" onClick={() => unassign.mutate(a.id)}>Remove</button></Td>
                          </tr>
                        ))}
                        {!assignQ.data?.length && <tr><Td colSpan={5}><Empty>No shift assigned — weekly offs fall back to none.</Empty></Td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Shift">
                      <select className="input" value={newShift.shiftId} onChange={(e) => setNewShift({ ...newShift, shiftId: e.target.value })}>
                        <option value="">—</option>
                        {(shiftsQ.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
                      </select>
                    </Field>
                    <Field label="Effective from">
                      <input type="date" className="input" value={newShift.effectiveFrom} onChange={(e) => setNewShift({ ...newShift, effectiveFrom: e.target.value })} />
                    </Field>
                    <Field label="Notes">
                      <input className="input" value={newShift.notes} onChange={(e) => setNewShift({ ...newShift, notes: e.target.value })} />
                    </Field>
                  </div>
                  <button className="btn-secondary" disabled={!newShift.shiftId || !newShift.effectiveFrom || assign.isPending} onClick={() => assign.mutate()}>
                    Assign shift
                  </button>
                  <div className="text-[11px] text-gray-400">Assigning closes the open assignment the day before.</div>
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={save.isPending || !form.empCode.trim() || !form.name.trim()} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : id ? "Save changes" : "Create employee"}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocField({ label, value, onPick, onClear }: { label: string; value: string | null; onPick: (f: File | undefined) => void; onClear: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex items-center gap-2">
        {value ? (
          value.startsWith("data:image") ? (
            <img src={value} alt="" className="h-16 w-24 rounded object-cover" />
          ) : (
            <span className="text-[12px] text-gray-500">file attached</span>
          )
        ) : (
          <span className="text-[12px] text-gray-400">none</span>
        )}
        <button type="button" className="btn-secondary" onClick={() => ref.current?.click()}>Choose…</button>
        {value && <button type="button" className="btn-ghost" onClick={onClear}>Remove</button>}
        <input ref={ref} type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => onPick(e.target.files?.[0])} />
      </div>
    </div>
  );
}
