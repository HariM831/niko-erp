/**
 * The one date box, everywhere a date, a month or a time is typed or picked.
 *
 * The browser's own `<input type="date">` (and month, time) draws itself per
 * browser and per locale — "dd-mm-yyyy" with a calendar glyph in Edge, a
 * different order in Chrome on an American laptop, a wheel on a phone — and in
 * a narrow column it squeezes the digits under its own icon. Zoho uses a plain
 * box that reads 22/09/2026 and opens a small picker under it; niko does the
 * same, in one place, so every such field in the app looks and behaves alike.
 *
 * Values in and out are what the native inputs gave — "YYYY-MM-DD",
 * "YYYY-MM", "HH:MM", "YYYY-MM-DDTHH:MM" — so a form's state and its API calls
 * are unchanged. What is typed is settled when the box is left or Enter is
 * pressed; something that names no real date is put back to what it was
 * rather than saved half-typed.
 *
 * `onChange` is handed an event-shaped `{ target: { value } }` so these drop in
 * wherever the native input stood, and handlers written for it — reading
 * `e.target.value` — keep working untouched.
 */
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { localYmd } from "../lib/utils";
import { useFloatingPanel } from "./floating";

export interface DateChange {
  target: { value: string };
}

interface BoxProps {
  value: string | null | undefined;
  onChange?: (e: DateChange) => void;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Earliest and latest pickable value, in the value's own format, as on the native input. */
  min?: string;
  max?: string;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  title?: string;
  "aria-label"?: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const inRange = (v: string, min?: string, max?: string) => (!min || v >= min) && (!max || v <= max);

const NAV = "px-2 text-gray-500 hover:text-gray-900";
const FOOT = "mt-2 flex justify-between border-t border-gray-100 px-1 pt-2 text-[12px]";
const cellClass = (chosen: boolean, blocked: boolean, now: boolean, dim = false) =>
  chosen
    ? "bg-brand-500 font-semibold text-white"
    : blocked
      ? "text-gray-200"
      : `${dim ? "text-gray-300" : "text-gray-700"} hover:bg-brand-50 ${now ? "ring-1 ring-inset ring-brand-400" : ""}`;

/** What a picker's panel is handed: the value, a way to set it, and a way to shut. */
interface PanelCtx {
  value: string;
  pick: (v: string) => void;
  close: () => void;
}

/**
 * The box itself, shared by every picker below: a text input showing the
 * value formatted, a panel portalled under it while it has focus, and the
 * typed text settled on leaving. Each picker supplies only how a value is
 * shown, how typing is read, and what the panel holds.
 */
function PickerBox({
  value,
  onChange,
  className,
  style,
  placeholder,
  disabled,
  required,
  min,
  max,
  autoFocus,
  onBlur,
  onKeyDown,
  show,
  parse,
  panel,
  width,
  inputMode = "numeric",
  ...rest
}: BoxProps & {
  show: (v: string) => string;
  parse: (text: string) => string | null;
  panel: (ctx: PanelCtx) => ReactNode;
  width: number;
  inputMode?: "numeric" | "text";
}) {
  const current = value ?? "";
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(show(current));
  const boxRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { style: panelStyle, host } = useFloatingPanel(open, boxRef, width);

  // Follow the value when the form changes it from outside.
  useEffect(() => setText(show(current)), [current, show]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!boxRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const emit = (v: string) => {
    setText(show(v));
    if (v !== current) onChange?.({ target: { value: v } });
  };

  /** Settle what was typed: a value, blank (cleared), or back to the old one. */
  const commit = () => {
    const t = text.trim();
    if (!t) return emit("");
    const v = parse(t);
    if (v && inRange(v, min, max)) emit(v);
    else setText(show(current));
  };

  return (
    // No box of its own around the input: that leaves the input where the form
    // put it — a flex child with flex-1, a w-36 in a toolbar — as the native one
    // was. The panel is portalled, so it needs no wrapper either.
    <>
      <input
        {...rest}
        ref={boxRef}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        autoFocus={autoFocus}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          commit();
          onBlur?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            setOpen(false);
          } else if (e.key === "Escape" && open) {
            // Shut the panel only — not a dialog the box sits in, which
            // listens for Escape on the document.
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "Tab") {
            setOpen(false);
          }
          onKeyDown?.(e);
        }}
        className={className ?? "input"}
        style={style}
      />
      {open && !disabled && panelStyle && host &&
        createPortal(
          <div
            ref={panelRef}
            style={{ ...panelStyle, width }}
            // Keep focus in the box while the panel is clicked, so its blur
            // does not settle the half-typed text first.
            onMouseDown={(e) => e.preventDefault()}
            className="select-none rounded-md border border-gray-200 bg-white p-3 shadow-lg"
          >
            {panel({
              value: current,
              pick: emit,
              close: () => setOpen(false),
            })}
            {!required && current && (
              <div className="mt-2 flex justify-end border-t border-gray-100 px-1 pt-2 text-[12px]">
                <button type="button" onClick={() => { emit(""); setOpen(false); }} className="text-gray-500 hover:underline">
                  Clear
                </button>
              </div>
            )}
          </div>,
          host,
        )}
    </>
  );
}

