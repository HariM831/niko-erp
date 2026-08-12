import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";

interface StockLevel {
  itemId: string;
  name: string;
  unit: string;
  openingStock: string;
  movements: string;
  quantity: string;
  value: string;
  reorderLevel: string | null;
  belowReorder: boolean;
}

interface AdjustmentRow {
  id: string;
  number: string;
  adjustmentDate: string;
  mode: string;
  reason: string;
  status: string;
  accountName: string | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  isGroup: boolean;
  isActive: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);
const qty = (v: string) => Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 });

export function StockPage() {
  const [, navigate] = useLocation();
  const { data: levels, isLoading } = useQuery({
    queryKey: ["stock"],
    queryFn: () => api<StockLevel[]>("/api/inventory/stock"),
  });

  const totalValue = (levels ?? []).reduce((s, l) => s + Number(l.value), 0);
  const lowCount = (levels ?? []).filter((l) => l.belowReorder).length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Stock on Hand</h1>
        <button onClick={() => navigate("/inventory/adjustments/new")} className="btn-primary">
          + New Adjustment
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-5 grid max-w-2xl grid-cols-3 gap-3">
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Tracked items
            </div>
            <div className="mt-1 text-[15px] font-medium tabular-nums">{levels?.length ?? 0}</div>
          </div>
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Stock value
            </div>
            <div className="mt-1 text-[15px] font-medium tabular-nums">
              {formatMoney(totalValue)}
            </div>
          </div>
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Below reorder level
            </div>
            <div className="mt-1 text-[15px] font-medium tabular-nums">{lowCount}</div>
          </div>
        </div>

        <p className="mb-4 max-w-3xl text-[13px] text-gray-500">
          Quantity is opening stock plus every ledger movement — never a stored number, so it
          cannot drift from the transactions behind it.
        </p>

        <table className="w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="px-3 py-2 text-left">Item</th>
              <th className="px-3 py-2 text-right">Opening</th>
              <th className="px-3 py-2 text-right">Movements</th>
              <th className="px-3 py-2 text-right">On hand</th>
              <th className="px-3 py-2 text-right">Reorder level</th>
              <th className="px-3 py-2 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
            {levels?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-gray-500">
                  No inventory-tracked items. Turn on inventory tracking on an item to see it here.
                </td>
              </tr>
            )}
            {levels?.map((l) => (
              <tr
                key={l.itemId}
                onClick={() => navigate(`/items/${l.itemId}`)}
                className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
              >
                <td className="px-3 py-2">
                  {l.name}
                  {l.belowReorder && (
                    <span className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      Low
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                  {qty(l.openingStock)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                  {Number(l.movements) > 0 ? "+" : ""}
                  {qty(l.movements)}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {qty(l.quantity)} <span className="text-gray-400">{l.unit}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                  {l.reorderLevel ? qty(l.reorderLevel) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function InventoryAdjustmentsPage() {
  const [, navigate] = useLocation();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["inventory-adjustments"],
    queryFn: () => api<AdjustmentRow[]>("/api/inventory/adjustments"),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Inventory Adjustments</h1>
        <button onClick={() => navigate("/inventory/adjustments/new")} className="btn-primary">
          + New Adjustment
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <table className="w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="px-3 py-2 text-left">Number</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-left">Mode</th>
              <th className="px-3 py-2 text-left">Account</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-gray-500">
                  No adjustments yet.
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr
                key={r.id}
                onClick={() => navigate(`/inventory/adjustments/${r.id}`)}
                className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
              >
                <td className="px-3 py-2 text-brand-600">{r.number}</td>
                <td className="px-3 py-2">{formatDate(r.adjustmentDate)}</td>
                <td className="px-3 py-2">{r.reason}</td>
                <td className="px-3 py-2 capitalize text-gray-500">{r.mode}</td>
                <td className="px-3 py-2 text-gray-500">{r.accountName ?? "—"}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                      r.status === "void" ? "bg-gray-100 text-gray-500" : "bg-green-50 text-green-700"
                    }`}
                  >
                    {r.status === "void" ? "Void" : "Adjusted"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface AdjLine {
  itemId: string;
  quantityChange: string;
  valueChange: string;
  notes: string;
}

const emptyLine = (): AdjLine => ({ itemId: "", quantityChange: "", valueChange: "", notes: "" });

export function InventoryAdjustmentNewPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [adjustmentDate, setDate] = useState(today());
  const [mode, setMode] = useState<"quantity" | "value">("quantity");
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const [adjustmentAccountId, setAccount] = useState("");
  const [lines, setLines] = useState<AdjLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: levels } = useQuery({
    queryKey: ["stock"],
    queryFn: () => api<StockLevel[]>("/api/inventory/stock"),
  });
  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const postable = useMemo(
    () =>
      (accounts ?? []).filter(
        (a) => !a.isGroup && a.isActive && (a.type === "expense" || a.type === "income"),
      ),
    [accounts],
  );
  const levelOf = (itemId: string) => (levels ?? []).find((l) => l.itemId === itemId);

  const update = (i: number, patch: Partial<AdjLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const netValue = lines.reduce((s, l) => s + Number(l.valueChange || 0), 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/inventory/adjustments", {
        method: "POST",
        body: {
          adjustmentDate,
          mode,
          reason,
          description: description || undefined,
          adjustmentAccountId,
          lines: lines
            .filter((l) => l.itemId && (Number(l.quantityChange) !== 0 || Number(l.valueChange) !== 0))
            .map((l) => ({
              itemId: l.itemId,
              quantityChange:
                mode === "value" ? undefined : Number(l.quantityChange || 0).toFixed(3),
              valueChange: Number(l.valueChange || 0).toFixed(2),
              notes: l.notes || undefined,
            })),
        },
      });
      await qc.invalidateQueries();
      navigate("/inventory/adjustments");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const valid =
    reason.trim() &&
    adjustmentAccountId &&
    lines.some((l) => l.itemId && (Number(l.quantityChange) !== 0 || Number(l.valueChange) !== 0));

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">New Inventory Adjustment</h1>
        <button
          onClick={() => navigate("/inventory/adjustments")}
          className="text-xl text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-5 grid max-w-3xl grid-cols-3 gap-4">
          <div>
            <label className="label-required">Date *</label>
            <input
              type="date"
              value={adjustmentDate}
              onChange={(e) => setDate(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="label-required">Mode *</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "quantity" | "value")}
              className="input"
            >
              <option value="quantity">Quantity</option>
              <option value="value">Value only</option>
            </select>
          </div>
          <div>
            <label className="label-required">Account *</label>
            <select
              value={adjustmentAccountId}
              onChange={(e) => setAccount(e.target.value)}
              className="input"
            >
              <option value="">Select account…</option>
              {postable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="label-required">Reason *</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input"
            />
          </div>
        </div>

        <p className="mb-3 max-w-3xl text-[13px] text-gray-500">
          {mode === "quantity"
            ? "Enter the change, not the new total — a negative quantity reduces stock. Value is what posts to the ledger."
            : "Value-only revalues stock without moving quantity."}
        </p>

        <table className="mb-3 w-full max-w-4xl text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="border border-[#ebeaf2] px-2 py-2 text-left">Item</th>
              <th className="w-28 border border-[#ebeaf2] px-2 py-2 text-right">On hand</th>
              {mode === "quantity" && (
                <th className="w-32 border border-[#ebeaf2] px-2 py-2 text-right">Qty change</th>
              )}
              <th className="w-32 border border-[#ebeaf2] px-2 py-2 text-right">Value change</th>
              <th className="border border-[#ebeaf2] px-2 py-2 text-left">Notes</th>
              <th className="w-8 border border-[#ebeaf2]" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const level = levelOf(l.itemId);
              const resulting = level
                ? Number(level.quantity) + Number(l.quantityChange || 0)
                : null;
              return (
                <tr key={i}>
                  <td className="border border-[#ebeaf2] px-2 py-1">
                    <select
                      value={l.itemId}
                      onChange={(e) => update(i, { itemId: e.target.value })}
                      className="w-full bg-transparent outline-none"
                    >
                      <option value="">Select item…</option>
                      {levels?.map((lv) => (
                        <option key={lv.itemId} value={lv.itemId}>
                          {lv.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-[#ebeaf2] px-2 py-1 text-right tabular-nums text-gray-500">
                    {level ? `${qty(level.quantity)} ${level.unit}` : "—"}
                  </td>
                  {mode === "quantity" && (
                    <td className="border border-[#ebeaf2] px-2 py-1">
                      <input
                        value={l.quantityChange}
                        onChange={(e) => update(i, { quantityChange: e.target.value })}
                        placeholder="0.000"
                        className={`w-full bg-transparent text-right outline-none tabular-nums ${
                          resulting !== null && resulting < 0 ? "text-red-600" : ""
                        }`}
                      />
                    </td>
                  )}
                  <td className="border border-[#ebeaf2] px-2 py-1">
                    <input
                      value={l.valueChange}
                      onChange={(e) => update(i, { valueChange: e.target.value })}
                      placeholder="0.00"
                      className="w-full bg-transparent text-right tabular-nums outline-none"
                    />
                  </td>
                  <td className="border border-[#ebeaf2] px-2 py-1">
                    <input
                      value={l.notes}
                      onChange={(e) => update(i, { notes: e.target.value })}
                      className="w-full bg-transparent outline-none"
                    />
                  </td>
                  <td className="border border-[#ebeaf2] text-center">
                    {lines.length > 1 && (
                      <button
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                        className="text-gray-400 hover:text-red-600"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <button
          onClick={() => setLines((ls) => [...ls, emptyLine()])}
          className="mb-4 text-[13px] text-brand-600 hover:underline"
        >
          + Add line
        </button>

        {lines.some((l) => {
          const level = levelOf(l.itemId);
          return level && Number(level.quantity) + Number(l.quantityChange || 0) < 0;
        }) && (
          <div className="mb-3 max-w-2xl rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            One or more lines would take stock below zero. The server will refuse this.
          </div>
        )}

        <div className="max-w-md rounded bg-gray-50 px-4 py-3 text-[13px]">
          <div className="flex justify-between font-medium">
            <span>{netValue >= 0 ? "Increase to inventory" : "Reduction of inventory"}</span>
            <span className="tabular-nums">{formatMoney(Math.abs(netValue))}</span>
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            {netValue >= 0
              ? "Debits the inventory account, credits the account chosen above."
              : "Credits the inventory account, debits the account chosen above."}
          </p>
        </div>

        {error && (
          <div className="mt-4 max-w-2xl rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </div>
        )}
      </div>

      <footer className="flex gap-2 border-t bg-white px-6 py-3">
        <button onClick={save} disabled={busy || !valid} className="btn-primary">
          Save
        </button>
        <button onClick={() => navigate("/inventory/adjustments")} className="btn-secondary">
          Cancel
        </button>
      </footer>
    </div>
  );
}

interface AdjustmentDetail extends AdjustmentRow {
  description: string | null;
  journalEntryId: string | null;
  account: { code: string; name: string } | null;
  lines: Array<{
    id: string;
    itemName: string;
    unit: string;
    quantityChange: string;
    valueChange: string;
    notes: string | null;
  }>;
}

export function InventoryAdjustmentDetailPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: adj, isLoading } = useQuery({
    queryKey: ["inventory-adjustment", id],
    queryFn: () => api<AdjustmentDetail>(`/api/inventory/adjustments/${id}`),
  });

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!adj) return <div className="p-8 text-sm text-gray-500">Adjustment not found.</div>;

  const voidIt = async () => {
    if (!confirm(`Void ${adj.number}? Its stock movements and journal entry are reversed.`)) return;
    try {
      await api(`/api/inventory/adjustments/${adj.id}/void`, {
        method: "POST",
        body: { voidDate: today() },
      });
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Void failed");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{adj.number}</h1>
          <span
            className={`rounded px-2 py-0.5 text-[11px] font-medium ${
              adj.status === "void" ? "bg-gray-100 text-gray-500" : "bg-green-50 text-green-700"
            }`}
          >
            {adj.status === "void" ? "Void" : "Adjusted"}
          </span>
        </div>
        <div className="flex gap-2">
          {adj.status !== "void" && (
            <button onClick={voidIt} className="btn-secondary">
              Void
            </button>
          )}
          <button
            onClick={() => navigate("/inventory/adjustments")}
            className="text-xl text-gray-400 hover:text-gray-700"
          >
            ×
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 max-w-2xl rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </div>
        )}

        <div className="mb-6 grid max-w-3xl grid-cols-4 gap-5">
          <Field label="Date" value={formatDate(adj.adjustmentDate)} />
          <Field label="Mode" value={adj.mode === "value" ? "Value only" : "Quantity"} />
          <Field label="Reason" value={adj.reason} />
          <Field
            label="Account"
            value={adj.account ? `${adj.account.code} · ${adj.account.name}` : "—"}
          />
          {adj.description && <Field label="Description" value={adj.description} />}
        </div>

        <table className="w-full max-w-3xl text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="px-3 py-2 text-left">Item</th>
              <th className="px-3 py-2 text-right">Qty change</th>
              <th className="px-3 py-2 text-right">Value change</th>
              <th className="px-3 py-2 text-left">Notes</th>
            </tr>
          </thead>
          <tbody>
            {adj.lines.map((l) => (
              <tr key={l.id} className="border-b border-gray-100">
                <td className="px-3 py-2">{l.itemName}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {Number(l.quantityChange) > 0 ? "+" : ""}
                  {qty(l.quantityChange)} <span className="text-gray-400">{l.unit}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {Number(l.valueChange) > 0 ? "+" : ""}
                  {formatMoney(l.valueChange)}
                </td>
                <td className="px-3 py-2 text-gray-500">{l.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const Field = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
    <div className="mt-0.5 text-[13px]">{value}</div>
  </div>
);
