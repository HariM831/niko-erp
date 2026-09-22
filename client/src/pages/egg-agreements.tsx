/**
 * Egg agreements — the standing rules the whole order book derives from.
 *
 * An agreement is a schedule, a box count and a spread; never a price. Editing
 * one corrects every future day instantly because nothing is generated from
 * it. Ending one sets its end date — the row stays, because past invoices
 * were priced off its spread and must stay explainable.
 */
import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus } from "lucide-react";
import { api, formatDate } from "../api";
import { filterRows, useAdvancedSearch, type SearchField } from "../components/advanced-search";
import { SearchSelect } from "../components/search-select";
import { localYmd } from "../lib/utils";
import { DateInput } from "../components/date-input";

interface Agreement {
  id: string;
  customerId: string;
  customerName: string;
  schedule: "daily" | "weekdays";
  daysOfWeek: number[] | null;
  boxes: number;
  spreadPerEgg: string;
  startDate: string;
  endDate: string | null;
  status: string;
  notes: string | null;
}

interface Customer {
  id: string;
  name: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const scheduleLabel = (a: Agreement) =>
  a.schedule === "daily" ? "Every day" : (a.daysOfWeek ?? []).map((d) => DAY_NAMES[d]).join(", ");

const spreadLabel = (v: string) => {
  const n = Number(v);
  if (!n) return "benchmark";
  return `benchmark ${n > 0 ? "+" : "−"} ${Math.abs(n).toFixed(2)}`;
};

/**
 * What someone looks for among agreements: a customer's, the live ones, who
 * takes eggs on a Sunday, who is priced above or below the benchmark. Egg
 * grade is absent on purpose — an agreement is boxes, not a grade.
 */
const SEARCH_FIELDS: SearchField[] = [
  { key: "customer", label: "Customer", kind: "contact", contactType: "customer" },
  { key: "status", label: "Status", kind: "select", options: ["active", "paused", "ended"] },
  {
    key: "schedule",
    label: "Schedule",
    kind: "select",
    options: [
      { value: "daily", label: "Every day" },
      { value: "weekdays", label: "Named days" },
    ],
  },
  {
    key: "day",
    label: "Delivers On",
    kind: "select",
    options: DAY_NAMES.map((label, i) => ({ value: String(i), label })),
  },
  { key: "spread", label: "Spread Range (₹/egg)", kind: "numberRange" },
  { key: "boxes", label: "Boxes Range", kind: "numberRange" },
  { key: "start", label: "Start Date", kind: "dateRange" },
  { key: "end", label: "End Date", kind: "dateRange" },
  { key: "notes", label: "Notes", kind: "text" },
];

export function EggAgreementsPage() {
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Agreement | "new" | null>(null);

  const load = () =>
    api<{ agreements: Agreement[] }>("/api/sales/eggs/agreements")
      .then((d) => setAgreements(d.agreements))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    api<{ customers: Customer[] }>("/api/sales/eggs/customers").then((d) => setCustomers(d.customers));
  }, []);

  // Every agreement is already here, so the search filters on the client.
  const adv = useAdvancedSearch("Egg agreements", SEARCH_FIELDS);
  const shown = filterRows(agreements, SEARCH_FIELDS, adv.criteria, (a, key) => {
    switch (key) {
      case "customer":
        return a.customerId;
      case "status":
        return a.status;
      case "schedule":
        return a.schedule;
      case "day":
        // A daily agreement delivers on every day of the week.
        return a.schedule === "daily" ? ["0", "1", "2", "3", "4", "5", "6"] : (a.daysOfWeek ?? []).map(String);
      case "spread":
        return Number(a.spreadPerEgg);
      case "boxes":
        return a.boxes;
      case "start":
        return a.startDate;
      case "end":
        return a.endDate;
      case "notes":
        return a.notes;
    }
  });

  return (
    <div className="p-4 md:p-6">
      <div className="page-header -mx-4 px-4 py-3 md:-mx-6 md:px-6 mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Egg agreements</h1>
          </div>
        <div className="flex items-center gap-2">
          {adv.button}
          <button
            onClick={() => setEditing("new")}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New agreement
          </button>
        </div>
      </div>
      {adv.dialog}

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">reading…</div>
      ) : (
        <div className="table-surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="table-head">
              <tr>
                <th className="table-th text-left">Customer</th>
                <th className="table-th text-left">Schedule</th>
                <th className="table-th text-right">Boxes</th>
                <th className="table-th text-left">Price</th>
                <th className="table-th text-left">From</th>
                <th className="table-th text-left">Until</th>
                <th className="table-th text-left">Status</th>
                <th className="table-th" />
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id} className={`border-b border-border/60 last:border-0 ${a.status !== "active" ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2 font-medium">{a.customerName}</td>
                  <td className="px-3 py-2">{scheduleLabel(a)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.boxes}</td>
                  <td className="px-3 py-2 text-muted-foreground">{spreadLabel(a.spreadPerEgg)}</td>
                  <td className="px-3 py-2">{formatDate(a.startDate)}</td>
                  <td className="px-3 py-2">{a.endDate ? formatDate(a.endDate) : "—"}</td>
                  <td className="px-3 py-2 capitalize">{a.status}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => setEditing(a)}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    {agreements.length
                      ? "No agreement matches the search."
                      : "No agreements yet. The calendar derives from these — start here."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <AgreementDialog
          agreement={editing === "new" ? null : editing}
          customers={customers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

const inputCls = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

function AgreementDialog({
  agreement,
  customers,
  onClose,
  onSaved,
}: {
  agreement: Agreement | null;
  customers: Customer[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [customerId, setCustomerId] = useState(agreement?.customerId ?? customers[0]?.id ?? "");
  const [schedule, setSchedule] = useState<"daily" | "weekdays">(agreement?.schedule ?? "daily");
  const [days, setDays] = useState<number[]>(agreement?.daysOfWeek ?? []);
  const [boxes, setBoxes] = useState(agreement ? String(agreement.boxes) : "");
  const [spread, setSpread] = useState(agreement ? Number(agreement.spreadPerEgg).toFixed(2) : "0");
  const [startDate, setStartDate] = useState(agreement?.startDate ?? localYmd());
  const [endDate, setEndDate] = useState(agreement?.endDate ?? "");
  const [status, setStatus] = useState(agreement?.status ?? "active");
  const [notes, setNotes] = useState(agreement?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      if (agreement) {
        await api(`/api/sales/eggs/agreements/${agreement.id}`, {
          method: "PATCH",
          body: {
            schedule,
            daysOfWeek: schedule === "daily" ? null : days,
            boxes: Number(boxes),
            spreadPerEgg: Number(spread),
            status: status === "ended" ? undefined : status,
            endDate: endDate || null,
            notes: notes || null,
          },
        });
      } else {
        await api("/api/sales/eggs/agreements", {
          method: "POST",
          body: {
            customerId,
            schedule,
            daysOfWeek: schedule === "daily" ? undefined : days,
            boxes: Number(boxes),
            spreadPerEgg: Number(spread),
            startDate,
            notes: notes || undefined,
          },
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="mt-10 w-full max-w-md rounded-lg bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-lg font-semibold">{agreement ? "Edit agreement" : "New agreement"}</h2>
        <div className="space-y-3">
          {!agreement && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Customer</label>
              <SearchSelect
                value={customerId || null}
                onChange={(id) => id && setCustomerId(id)}
                options={customers.map((c) => ({ id: c.id, label: c.name }))}
                placeholder="Select customer"
                allowClear={false}
                buttonClassName={inputCls}
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Schedule</label>
            <div className="flex gap-2">
              {(["daily", "weekdays"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSchedule(s)}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    schedule === s ? "border-primary bg-primary/10 font-medium text-primary" : "border-border"
                  }`}
                >
                  {s === "daily" ? "Every day" : "Specific days"}
                </button>
              ))}
            </div>
          </div>

          {schedule === "weekdays" && (
            <div className="flex flex-wrap gap-1.5">
              {DAY_NAMES.map((n, i) => (
                <button
                  key={n}
                  onClick={() => setDays(days.includes(i) ? days.filter((d) => d !== i) : [...days, i].sort())}
                  className={`rounded-md border px-2.5 py-1 text-xs ${
                    days.includes(i) ? "border-primary bg-primary/10 font-medium text-primary" : "border-border"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Boxes per delivery</label>
              <input type="number" min="1" value={boxes} onChange={(e) => setBoxes(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Spread (₹/egg vs benchmark)</label>
              <input type="number" step="0.01" value={spread} onChange={(e) => setSpread(e.target.value)} className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {!agreement && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Starts</label>
                <DateInput value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
              </div>
            )}
            {agreement && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
                <SearchSelect
                  value={status}
                  onChange={(id) => id && setStatus(id)}
                  options={[
                    { id: "active", label: "Active" },
                    { id: "paused", label: "Paused" },
                    ...(status === "ended" ? [{ id: "ended", label: "Ended" }] : []),
                  ]}
                  disabled={status === "ended"}
                  allowClear={false}
                  keepOrder
                  buttonClassName={inputCls}
                />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Ends (leave blank while open)
              </label>
              <DateInput value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
          </div>
        </div>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving || !boxes || (schedule === "weekdays" && !days.length)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
