/**
 * Shared pieces for the Payroll pages — the status chip, the month picker,
 * the employee picker, the pager, a page header and the small helpers every
 * page needs (IST today, month names, time formatting, error banner).
 *
 * No colours of their own except the attendance chip, which is the one place
 * a status colour is defined so the calendar, grid, table and home card agree.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { api } from "../../api";

/* ── Dates ─────────────────────────────────────────────────────────────── */
export const istToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();
export const pad2 = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;
export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";
export const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })
    : "—";
export const dmy = (iso: string | null | undefined) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—";
export const timeAgo = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};
export const num = (v: number | string | null | undefined, d = 0) =>
  Number(v ?? 0).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });

/* ── Attendance status ─────────────────────────────────────────────────── */
export type AttStatus = "P" | "H" | "A" | "WO" | "HO" | "L";
export const STATUS_LABEL: Record<AttStatus, string> = {
  P: "Present",
  H: "Half day",
  A: "Absent",
  WO: "Weekly off",
  HO: "Holiday",
  L: "Leave",
};
/** The one definition of the attendance colours. */
export const STATUS_CLASS: Record<AttStatus, string> = {
  P: "bg-emerald-100 text-emerald-800",
  H: "bg-amber-100 text-amber-800",
  A: "bg-red-100 text-red-700",
  WO: "bg-gray-100 text-gray-500",
  HO: "bg-violet-100 text-violet-700",
  L: "bg-sky-100 text-sky-700",
};
export const ALL_STATUSES: AttStatus[] = ["P", "H", "A", "WO", "HO", "L"];

export function StatusChip({ status, small }: { status: AttStatus | string | null | undefined; small?: boolean }) {
  if (!status) return <span className="text-gray-300">—</span>;
  const cls = STATUS_CLASS[status as AttStatus] ?? "bg-gray-100 text-gray-600";
  return (
    <span
      title={STATUS_LABEL[status as AttStatus]}
      className={`inline-flex items-center justify-center rounded font-semibold tabular-nums ${cls} ${
        small ? "h-5 min-w-[22px] px-1 text-[10px]" : "h-6 min-w-[28px] px-1.5 text-[11px]"
      }`}
    >
      {status}
    </span>
  );
}

export function StatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
      {ALL_STATUSES.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <StatusChip status={s} small /> {STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

/** Generic small badge for pending/approved/… states. */
export function Badge({ tone, children }: { tone?: "green" | "gray" | "amber" | "red" | "blue"; children: ReactNode }) {
  const cls =
    tone === "green"
      ? "badge-green"
      : tone === "amber"
        ? "badge-amber"
        : tone === "red"
          ? "badge-red"
          : tone === "blue"
            ? "bg-brand-50 text-brand-700"
            : "badge-gray";
  return <span className={`badge ${cls}`}>{children}</span>;
}
export const statusTone = (s: string): "green" | "gray" | "amber" | "red" | "blue" =>
  s === "approved" || s === "confirmed" || s === "active" || s === "paid"
    ? "green"
    : s === "pending" || s === "draft"
      ? "amber"
      : s === "rejected" || s === "cancelled"
        ? "red"
        : "gray";

/* ── Page chrome ───────────────────────────────────────────────────────── */
export function PageHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onClose }: { message: string | null; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div className="mb-3 flex items-start justify-between gap-3 rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-700">
      <span>{message}</span>
      {onClose && (
        <button onClick={onClose} className="text-red-400 hover:text-red-700">
          ×
        </button>
      )}
    </div>
  );
}

/** Tiny helper: hold an error string, set from any thrown error. */
export function useErr() {
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : String(e));
  return { err, setErr, fail, clear: () => setErr(null) };
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-gray-400">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-gray-400">{children}</div>;
}

/** A labelled form field. */
export function Field({ label, required, children, hint, className }: { label: string; required?: boolean; children: ReactNode; hint?: string; className?: string }) {
  return (
    <div className={className}>
      <label className={required ? "label-required" : "label"}>
        {label}
        {required ? " *" : ""}
      </label>
      {children}
      {hint && <div className="mt-0.5 text-[11px] text-gray-400">{hint}</div>}
    </div>
  );
}

