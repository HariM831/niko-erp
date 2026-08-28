import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate } from "../api";

interface Lock {
  module: string;
  lockedThrough: string | null;
  reason: string | null;
}

const MODULE_LABEL: Record<string, string> = {
  sales: "Sales",
  purchases: "Purchases",
  banking: "Banking",
  accountant: "Accountant",
};

const MODULE_BLURB: Record<string, string> = {
  sales: "Invoices, payments received and credit notes.",
  purchases: "Bills, payments made, vendor credits and expenses.",
  banking: "Bank entries, transfers and categorised statement lines.",
  accountant: "Manual journals and other adjusting entries.",
};

/**
 * Zoho-style per-module transaction locking. Locking a module refuses any
 * posting, edit or void dated on or before the lock date — enforced in the
 * posting engine, not just hidden in the UI.
 */
export function TransactionLockingPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [applyToAll, setApplyToAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: locks } = useQuery({
    queryKey: ["transaction-locks"],
    queryFn: () => api<Lock[]>("/api/accounting/transaction-locks"),
  });

  const save = useMutation({
    mutationFn: (vars: { module: string; lockedThrough: string | null; reason?: string; applyToAll?: boolean }) =>
      api(`/api/accounting/transaction-locks/${vars.module}`, {
        method: "PUT",
        body: { lockedThrough: vars.lockedThrough, reason: vars.reason, applyToAll: vars.applyToAll },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["transaction-locks"] });
      setEditing(null);
      setDate("");
      setReason("");
      setApplyToAll(false);
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not save"),
  });

  const startEdit = (lock: Lock) => {
    setEditing(lock.module);
    setDate(lock.lockedThrough ?? new Date().toISOString().slice(0, 10));
    setReason(lock.reason ?? "");
    setApplyToAll(false);
    setError(null);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="page-header px-6 py-3.5">
        <h1 className="text-lg font-semibold">Transaction Locking</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && <p className="mb-4 max-w-3xl rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="max-w-3xl divide-y divide-gray-100 rounded-xl border bg-white">
          {locks?.map((lock) => (
            <div key={lock.module} className="p-5">
              <div className="flex items-start justify-between gap-6">
                <div>
                  <h2 className="text-sm font-semibold">{MODULE_LABEL[lock.module]}</h2>
                  <p className="mt-0.5 text-xs text-gray-500">{MODULE_BLURB[lock.module]}</p>
                  <p className="mt-2 text-[13px]">
                    {lock.lockedThrough ? (
                      <>
                        <span className="font-medium text-amber-700">
                          Locked through {formatDate(lock.lockedThrough)}
                        </span>
                        {lock.reason && <span className="text-gray-500"> — {lock.reason}</span>}
                      </>
                    ) : (
                      <span className="text-gray-500">You have not locked the transactions in this module.</span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {lock.lockedThrough && (
                    <button
                      onClick={() => save.mutate({ module: lock.module, lockedThrough: null })}
                      disabled={save.isPending}
                      className="btn-secondary"
                    >
                      Unlock
                    </button>
                  )}
                  <button onClick={() => startEdit(lock)} className="btn-primary">
                    {lock.lockedThrough ? "Change" : "Lock"}
                  </button>
                </div>
              </div>

              {editing === lock.module && (
                <div className="mt-4 rounded-lg bg-gray-50 p-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <label className="label-required">Lock transactions on or before *</label>
                      <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        className="input w-44"
                      />
                    </div>
                    <div className="min-w-64 flex-1">
                      <label className="label">Reason</label>
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. FY 2025-26 audited and filed"
                        className="input"
                      />
                    </div>
                    <button
                      onClick={() =>
                        save.mutate({
                          module: lock.module,
                          lockedThrough: date,
                          reason: reason || undefined,
                          applyToAll,
                        })
                      }
                      disabled={save.isPending || !date}
                      className="btn-primary"
                    >
                      Save
                    </button>
                    <button onClick={() => setEditing(null)} className="text-[13px] text-gray-500 hover:underline">
                      Cancel
                    </button>
                  </div>
                  <label className="mt-3 flex items-center gap-2 text-[13px] text-gray-700">
                    <input
                      type="checkbox"
                      checked={applyToAll}
                      onChange={(e) => setApplyToAll(e.target.checked)}
                      className="accent-brand-500"
                    />
                    Apply this date to Sales, Purchases, Banking and Accountant at once
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
