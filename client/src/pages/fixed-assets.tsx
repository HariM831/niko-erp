import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, formatMoney } from "../api";

interface AssetRow {
  id: string;
  number: string;
  name: string;
  status: string;
  acquisitionDate: string;
  cost: string;
  accumulated: string;
  netBookValue: string;
  method: string;
  usefulLifeMonths: number;
  accountCode: string | null;
  accountName: string | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  isGroup: boolean;
  isActive: boolean;
}

interface Summary {
  count: number;
  cost: string;
  accumulated: string;
  netBookValue: string;
  lastRunPeriod: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  fully_depreciated: "Fully depreciated",
  disposed: "Disposed",
};

const STATUS_CLASS: Record<string, string> = {
  active: "bg-green-50 text-green-700",
  fully_depreciated: "bg-gray-100 text-gray-600",
  disposed: "bg-gray-100 text-gray-500",
};

const today = () => new Date().toISOString().slice(0, 10);

const Badge = ({ status }: { status: string }) => (
  <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[status] ?? "bg-gray-100 text-gray-600"}`}>
    {STATUS_LABEL[status] ?? status}
  </span>
);

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg bg-gray-50 px-4 py-3">
    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
    <div className="mt-1 text-[15px] font-medium tabular-nums">{value}</div>
  </div>
);

export function FixedAssetsPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [view, setView] = useState<string>("");
  const [runOpen, setRunOpen] = useState(false);

  const { data: assets, isLoading } = useQuery({
    queryKey: ["assets", view],
    queryFn: () => api<AssetRow[]>(`/api/assets${view ? `?status=${view}` : ""}`),
  });
  const { data: summary } = useQuery({
    queryKey: ["assets-summary"],
    queryFn: () => api<Summary>("/api/assets/summary"),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Fixed Assets</h1>
          <select
            value={view}
            onChange={(e) => setView(e.target.value)}
            className="rounded border border-gray-200 px-2 py-1 text-[13px]"
          >
            <option value="">All assets</option>
            <option value="active">Active</option>
            <option value="fully_depreciated">Fully depreciated</option>
            <option value="disposed">Disposed</option>
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setRunOpen(true)} className="btn-secondary">
            Run Depreciation
          </button>
          <button onClick={() => navigate("/accountant/assets/new")} className="btn-primary">
            + New Asset
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {summary && (
          <div className="mb-5 grid max-w-4xl grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Assets" value={String(summary.count)} />
            <Stat label="Total cost" value={formatMoney(summary.cost)} />
            <Stat label="Accumulated depreciation" value={formatMoney(summary.accumulated)} />
            <Stat label="Net book value" value={formatMoney(summary.netBookValue)} />
          </div>
        )}
        {summary?.lastRunPeriod && (
          <p className="mb-4 text-[13px] text-gray-500">
            Depreciation last charged through {formatDate(summary.lastRunPeriod)}.
          </p>
        )}

        <table className="data-table w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="px-3 py-2 text-left">Asset</th>
              <th className="col-portrait-hide px-3 py-2 text-left">Account</th>
              <th className="col-portrait-hide px-3 py-2 text-left">Acquired</th>
              <th className="col-portrait-hide px-3 py-2 text-right">Cost</th>
              <th className="col-portrait-hide px-3 py-2 text-right">Accumulated</th>
              <th className="px-3 py-2 text-right">Book value</th>
              <th className="col-portrait-hide px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
            {assets?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-gray-500">
                  No assets yet. Register one to start its depreciation schedule.
                </td>
              </tr>
            )}
            {assets?.map((a) => (
              <tr
                key={a.id}
                onClick={() => navigate(`/accountant/assets/${a.id}`)}
                className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
              >
                <td className="px-3 py-2">
                  <span className="text-brand-600">{a.number}</span>
                  <span className="ml-2">{a.name}</span>
                </td>
                <td className="col-portrait-hide px-3 py-2 text-gray-500">
                  {a.accountCode ? `${a.accountCode} · ${a.accountName}` : "—"}
                </td>
                <td className="col-portrait-hide px-3 py-2">{formatDate(a.acquisitionDate)}</td>
                <td className="col-portrait-hide px-3 py-2 text-right tabular-nums">{formatMoney(a.cost)}</td>
                <td className="col-portrait-hide px-3 py-2 text-right tabular-nums">{formatMoney(a.accumulated)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(a.netBookValue)}</td>
                <td className="col-portrait-hide px-3 py-2">
                  <Badge status={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {runOpen && (
        <RunDepreciationDialog
          onClose={() => setRunOpen(false)}
          onDone={() => {
            setRunOpen(false);
            qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}

interface RunLine {
  assetId: string;
  number: string;
  name: string;
  amount: string;
}

/**
 * Preview then post. The preview runs the real engine with dryRun, so what is
 * listed is exactly what will be charged.
 */
function RunDepreciationDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [periodEnd, setPeriodEnd] = useState(today());
  const [preview, setPreview] = useState<{ periodEnd: string; total: string; lines: RunLine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api(`/api/assets/depreciation/preview?periodEnd=${periodEnd}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/assets/depreciation/run", { method: "POST", body: { periodEnd } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[560px] rounded-lg bg-white shadow-lg">
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-[15px] font-semibold">Run Depreciation</h2>
          <button onClick={onClose} className="text-xl text-gray-400 hover:text-gray-700">
            ×
          </button>
        </header>
        <div className="p-5">
          <div className="mb-4 flex items-end gap-3">
            <div className="flex-1">
              <label className="label-required">Period ending *</label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => {
                  setPeriodEnd(e.target.value);
                  setPreview(null);
                }}
                className="input"
              />
            </div>
            <button onClick={load} disabled={busy} className="btn-secondary">
              Preview
            </button>
          </div>

          {error && (
            <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          )}

          {preview && (
            <div className="mb-4">
              {preview.lines.length === 0 ? (
                <p className="text-[13px] text-gray-500">
                  Nothing to charge for {formatDate(preview.periodEnd)} — every active asset is
                  already up to date.
                </p>
              ) : (
                <>
                  <table className="mb-2 w-full text-[13px]">
                    <thead className="table-head">
                      <tr>
                        <th className="px-3 py-2 text-left">Asset</th>
                        <th className="px-3 py-2 text-right">Charge</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.lines.map((l) => (
                        <tr key={l.assetId} className="border-b border-gray-100">
                          <td className="px-3 py-1.5">
                            <span className="text-gray-500">{l.number}</span> {l.name}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {formatMoney(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex justify-between px-3 text-[13px] font-medium">
                    <span>Total for {formatDate(preview.periodEnd)}</span>
                    <span className="tabular-nums">{formatMoney(preview.total)}</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t px-5 py-3">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={post}
            disabled={busy || !preview || preview.lines.length === 0}
            className="btn-primary"
          >
            Post Depreciation
          </button>
        </footer>
      </div>
    </div>
  );
}

export function FixedAssetNewPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    assetAccountId: "",
    acquisitionDate: today(),
    cost: "",
    salvageValue: "",
    method: "straight_line",
    usefulLifeMonths: "120",
    openingAccumulated: "",
    depreciationStartDate: "",
    serialNumber: "",
    location: "",
    description: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const assetAccounts = useMemo(
    () => (accounts ?? []).filter((a) => a.subtype === "fixed_asset" && !a.isGroup && a.isActive),
    [accounts],
  );

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/assets", {
        method: "POST",
        body: {
          name: form.name,
          description: form.description || undefined,
          assetAccountId: form.assetAccountId,
          acquisitionDate: form.acquisitionDate,
          cost: Number(form.cost || 0).toFixed(2),
          salvageValue: form.salvageValue ? Number(form.salvageValue).toFixed(2) : undefined,
          method: form.method,
          usefulLifeMonths: Number(form.usefulLifeMonths),
          openingAccumulated: form.openingAccumulated
            ? Number(form.openingAccumulated).toFixed(2)
            : undefined,
          depreciationStartDate: form.depreciationStartDate || undefined,
          serialNumber: form.serialNumber || undefined,
          location: form.location || undefined,
        },
      });
      await qc.invalidateQueries();
      navigate("/accountant/assets");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const monthly =
    Number(form.cost || 0) > 0 && Number(form.usefulLifeMonths) > 0 && form.method === "straight_line"
      ? (Number(form.cost) - Number(form.salvageValue || 0)) / Number(form.usefulLifeMonths)
      : null;

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">New Fixed Asset</h1>
        <button
          onClick={() => navigate("/accountant/assets")}
          className="text-xl text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-3xl grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className="label-required">Asset Name *</label>
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} className="input" />
          </div>
          <div>
            <label className="label">Serial / Tag No.</label>
            <input
              value={form.serialNumber}
              onChange={(e) => set({ serialNumber: e.target.value })}
              className="input"
            />
          </div>

          <div className="col-span-2">
            <label className="label-required">Asset Account *</label>
            <select
              value={form.assetAccountId}
              onChange={(e) => set({ assetAccountId: e.target.value })}
              className="input"
            >
              <option value="">Select account…</option>
              {assetAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Location</label>
            <input
              value={form.location}
              onChange={(e) => set({ location: e.target.value })}
              className="input"
            />
          </div>

          <div>
            <label className="label-required">Acquisition Date *</label>
            <input
              type="date"
              value={form.acquisitionDate}
              onChange={(e) => set({ acquisitionDate: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="label-required">Cost *</label>
            <input
              value={form.cost}
              onChange={(e) => set({ cost: e.target.value })}
              placeholder="0.00"
              className="input"
            />
          </div>
          <div>
            <label className="label">Salvage Value</label>
            <input
              value={form.salvageValue}
              onChange={(e) => set({ salvageValue: e.target.value })}
              placeholder="0.00"
              className="input"
            />
          </div>

          <div>
            <label className="label-required">Method *</label>
            <select
              value={form.method}
              onChange={(e) => set({ method: e.target.value })}
              className="input"
            >
              <option value="straight_line">Straight line</option>
              <option value="written_down_value">Written down value</option>
            </select>
          </div>
          <div>
            <label className="label-required">Useful Life (months) *</label>
            <input
              value={form.usefulLifeMonths}
              onChange={(e) => set({ usefulLifeMonths: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="label">Depreciation Starts</label>
            <input
              type="date"
              value={form.depreciationStartDate}
              onChange={(e) => set({ depreciationStartDate: e.target.value })}
              className="input"
            />
            <p className="mt-1 text-[11px] text-gray-400">Defaults to the acquisition date.</p>
          </div>

          <div>
            <label className="label">Depreciation Already Charged</label>
            <input
              value={form.openingAccumulated}
              onChange={(e) => set({ openingAccumulated: e.target.value })}
              placeholder="0.00"
              className="input"
            />
            <p className="mt-1 text-[11px] text-gray-400">
              For assets migrated mid-life. Excluded from the GL.
            </p>
          </div>
          <div className="col-span-2">
            <label className="label">Description</label>
            <input
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              className="input"
            />
          </div>
        </div>

        {monthly !== null && (
          <p className="mt-4 text-[13px] text-gray-600">
            Straight line works out to <span className="font-medium">{formatMoney(monthly)}</span>{" "}
            a month.
          </p>
        )}

        {form.method === "written_down_value" && !Number(form.salvageValue) && (
          <p className="mt-4 max-w-2xl text-[13px] text-amber-700">
            Written down value needs a salvage value above zero to derive a rate — with none set,
            this asset falls back to straight line.
          </p>
        )}

        {error && (
          <div className="mt-4 max-w-2xl rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </div>
        )}
      </div>
      <footer className="flex gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={save}
          disabled={busy || !form.name || !form.assetAccountId || !form.cost}
          className="btn-primary"
        >
          Save
        </button>
        <button onClick={() => navigate("/accountant/assets")} className="btn-secondary">
          Cancel
        </button>
      </footer>
    </div>
  );
}

interface AssetDetail extends AssetRow {
  description: string | null;
  salvageValue: string;
  openingAccumulated: string;
  depreciationStartDate: string;
  serialNumber: string | null;
  location: string | null;
  vendorName: string | null;
  disposalDate: string | null;
  disposalProceeds: string | null;
  account: { code: string; name: string } | null;
  schedule: Array<{ id: string; periodEnd: string; amount: string }>;
}

const Field = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
    <div className="mt-0.5 text-[13px]">{value}</div>
  </div>
);

export function FixedAssetDetailPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [disposeOpen, setDisposeOpen] = useState(false);

  const { data: asset, isLoading } = useQuery({
    queryKey: ["asset", id],
    queryFn: () => api<AssetDetail>(`/api/assets/${id}`),
  });

  if (isLoading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!asset) return <div className="p-8 text-sm text-gray-500">Asset not found.</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="page-header flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">
            {asset.number} · {asset.name}
          </h1>
          <Badge status={asset.status} />
        </div>
        <div className="flex gap-2">
          {asset.status !== "disposed" && (
            <button onClick={() => setDisposeOpen(true)} className="btn-secondary">
              Dispose
            </button>
          )}
          <button
            onClick={() => navigate("/accountant/assets")}
            className="text-xl text-gray-400 hover:text-gray-700"
          >
            ×
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-6 grid max-w-4xl grid-cols-4 gap-3">
          <Stat label="Cost" value={formatMoney(asset.cost)} />
          <Stat label="Accumulated" value={formatMoney(asset.accumulated)} />
          <Stat label="Net book value" value={formatMoney(asset.netBookValue)} />
          <Stat
            label="Method"
            value={asset.method === "straight_line" ? "Straight line" : "Written down value"}
          />
        </div>

        <div className="mb-6 grid max-w-4xl grid-cols-4 gap-5">
          <Field
            label="Asset Account"
            value={asset.account ? `${asset.account.code} · ${asset.account.name}` : "—"}
          />
          <Field label="Acquired" value={formatDate(asset.acquisitionDate)} />
          <Field label="Depreciation Starts" value={formatDate(asset.depreciationStartDate)} />
          <Field label="Useful Life" value={`${asset.usefulLifeMonths} months`} />
          <Field label="Salvage Value" value={formatMoney(asset.salvageValue)} />
          <Field label="Serial / Tag" value={asset.serialNumber || "—"} />
          <Field label="Location" value={asset.location || "—"} />
          <Field label="Vendor" value={asset.vendorName || "—"} />
          {asset.disposalDate && (
            <>
              <Field label="Disposed On" value={formatDate(asset.disposalDate)} />
              <Field label="Proceeds" value={formatMoney(asset.disposalProceeds)} />
            </>
          )}
        </div>

        <h2 className="mb-2 text-sm font-semibold">Depreciation Schedule</h2>
        {asset.schedule.length === 0 ? (
          <p className="text-[13px] text-gray-500">
            Nothing charged yet. Use Run Depreciation on the asset register.
          </p>
        ) : (
          <table className="max-w-xl text-[13px]">
            <thead className="table-head">
              <tr>
                <th className="px-3 py-2 text-left">Period</th>
                <th className="px-3 py-2 text-right">Charge</th>
              </tr>
            </thead>
            <tbody>
              {asset.schedule.map((s) => (
                <tr key={s.id} className="border-b border-gray-100">
                  <td className="px-3 py-1.5">{formatDate(s.periodEnd)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(s.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {disposeOpen && (
        <DisposeDialog
          asset={asset}
          onClose={() => setDisposeOpen(false)}
          onDone={() => {
            setDisposeOpen(false);
            qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}

function DisposeDialog({
  asset,
  onClose,
  onDone,
}: {
  asset: AssetDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const [disposalDate, setDisposalDate] = useState(today());
  const [proceeds, setProceeds] = useState("");
  const [proceedsAccountId, setProceedsAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const cashAccounts = useMemo(
    () =>
      (accounts ?? []).filter(
        (a) => (a.subtype === "bank" || a.subtype === "cash") && !a.isGroup && a.isActive,
      ),
    [accounts],
  );

  const gain = Number(proceeds || 0) - Number(asset.netBookValue);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/assets/${asset.id}/dispose`, {
        method: "POST",
        body: {
          disposalDate,
          proceeds: proceeds ? Number(proceeds).toFixed(2) : undefined,
          proceedsAccountId: proceedsAccountId || undefined,
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disposal failed");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[520px] rounded-lg bg-white shadow-lg">
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-[15px] font-semibold">Dispose {asset.number}</h2>
          <button onClick={onClose} className="text-xl text-gray-400 hover:text-gray-700">
            ×
          </button>
        </header>
        <div className="p-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-required">Disposal Date *</label>
              <input
                type="date"
                value={disposalDate}
                onChange={(e) => setDisposalDate(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="label">Proceeds</label>
              <input
                value={proceeds}
                onChange={(e) => setProceeds(e.target.value)}
                placeholder="0.00"
                className="input"
              />
            </div>
            {Number(proceeds) > 0 && (
              <div className="col-span-2">
                <label className="label-required">Received Into *</label>
                <select
                  value={proceedsAccountId}
                  onChange={(e) => setProceedsAccountId(e.target.value)}
                  className="input"
                >
                  <option value="">Select account…</option>
                  {cashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="mt-4 rounded bg-gray-50 px-4 py-3 text-[13px]">
            <div className="flex justify-between">
              <span className="text-gray-500">Net book value</span>
              <span className="tabular-nums">{formatMoney(asset.netBookValue)}</span>
            </div>
            <div className="mt-1 flex justify-between font-medium">
              <span>{gain >= 0 ? "Gain on disposal" : "Loss on disposal"}</span>
              <span className={`tabular-nums ${gain >= 0 ? "text-green-700" : "text-red-700"}`}>
                {formatMoney(Math.abs(gain))}
              </span>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t px-5 py-3">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || (Number(proceeds) > 0 && !proceedsAccountId)}
            className="btn-primary"
          >
            Dispose Asset
          </button>
        </footer>
      </div>
    </div>
  );
}
