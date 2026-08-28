import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";
import { Banner, SettingsHeader } from "../components/settings-ui";

interface OpeningAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  systemKey: string | null;
  debit: string;
  credit: string;
  derived: boolean;
}

interface OpeningState {
  migrationDate: string | null;
  posted: boolean;
  postedEntryId: string | null;
  accounts: OpeningAccount[];
  totalDebit: string;
  totalCredit: string;
  difference: string;
  receivable: string;
  payable: string;
  needsReposting: boolean;
}

const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];
const TYPE_LABEL: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

const num = (v: string | undefined | null) => Number(v || 0);

export function OpeningBalancesSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["opening-balances"],
    queryFn: () => api<OpeningState>("/api/settings/opening-balances"),
  });

  const [migrationDate, setMigrationDate] = useState("");
  const [entries, setEntries] = useState<Record<string, { debit: string; credit: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setMigrationDate(data.migrationDate ?? new Date().toISOString().slice(0, 10));
    const next: Record<string, { debit: string; credit: string }> = {};
    for (const a of data.accounts) {
      if (a.derived) continue;
      next[a.id] = {
        debit: num(a.debit) ? a.debit : "",
        credit: num(a.credit) ? a.credit : "",
      };
    }
    setEntries(next);
  }, [data]);

  const set = (id: string, side: "debit" | "credit", value: string) =>
    setEntries((e) => ({
      ...e,
      // A line is one side or the other; typing in one clears the other.
      [id]: side === "debit" ? { debit: value, credit: "" } : { debit: "", credit: value },
    }));

  const totals = useMemo(() => {
    let debit = num(data?.receivable);
    let credit = num(data?.payable);
    for (const v of Object.values(entries)) {
      debit += num(v.debit);
      credit += num(v.credit);
    }
    return { debit, credit, difference: debit - credit };
  }, [entries, data]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api("/api/settings/opening-balances", {
        method: "PUT",
        body: {
          migrationDate,
          lines: Object.entries(entries)
            .filter(([, v]) => num(v.debit) !== 0 || num(v.credit) !== 0)
            .map(([accountId, v]) => ({
              accountId,
              debit: num(v.debit).toFixed(2),
              credit: num(v.credit).toFixed(2),
            })),
        },
      });
      setSaved(true);
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !data) return <div className="text-[13px] text-gray-500">Loading…</div>;

  const grouped = TYPE_ORDER.map((type) => ({
    type,
    rows: data.accounts.filter((a) => a.type === type),
  })).filter((g) => g.rows.length);

  return (
    <div>
      <SettingsHeader
        title="Opening Balances"
      />

      {error && (
        <Banner tone="error">{error}</Banner>
      )}
      {saved && (
        <Banner tone="success">Opening balances posted.</Banner>
      )}
      {data.needsReposting && (
        <Banner tone="warn">
          A contact&apos;s opening balance has changed since this was posted. Save again to bring
          receivables and payables back in step.
        </Banner>
      )}

      <div className="mb-5 flex items-end gap-4">
        <div className="w-56">
          <label className="label-required">Migration Date *</label>
          <input
            type="date"
            value={migrationDate}
            onChange={(e) => setMigrationDate(e.target.value)}
            className="input"
          />
        </div>
        {data.posted && (
          <p className="pb-2 text-[13px] text-gray-500">
            Posted as at {formatDate(data.migrationDate)}. Saving replaces that entry.
          </p>
        )}
      </div>

      <table className="w-full">
        <thead>
          <tr>
            <th className="s-th">Account</th>
            <th className="s-th w-40 text-right">Debit</th>
            <th className="s-th w-40 text-right">Credit</th>
          </tr>
        </thead>
        <tbody>
          {grouped.map((g) => (
            <Fragment key={g.type}>
              <tr className="bg-gray-50">
                <td colSpan={3} className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  {TYPE_LABEL[g.type]}
                </td>
              </tr>
              {g.rows.map((a) => (
                <tr key={a.id} className="s-row">
                  <td className="s-td">
                    <span className="text-gray-400">{a.code}</span> {a.name}
                    {a.derived && (
                      <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                        from contacts
                      </span>
                    )}
                  </td>
                  {a.derived ? (
                    <>
                      <td className="s-td text-right tabular-nums text-gray-500">
                        {num(a.debit) ? formatMoney(a.debit) : "—"}
                      </td>
                      <td className="s-td text-right tabular-nums text-gray-500">
                        {num(a.credit) ? formatMoney(a.credit) : "—"}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="s-td py-1">
                        <input
                          value={entries[a.id]?.debit ?? ""}
                          onChange={(e) => set(a.id, "debit", e.target.value)}
                          placeholder="0.00"
                          className="w-full rounded border border-transparent px-2 py-1 text-right tabular-nums hover:border-gray-200 focus:border-brand-500 focus:outline-none"
                        />
                      </td>
                      <td className="s-td py-1">
                        <input
                          value={entries[a.id]?.credit ?? ""}
                          onChange={(e) => set(a.id, "credit", e.target.value)}
                          placeholder="0.00"
                          className="w-full rounded border border-transparent px-2 py-1 text-right tabular-nums hover:border-gray-200 focus:border-brand-500 focus:outline-none"
                        />
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-300 font-medium">
            <td className="px-3 py-2 text-right">Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totals.debit)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totals.credit)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-4 max-w-xl rounded bg-gray-50 px-4 py-3 text-[13px]">
        {totals.difference === 0 ? (
          <span className="text-green-700">Debits and credits agree.</span>
        ) : (
          <>
            <div className="flex justify-between font-medium">
              <span>Difference</span>
              <span className="tabular-nums">{formatMoney(Math.abs(totals.difference))}</span>
            </div>
            <p className="mt-1 text-[12px] text-gray-500">
              Posted to Opening Balance Adjustments so the entry balances. Clear it by finding
              the missing figure, then save again.
            </p>
          </>
        )}
      </div>

      <p className="mt-4 max-w-3xl text-[12px] text-gray-500">
        Receivables and payables are not typed here — they come from each customer's and
        vendor's own opening balance, so a contact's ledger and the balance sheet cannot drift
        apart. Set them on the contact.
      </p>

      <div className="mt-5 flex gap-2">
        <button onClick={save} disabled={busy || !migrationDate} className="btn-primary">
          {data.posted ? "Save & Repost" : "Post Opening Balances"}
        </button>
      </div>
    </div>
  );
}