// ─── Date ──────────────────────────────────────────────────────────────────

/** "2026-09-22" → "22/09/2026"; anything else → "". */
const showDate = (v: string) => {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

/** "2/9/26", "02-09-2026", "02.09.2026" → "2026-09-02"; null if no real day. */
function parseDate(text: string): string | null {
  const m = text.match(/^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]) - 1;
  let y = Number(m[3]);
  if (m[3]!.length === 2) y += 2000;
  const t = new Date(y, mo, d);
  if (t.getFullYear() !== y || t.getMonth() !== mo || t.getDate() !== d) return null;
  return ymd(y, mo, d);
}

function Calendar({ value, pick, close, min, max }: PanelCtx & { min?: string; max?: string }) {
  const [view, setView] = useState(() => {
    const m = value.match(/^(\d{4})-(\d{2})/);
    const now = new Date();
    return m ? { y: Number(m[1]), m: Number(m[2]) - 1 } : { y: now.getFullYear(), m: now.getMonth() };
  });
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1).getDay();
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(view.y, view.m, 1 - first + i);
      return { v: ymd(d.getFullYear(), d.getMonth(), d.getDate()), day: d.getDate(), inMonth: d.getMonth() === view.m };
    });
  }, [view]);
  const today = localYmd();
  const step = (n: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  const choose = (v: string) => {
    pick(v);
    close();
  };

  return (
    <>
      <div className="mb-2 flex items-center justify-between px-1">
        <button type="button" onClick={() => step(-1)} className={NAV} aria-label="Previous month">«</button>
        <span className="text-[13px] font-semibold text-gray-800">
          {MONTHS[view.m]} {view.y}
        </span>
        <button type="button" onClick={() => step(1)} className={NAV} aria-label="Next month">»</button>
      </div>
      <div className="grid grid-cols-7 text-center">
        {DAYS.map((d) => (
          <div key={d} className="pb-1 text-[11px] text-red-500">{d}</div>
        ))}
        {cells.map((c) => {
          const blocked = !inRange(c.v, min, max);
          return (
            <button
              key={c.v}
              type="button"
              disabled={blocked}
              onClick={() => choose(c.v)}
              className={`m-0.5 h-7 rounded text-[12px] ${cellClass(c.v === value.slice(0, 10), blocked, c.v === today, !c.inMonth)}`}
            >
              {c.day}
            </button>
          );
        })}
      </div>
      {inRange(today, min, max) && (
        <div className={FOOT}>
          <button type="button" onClick={() => choose(today)} className="text-brand-600 hover:underline">Today</button>
        </div>
      )}
    </>
  );
}

export function DateInput(props: BoxProps) {
  return (
    <PickerBox
      placeholder="dd/MM/yyyy"
      {...props}
      show={showDate}
      parse={parseDate}
      width={260}
      panel={(ctx) => <Calendar {...ctx} min={props.min} max={props.max} />}
    />
  );
}

// ─── Month ─────────────────────────────────────────────────────────────────

const SHORT = MONTHS.map((m) => m.slice(0, 3));

/** "2026-09" → "Sep 2026". */
const showMonth = (v: string) => {
  const m = v.match(/^(\d{4})-(\d{2})/);
  return m ? `${SHORT[Number(m[2]) - 1]} ${m[1]}` : "";
};

/** "Sep 2026", "september 26", "9/2026", "09-26" → "2026-09". */
function parseMonth(text: string): string | null {
  let mo: number | undefined;
  let y: number | undefined;
  const named = text.match(/^([a-z]{3,})[\s/.\-,]*(\d{2}|\d{4})$/i);
  const numeric = text.match(/^(\d{1,2})[\s/.\-](\d{2}|\d{4})$/);
  if (named) {
    const i = SHORT.findIndex((s) => named[1]!.toLowerCase().startsWith(s.toLowerCase()));
    if (i < 0) return null;
    mo = i;
    y = Number(named[2]);
  } else if (numeric) {
    mo = Number(numeric[1]) - 1;
    y = Number(numeric[2]);
  } else return null;
  if (y < 100) y += 2000;
  if (mo < 0 || mo > 11) return null;
  return `${y}-${pad(mo + 1)}`;
}

