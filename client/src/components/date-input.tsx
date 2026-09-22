/**
 * The one date box, everywhere a date is typed or picked.
 *
 * The browser's own `<input type="date">` draws itself per browser and per
 * locale — "dd-mm-yyyy" with a calendar glyph in Edge, a different order in
 * Chrome on an American laptop, a wheel on a phone — and in a narrow column it
 * squeezes the digits under its own icon. Zoho uses a plain box that reads
 * 22/09/2026 and opens a small month calendar under it; niko does the same, in
 * one place, so every date field in the app looks and behaves alike.
 *
 * The value in and out is "YYYY-MM-DD", exactly what the native input gave, so
 * a form's state and its API calls are unchanged. The box shows and accepts
 * dd/MM/yyyy; typing is parsed when the box is left or Enter is pressed, and
 * "2/9/26", "02-09-2026" and "02.09.2026" all read as 2 Sep 2026. Something that
 * is not a date is put back to what it was rather than saved half-typed.
 *
 * `onChange` is handed an event-shaped `{ target: { value } }` so the box drops
 * in wherever `<input type="date" onChange={(e) => …e.target.value…}>` stood,
 * and handlers written for the native input keep working untouched.
 */
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { localYmd } from "../lib/utils";
import { useFloatingPanel } from "./floating";

export interface DateChange {
  target: { value: string };
}

interface Props {
  value: string | null | undefined;
  onChange?: (e: DateChange) => void;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Earliest and latest pickable day, "YYYY-MM-DD", as on the native input. */
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

/** "2026-09-22" → "22/09/2026"; anything else → "". */
function show(v: string | null | undefined) {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** What was typed → "YYYY-MM-DD", or null if it names no real day. */
function parse(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]) - 1;
  let y = Number(m[3]);
  if (m[3]!.length === 2) y += 2000;
  const t = new Date(y, mo, d);
  if (t.getFullYear() !== y || t.getMonth() !== mo || t.getDate() !== d) return null;
  return ymd(y, mo, d);
}

export function DateInput({
  value,
  onChange,
  className,
  style,
  placeholder = "dd/MM/yyyy",
  disabled,
  required,
  min,
  max,
  autoFocus,
  id,
  name,
  title,
  onBlur,
  onKeyDown,
  ...rest
}: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(show(value));
  const boxRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { style: panelStyle, host } = useFloatingPanel(open, boxRef, 260);

  // The month on show: the chosen day's, else today's.
  const initial = () => {
    const m = (value ?? "").match(/^(\d{4})-(\d{2})/);
    const now = new Date();
    return m ? { y: Number(m[1]), m: Number(m[2]) - 1 } : { y: now.getFullYear(), m: now.getMonth() };
  };
  const [view, setView] = useState(initial);

  // Follow the value when the form changes it from outside.
  useEffect(() => setText(show(value)), [value]);
  useEffect(() => {
    if (open) setView(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    if (v !== (value ?? "")) onChange?.({ target: { value: v } });
  };

  /** Settle what was typed: a day, blank (cleared), or back to the old value. */
  const commit = () => {
    const t = text.trim();
    if (!t) return emit("");
    const v = parse(t);
    if (v && (!min || v >= min) && (!max || v <= max)) emit(v);
    else setText(show(value));
  };

  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1).getDay();
    const start = new Date(view.y, view.m, 1 - first);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return { v: ymd(d.getFullYear(), d.getMonth(), d.getDate()), day: d.getDate(), inMonth: d.getMonth() === view.m };
    });
  }, [view]);

  const today = localYmd();
  const step = (n: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  return (
    // No box of its own around the input: that leaves the input where
    // the form put it — a flex child with flex-1, a w-36 in a toolbar — as the
    // native one was. The calendar is portalled, so it needs no wrapper either.
    <>
      <input
        {...rest}
        ref={boxRef}
        id={id}
        name={name}
        title={title}
        type="text"
        inputMode="numeric"
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
            // Shut the calendar only — not the dialog the box sits in, which
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
            style={{ ...panelStyle, width: 260 }}
            // Keep focus in the box while a day is clicked, so its blur does
            // not settle the half-typed text first.
            onMouseDown={(e) => e.preventDefault()}
            className="select-none rounded-md border border-gray-200 bg-white p-3 shadow-lg"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <button type="button" onClick={() => step(-1)} className="px-2 text-gray-500 hover:text-gray-900" aria-label="Previous month">
                «
              </button>
              <span className="text-[13px] font-semibold text-gray-800">
                {MONTHS[view.m]} {view.y}
              </span>
              <button type="button" onClick={() => step(1)} className="px-2 text-gray-500 hover:text-gray-900" aria-label="Next month">
                »
              </button>
            </div>
            <div className="grid grid-cols-7 text-center">
              {DAYS.map((d) => (
                <div key={d} className="pb-1 text-[11px] text-red-500">
                  {d}
                </div>
              ))}
              {cells.map((c) => {
                const blocked = (min && c.v < min) || (max && c.v > max);
                const chosen = c.v === value;
                return (
                  <button
                    key={c.v}
                    type="button"
                    disabled={!!blocked}
                    onClick={() => {
                      emit(c.v);
                      setOpen(false);
                    }}
                    className={`m-0.5 h-7 rounded text-[12px] ${
                      chosen
                        ? "bg-brand-500 font-semibold text-white"
                        : blocked
                          ? "text-gray-200"
                          : `${c.inMonth ? "text-gray-700" : "text-gray-300"} hover:bg-brand-50 ${
                              c.v === today ? "ring-1 ring-inset ring-brand-400" : ""
                            }`
                    }`}
                  >
                    {c.day}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between border-t border-gray-100 px-1 pt-2 text-[12px]">
              <button type="button" onClick={() => { emit(today); setOpen(false); }} className="text-brand-600 hover:underline">
                Today
              </button>
              {!required && value && (
                <button type="button" onClick={() => { emit(""); setOpen(false); }} className="text-gray-500 hover:underline">
                  Clear
                </button>
              )}
            </div>
          </div>,
          host,
        )}
    </>
  );
}
