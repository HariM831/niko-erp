/**
 * An editable set of dated lines.
 *
 * Three things in a flock's life look like single events and are not: the
 * chicks arrive over a week, the move to the layer house takes a week of
 * lorries, and the birds are culled out over several days. Each is a SET of
 * dated lines that nobody can complete on the first morning, so all three are
 * edited the same way — add a line as the next lorry turns up, correct one when
 * the count was wrong, save the whole set back.
 *
 * Replace-not-append is what makes the pattern safe: saving twice leaves one
 * set, so an operator who is unsure whether the last save landed can simply
 * press it again.
 */
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";

export interface Column {
  key: string;
  label: string;
  kind: "date" | "number" | "select";
  /** Options for a select column. */
  options?: Array<{ value: string; label: string }>;
  width?: string;
}

export interface LineSetProps<T extends Record<string, string>> {
  columns: Column[];
  rows: T[];
  blank: T;
  onChange: (rows: T[]) => void;
  addLabel: string;
  /** Rendered under the table — a running total, a warning, whatever fits. */
  summary?: React.ReactNode;
  disabled?: boolean;
}

export function LineSet<T extends Record<string, string>>({
  columns,
  rows,
  blank,
  onChange,
  addLabel,
  summary,
  disabled,
}: LineSetProps<T>) {
  return (
    <div>
      {/* Header and rows share one scroll container so they cannot wrap
          independently and fall out of alignment. The page body never scrolls
          sideways; this box does. */}
      <div className="overflow-x-auto">
        <div className="min-w-max">
          <div className="mb-1 flex gap-2">
            {columns.map((c) => (
              <div
                key={c.key}
                style={{ width: c.width ?? "10rem" }}
                className="text-[11px] uppercase tracking-wide text-gray-500"
              >
                {c.label}
              </div>
            ))}
          </div>
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                {columns.map((c) => (
                  <div key={c.key} style={{ width: c.width ?? "10rem" }}>
                    {c.kind === "select" ? (
                      <select
                        value={row[c.key] ?? ""}
                        disabled={disabled}
                        onChange={(e) =>
                          onChange(
                            rows.map((r, j) =>
                              j === i ? { ...r, [c.key]: e.target.value } : r,
                            ),
                          )
                        }
                        className="input"
                      >
                        <option value="">{c.label}…</option>
                        {c.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={c.kind === "date" ? "date" : "text"}
                        inputMode={c.kind === "number" ? "numeric" : undefined}
                        value={row[c.key] ?? ""}
                        disabled={disabled}
                        placeholder={c.kind === "number" ? c.label : undefined}
                        onChange={(e) =>
                          onChange(
                            rows.map((r, j) =>
                              j === i ? { ...r, [c.key]: e.target.value } : r,
                            ),
                          )
                        }
                        className={`input ${c.kind === "number" ? "text-right" : ""}`}
                      />
                    )}
                  </div>
                ))}
                <button
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  disabled={disabled}
                  className="text-[12px] text-gray-400 hover:text-red-600 disabled:opacity-30"
                  title="Remove this line"
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <button
        onClick={() => onChange([...rows, { ...blank }])}
        disabled={disabled}
        className="mt-2 flex items-center gap-1 text-[12px] text-brand-600 hover:underline disabled:opacity-40"
      >
        <Plus size={12} /> {addLabel}
      </button>

      {summary && (
        <div className="mt-2 text-[12px] text-gray-600">{summary}</div>
      )}
    </div>
  );
}

/** Keeps a local editable copy in step with what the server last returned. */
export function useLineRows<T>(
  source: T[],
  map: (t: T) => Record<string, string>,
) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  useEffect(() => {
    setRows(source.map(map));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  return [rows, setRows] as const;
}
