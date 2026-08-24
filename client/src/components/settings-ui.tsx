import { Lock } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Chrome shared by every settings section, matching Zoho's settings pages:
 * an 18px title with the primary action on the right, then a full-bleed table
 * on white — no card, no border, no shadow around it.
 */
export function SettingsHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-6">
      <div>
        <h2 className="text-[18px] font-semibold text-[#212529]">{title}</h2>
        {description && (
          <p className="mt-1 max-w-3xl text-[13px] text-gray-500">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function SettingsTable({
  columns,
  children,
}: {
  columns: Array<{ label: string; align?: "left" | "right"; width?: string }>;
  children: ReactNode;
}) {
  return (
    <table className="w-full">
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.label}
              className={`s-th ${c.align === "right" ? "text-right" : ""} ${c.width ?? ""}`}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-10 text-center text-[13px] text-gray-500">
        {children}
      </td>
    </tr>
  );
}

type Tone = "green" | "gray" | "amber" | "red";

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip-outline">{children}</span>;
}

/**
 * A row's name cell. Editable rows read as a link; locked ones stay black with
 * a padlock, which is how Zoho signals "built in, look but don't touch".
 */
export function NameCell({
  name,
  locked,
  onClick,
  sub,
  after,
}: {
  name: string;
  locked?: boolean;
  onClick?: () => void;
  sub?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        {locked || !onClick ? (
          <span className="text-[13px] text-gray-900">{name}</span>
        ) : (
          <button onClick={onClick} className="s-link">
            {name}
          </button>
        )}
        {locked && <Lock size={12} className="text-gray-400" aria-label="Built in" />}
        {after}
      </div>
      {sub && <div className="mt-0.5 text-[12px] text-gray-500">{sub}</div>}
    </div>
  );
}

/** Right-aligned inline row actions, muted until hovered. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 justify-end gap-4 whitespace-nowrap text-[13px]">{children}</div>
  );
}

export function RowAction({
  onClick,
  children,
  tone = "default",
}: {
  onClick: () => void;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      className={
        tone === "danger"
          ? "text-gray-500 hover:text-red-600 hover:underline"
          : "text-[#e06d05] hover:underline"
      }
    >
      {children}
    </button>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "info" | "warn" | "error" | "success";
  children: ReactNode;
}) {
  const cls = {
    info: "border-gray-200 bg-gray-50 text-gray-700",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
    error: "border-red-200 bg-red-50 text-red-700",
    success: "border-green-200 bg-green-50 text-green-700",
  }[tone];
  return <div className={`mb-3 rounded-md border px-3 py-2 text-[13px] ${cls}`}>{children}</div>;
}

/** Modal shell — settings dialogs all share this frame. */
export function Modal({
  title,
  children,
  onClose,
  footer,
  width = "w-[520px]",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer: ReactNode;
  width?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className={`${width} rounded-lg bg-white shadow-xl`}>
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-[15px] font-semibold text-[#212529]">{title}</h2>
          <button onClick={onClose} className="text-xl leading-none text-gray-400 hover:text-gray-700">
            ×
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        <footer className="flex justify-end gap-2 border-t px-5 py-3">{footer}</footer>
      </div>
    </div>
  );
}
