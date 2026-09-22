import { Fragment, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Banner, SettingsHeader } from "../components/settings-ui";

/**
 * Settings → Cost Analysis: which section of the per-egg statement each P&L
 * account belongs to, and the pullet constant.
 *
 * The chart is Zoho's, so the report cannot know its heads by code — this
 * screen is where they are named. An account left unassigned is reported in
 * red on the statement rather than silently dropped; "Excluded" is a decision
 * and is recorded as one.
 */

type Section = "income" | "cogs" | "farm" | "mill" | "packing" | "admin" | "finance" | "excluded";

interface HeadRow {
  accountId: string;
  code: string;
  name: string;
  type: "income" | "expense";
  subtype: string | null;
  section: Section | null;
  /** Last twelve months, credit-positive for income, debit-positive for expense. */
  recent: string;
}

interface Prefs {
  pulletCostPerBird: string;
  eggsPerPulletLife: number;
}

const SECTIONS: Array<{ key: Section | ""; label: string }> = [
  { key: "", label: "Unassigned" },
  { key: "income", label: "Income" },
  { key: "cogs", label: "Cost of goods sold" },
  { key: "farm", label: "Operating — Farm" },
  { key: "mill", label: "Operating — Feed mill" },
  { key: "packing", label: "Packing" },
  { key: "admin", label: "Administrative" },
  { key: "finance", label: "Finance cost" },
  { key: "excluded", label: "Excluded" },
];

const num = (v: string) =>
  Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CostAnalysisSection() {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["cost-analysis-heads"],
    queryFn: () => api<HeadRow[]>("/api/settings/cost-analysis-heads"),
  });
  const { data: prefs } = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api<Prefs>("/api/settings/preferences"),
  });

  const [map, setMap] = useState<Record<string, Section | "">>({});
  const [pullet, setPullet] = useState<Prefs | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hideQuiet, setHideQuiet] = useState(true);

  useEffect(() => {
    if (rows) setMap(Object.fromEntries(rows.map((r) => [r.accountId, r.section ?? ""])));
  }, [rows]);
  useEffect(() => {
    if (prefs) setPullet({ pulletCostPerBird: prefs.pulletCostPerBird, eggsPerPulletLife: prefs.eggsPerPulletLife });
  }, [prefs]);

  const save = async () => {
    if (!pullet) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/settings/cost-analysis-heads", {
        method: "PUT",
        body: {
          heads: Object.entries(map)
            .filter(([, s]) => s !== "")
            .map(([accountId, section]) => ({ accountId, section })),
        },
      });
      await api("/api/settings/preferences", {
        method: "PATCH",
        body: {
          pulletCostPerBird: pullet.pulletCostPerBird,
          eggsPerPulletLife: Number(pullet.eggsPerPulletLife),
        },
      });
      await qc.invalidateQueries({ queryKey: ["cost-analysis-heads"] });
      await qc.invalidateQueries({ queryKey: ["preferences"] });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const visible = (rows ?? []).filter((r) => !hideQuiet || Number(r.recent) !== 0 || map[r.accountId]);
  const unassigned = visible.filter((r) => !map[r.accountId] && Number(r.recent) !== 0).length;

  return (
    <div>
      <SettingsHeader
        title="Cost Analysis"
        actions={
          <button onClick={() => void save()} disabled={busy || !pullet} className="btn-primary">
            Save
          </button>
        }
      />
      {error && <Banner tone="error">{error}</Banner>}
      {saved && <Banner tone="success">Saved.</Banner>}

      <div className="mb-7 max-w-2xl">
        <h3 className="text-[13px] font-medium text-[#212529]">Pullet amortisation</h3>
        <p className="mt-0.5 text-[12px] text-gray-500">
          Charged on every egg produced in place of the chick bill and the rearing feed: cost per bird
          divided by the eggs a bird lays in its life.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-gray-600">
          <span>₹</span>
          <input
            value={pullet?.pulletCostPerBird ?? ""}
            onChange={(e) => {
              setSaved(false);
              setPullet((p) => (p ? { ...p, pulletCostPerBird: e.target.value } : p));
            }}
            className="input w-28"
          />
          <span>per bird, over</span>
          <input
            value={pullet?.eggsPerPulletLife ?? ""}
            onChange={(e) => {
              setSaved(false);
              setPullet((p) => (p ? { ...p, eggsPerPulletLife: Number(e.target.value) || 0 } : p));
            }}
            className="input w-24"
          />
          <span>eggs</span>
          {pullet && Number(pullet.eggsPerPulletLife) > 0 && (
            <span className="text-gray-500">
              = ₹{(Number(pullet.pulletCostPerBird) / Number(pullet.eggsPerPulletLife)).toFixed(3)} per egg
            </span>
          )}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium text-[#212529]">Heads</h3>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Where each account sits on the statement. Raw-material purchases, chicks and the eggs bought
            back from the group companies are excluded: feed is costed from what the houses ate, the pullet
            is the figure above, and the buy-back is a transfer price.
            {unassigned > 0 && (
              <span className="ml-1 font-medium text-red-600">{unassigned} active account(s) unassigned.</span>
            )}
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-gray-700">
          <input type="checkbox" checked={hideQuiet} onChange={(e) => setHideQuiet(e.target.checked)} />
          Hide accounts with nothing in the last 12 months
        </label>
      </div>

      {isLoading && <p className="text-[13px] text-gray-500">Loading…</p>}
      <table className="w-full">
        <thead>
          <tr>
            <th className="s-th w-24">Code</th>
            <th className="s-th">Account</th>
            <th className="s-th w-40 text-right">Last 12 months</th>
            <th className="s-th w-56">Section</th>
          </tr>
        </thead>
        <tbody>
          {(["income", "expense"] as const).map((type) => (
            <Fragment key={type}>
              <tr>
                <td
                  colSpan={4}
                  className="border-b border-gray-100 bg-gray-50/70 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
                >
                  {type}
                </td>
              </tr>
              {visible
                .filter((r) => r.type === type)
                .map((r) => {
                  const s = map[r.accountId] ?? "";
                  const quiet = Number(r.recent) === 0;
                  return (
                    <tr key={r.accountId} className={`s-row ${!s && !quiet ? "bg-red-50/40" : ""}`}>
                      <td className="s-td text-gray-500">{r.code}</td>
                      <td className="s-td">{r.name}</td>
                      <td className="s-td text-right tabular-nums">{num(r.recent)}</td>
                      <td className="s-td">
                        <select
                          value={s}
                          onChange={(e) => {
                            setSaved(false);
                            setMap((m) => ({ ...m, [r.accountId]: e.target.value as Section | "" }));
                          }}
                          className="input h-8 py-0"
                        >
                          {SECTIONS.map((o) => (
                            <option key={o.key} value={o.key}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