function MonthGrid({ value, pick, close, min, max }: PanelCtx & { min?: string; max?: string }) {
  const [year, setYear] = useState(() => Number(value.slice(0, 4)) || new Date().getFullYear());
  const now = localYmd().slice(0, 7);
  const choose = (v: string) => {
    pick(v);
    close();
  };
  return (
    <>
      <div className="mb-2 flex items-center justify-between px-1">
        <button type="button" onClick={() => setYear((y) => y - 1)} className={NAV} aria-label="Previous year">«</button>
        <span className="text-[13px] font-semibold text-gray-800">{year}</span>
        <button type="button" onClick={() => setYear((y) => y + 1)} className={NAV} aria-label="Next year">»</button>
      </div>
      <div className="grid grid-cols-3 text-center">
        {SHORT.map((s, i) => {
          const v = `${year}-${pad(i + 1)}`;
          const blocked = !inRange(v, min, max);
          return (
            <button
              key={s}
              type="button"
              disabled={blocked}
              onClick={() => choose(v)}
              className={`m-1 h-8 rounded text-[12px] ${cellClass(v === value, blocked, v === now)}`}
            >
              {s}
            </button>
          );
        })}
      </div>
      {inRange(now, min, max) && (
        <div className={FOOT}>
          <button type="button" onClick={() => choose(now)} className="text-brand-600 hover:underline">This month</button>
        </div>
      )}
    </>
  );
}

export function MonthInput(props: BoxProps) {
  return (
    <PickerBox
      placeholder="MMM yyyy"
      inputMode="text"
      {...props}
      show={showMonth}
      parse={parseMonth}
      width={240}
      panel={(ctx) => <MonthGrid {...ctx} min={props.min} max={props.max} />}
    />
  );
}

// ─── Time ──────────────────────────────────────────────────────────────────

/** "07:30" → "07:30 AM", "19:05" → "07:05 PM" — Zoho writes times this way. */
const showTime = (v: string) => {
  const m = v.match(/^(\d{2}):(\d{2})/);
  if (!m) return "";
  const h = Number(m[1]);
  return `${pad(h % 12 || 12)}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
};

/** "7:30 pm", "7.30pm", "19:30", "1930", "7 am" → "19:30" etc.; null if not a time. */
function parseTime(text: string): string | null {
  const m = text.toLowerCase().replace(/\s+/g, "").match(/^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const half = m[3]?.[0];
  if (half) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half === "p" ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** Every quarter of an hour, the list Zoho drops under a time box. */
const QUARTERS = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);

function TimeList({ value, pick, close, min, max }: PanelCtx & { min?: string; max?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  // Open at the chosen time, or at the quarter nearest now.
  useEffect(() => {
    const d = new Date();
    const at = value || `${pad(d.getHours())}:${pad(Math.floor(d.getMinutes() / 15) * 15)}`;
    const i = Math.max(0, QUARTERS.findIndex((q) => q >= at));
    listRef.current?.scrollTo({ top: Math.max(0, i * 30 - 60) });
  }, [value]);
  return (
    <div ref={listRef} className="max-h-60 overflow-y-auto">
      {QUARTERS.filter((q) => inRange(q, min, max)).map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => {
            pick(q);
            close();
          }}
          className={`block h-[30px] w-full rounded px-3 text-left text-[13px] ${cellClass(q === value, false, false)}`}
        >
          {showTime(q)}
        </button>
      ))}
    </div>
  );
}

export function TimeInput(props: BoxProps) {
  return (
    <PickerBox
      placeholder="hh:mm AM"
      inputMode="text"
      {...props}
      show={showTime}
      parse={parseTime}
      width={150}
      panel={(ctx) => <TimeList {...ctx} min={props.min} max={props.max} />}
    />
  );
}

// ─── Date and time ─────────────────────────────────────────────────────────

/**
 * A date and a time side by side, for the one field that holds both (a custom
 * field of type date-time). The value is the native "YYYY-MM-DDTHH:MM"; a date
 * picked without a time is held at midnight, as the native input did.
 */
export function DateTimeInput({ value, onChange, className, disabled }: BoxProps) {
  const [d, t] = (value ?? "").split("T");
  const set = (date: string, time: string) =>
    onChange?.({ target: { value: date ? `${date}T${time || "00:00"}` : "" } });
  return (
    <div className="flex gap-2">
      <DateInput value={d ?? ""} onChange={(e) => set(e.target.value, t ?? "")} className={className} disabled={disabled} />
      <TimeInput value={(t ?? "").slice(0, 5)} onChange={(e) => set(d ?? "", e.target.value)} className={className} disabled={disabled || !d} />
    </div>
  );
}