/** Pill tabs used inside pages (the ui/tabs component works too; this is the compact one). */
export function PillTabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-gray-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
            value === t.key ? "border-brand-500 text-brand-700" : "border-transparent text-gray-500 hover:text-gray-800"
          }`}
        >
          {t.label}
          {t.count != null && t.count > 0 && (
            <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 text-[11px] tabular-nums text-gray-600">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ── Month picker ──────────────────────────────────────────────────────── */
export function useMonth() {
  const t = istToday();
  const [year, setYear] = useState(Number(t.slice(0, 4)));
  const [month, setMonth] = useState(Number(t.slice(5, 7)));
  const shiftBy = (d: number) => {
    let m = month + d;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m);
    setYear(y);
  };
  return { year, month, setYear, setMonth, shiftBy };
}

export function MonthPicker({ year, month, onChange }: { year: number; month: number; onChange: (y: number, m: number) => void }) {
  const shiftBy = (d: number) => {
    let m = month + d;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    onChange(y, m);
  };
  return (
    <div className="inline-flex items-center rounded-md bg-white shadow-sm ring-1 ring-gray-200">
      <button onClick={() => shiftBy(-1)} className="px-1.5 py-1 text-gray-500 hover:bg-gray-100" aria-label="Previous month">
        <ChevronLeft size={15} />
      </button>
      <select value={month} onChange={(e) => onChange(year, Number(e.target.value))} className="bg-transparent py-1 text-[13px] font-medium outline-none">
        {MONTHS_LONG.map((m, i) => (
          <option key={m} value={i + 1}>{m}</option>
        ))}
      </select>
      <input
        type="number"
        value={year}
        onChange={(e) => onChange(Number(e.target.value) || year, month)}
        className="w-16 bg-transparent py-1 text-[13px] font-medium tabular-nums outline-none"
      />
      <button onClick={() => shiftBy(1)} className="px-1.5 py-1 text-gray-500 hover:bg-gray-100" aria-label="Next month">
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

/* ── Employees ─────────────────────────────────────────────────────────── */
export interface EmployeeRow {
  id: string;
  empCode: string;
  name: string;
  payType: "salaried" | "daily_wage";
  department: string | null;
  designation: string | null;
  wageRole: string | null;
  dailyRate: number | null;
  location: string | null;
  dateOfJoining: string | null;
  contactNumber: string | null;
  basicSalary: number;
  hra: number;
  allowances: number;
  gross: number;
  pfEnabled: boolean;
  esiEnabled: boolean;
  isActive: boolean;
  hasPhoto: boolean;
  hasFace: boolean;
  shift: { id: string; name: string } | string | null;
}

/** Active employees in a stable order (by name) — the list every picker reads. */
export function useEmployees(opts: { active?: boolean; all?: boolean } = {}) {
  const q = opts.all ? "" : `?active=${opts.active === false ? 0 : 1}`;
  return useQuery({
    queryKey: ["payroll", "employees", q],
    queryFn: () => api<EmployeeRow[]>(`/api/payroll/employees${q}`),
    select: (rows) => [...rows].sort((a, b) => a.name.localeCompare(b.name)),
    staleTime: 60_000,
  });
}

export function EmployeeSelect({ value, onChange, employees, placeholder = "Select employee", className, allowEmpty }: {
  value: string;
  onChange: (id: string) => void;
  employees?: EmployeeRow[];
  placeholder?: string;
  className?: string;
  allowEmpty?: boolean;
}) {
  const q = useEmployees();
  const list = employees ?? q.data ?? [];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`input ${className ?? ""}`}>
      <option value="">{allowEmpty ? placeholder : `${placeholder}…`}</option>
      {list.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name} · {e.empCode}
        </option>
      ))}
    </select>
  );
}

/* ── Pager — 25 per page ───────────────────────────────────────────────── */
export const PAGE_SIZE = 25;
export function Pager({ total, offset, onChange, pageSize = PAGE_SIZE }: { total: number; offset: number; onChange: (o: number) => void; pageSize?: number }) {
  if (total <= pageSize) return null;
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.ceil(total / pageSize);
  return (
    <div className="flex items-center justify-between px-3 py-2 text-[12px] text-gray-500">
      <span className="tabular-nums">
        {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button disabled={page <= 1} onClick={() => onChange(offset - pageSize)} className="btn-ghost disabled:opacity-40">
          <ChevronLeft size={14} /> Prev
        </button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <button disabled={page >= pages} onClick={() => onChange(offset + pageSize)} className="btn-ghost disabled:opacity-40">
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

/** Client-side slice for small arrays that still deserve the 25/page convention. */
export function usePaged<T>(rows: T[], pageSize = PAGE_SIZE) {
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [rows.length]);
  const page = useMemo(() => rows.slice(offset, offset + pageSize), [rows, offset, pageSize]);
  return { page, offset, setOffset, total: rows.length };
}

/* ── Table ─────────────────────────────────────────────────────────────── */
export function Th({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <th className={`table-th ${right ? "text-right" : ""} ${className ?? ""}`}>{children}</th>;
}
export function Td({ children, right, className, colSpan, onClick, title }: { children?: ReactNode; right?: boolean; className?: string; colSpan?: number; onClick?: () => void; title?: string }) {
  return (
    <td colSpan={colSpan} onClick={onClick} title={title} className={`table-td ${right ? "text-right tabular-nums" : ""} ${className ?? ""}`}>
      {children}
    </td>
  );
}

/** Resize a picked image to a bounded JPEG data URL. */
export async function fileToDataUrl(file: File, maxDim = 512, quality = 0.82): Promise<string> {
  const raw: string = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
  if (!file.type.startsWith("image/")) return raw;
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Could not load image"));
    i.src = raw;
  });
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

export function Avatar({ src, name, size = "md" }: { src?: string | null; name: string; size?: "sm" | "md" | "lg" | "xl" }) {
  const cls = size === "sm" ? "h-6 w-6" : size === "lg" ? "h-12 w-12" : size === "xl" ? "h-20 w-20" : "h-8 w-8";
  return src ? (
    <img src={src} alt="" className={`${cls} shrink-0 rounded-full object-cover`} />
  ) : (
    <span className={`${cls} grid shrink-0 place-items-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-500`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
