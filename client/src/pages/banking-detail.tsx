import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Landmark, SlidersHorizontal, UploadCloud, Wallet } from "lucide-react";
import { api, formatDate, formatMoney } from "../api";
import { StatusBadge } from "../components/list-page";

interface BankTxn {
  id: string;
  txnDate: string;
  direction: "debit" | "credit";
  amount: string;
  utr?: string;
  description?: string;
  counterparty?: string;
  matchStatus: string;
}
interface Account {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}
interface Journal {
  id: string;
  entryNumber: string;
  entryDate: string;
  narration: string;
}
interface BankAccountDoc {
  id: string;
  name: string;
  kind: string;
  bankName?: string;
  accountNumber?: string;
}
interface RegisterRow {
  entryId: string;
  entryNumber: string;
  entryDate: string;
  narration: string;
  reference: string | null;
  debit: string;
  credit: string;
  running: string;
  typeLabel: string;
  party: string | null;
  status: "Categorized" | "Matched" | "Manually Added";
  docPath: string;
}

type TabKey = "dashboard" | "uncategorized" | "all";

const tabCls = (active: boolean) =>
  active ? "border-brand-500 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900";

export function BankingDetailPage({ bankAccountId }: { bankAccountId: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("dashboard");
  const [addTxnOpen, setAddTxnOpen] = useState(false);
  const [panel, setPanel] = useState<"import" | "deposit" | "transfer" | null>(null);
  const addTxnRef = useRef<HTMLDivElement>(null);

  const { data: bank } = useQuery({
    queryKey: ["bank-account", bankAccountId],
    queryFn: () => api<BankAccountDoc>(`/api/banking/accounts/${bankAccountId}`),
  });
  const { data: register } = useQuery({
    queryKey: ["bank-register", bankAccountId],
    queryFn: () => api<{ rows: RegisterRow[] }>(`/api/banking/accounts/${bankAccountId}/register`),
  });
  const { data: uncategorized } = useQuery({
    queryKey: ["bank-txns", bankAccountId, "unmatched"],
    queryFn: () => api<BankTxn[]>(`/api/banking/transactions?bankAccountId=${bankAccountId}&matchStatus=unmatched`),
  });

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (addTxnRef.current && !addTxnRef.current.contains(e.target as Node)) setAddTxnOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const currentBalance = register?.rows.length ? register.rows[register.rows.length - 1]!.running : "0.00";
  const uncategorizedCount = uncategorized?.length ?? 0;

  const ADD_TXN_ITEMS = [
    { label: "Expense", path: `/purchases/expenses/new?bankAccountId=${bankAccountId}` },
    { label: "Vendor Payment", path: `/purchases/payments/new?bankAccountId=${bankAccountId}` },
    { label: "Customer Payment", path: `/sales/payments/new?bankAccountId=${bankAccountId}` },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-6 pt-3">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate("/banking")} className="text-gray-400 hover:text-gray-700">←</button>
            <span className="chip h-8 w-8 bg-gray-100 text-gray-500">
              {bank?.kind === "cash" ? <Wallet size={14} /> : <Landmark size={14} />}
            </span>
            <div>
              <h1 className="text-base font-semibold leading-tight">{bank?.name ?? "…"}</h1>
              <div className="text-xs text-gray-500">
                {bank?.bankName ?? bank?.kind} {bank?.accountNumber ? `•••${bank.accountNumber.slice(-4)}` : ""}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setTab("uncategorized")} className="btn-secondary">
              Quick Categorize
            </button>
            <div className="relative" ref={addTxnRef}>
              <button onClick={() => setAddTxnOpen((o) => !o)} className="btn-primary">
                Add Transaction <ChevronDown size={13} />
              </button>
              {addTxnOpen && (
                <div className="absolute right-0 top-9 z-20 w-52 rounded-lg border bg-white py-1 shadow-lg">
                  {ADD_TXN_ITEMS.map((it) => (
                    <button
                      key={it.path}
                      onClick={() => navigate(it.path)}
                      className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-gray-50"
                    >
                      {it.label}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      setAddTxnOpen(false);
                      setPanel("transfer");
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-gray-50"
                  >
                    Transfer to Another Account
                  </button>
                </div>
              )}
            </div>
            <button onClick={() => setPanel(panel === "deposit" ? null : "deposit")} className="btn-secondary">
              Record Deposit
            </button>
            <button onClick={() => navigate(`/banking/${bankAccountId}/edit`)} className="btn-ghost p-2" title="Account Settings">
              ⚙
            </button>
          </div>
        </div>

        <div className="mb-3 flex items-center gap-2 text-[13px]">
          <span className="text-gray-500">Amount in Zoho Books:</span>
          <span className={`text-lg font-bold tabular-nums ${Number(currentBalance) < 0 ? "text-red-600" : ""}`}>
            {formatMoney(currentBalance)}
          </span>
        </div>

        <nav className="flex gap-6 text-[13px]">
          <button onClick={() => setTab("dashboard")} className={`border-b-2 pb-2 text-left ${tabCls(tab === "dashboard")}`}>
            <div>Dashboard</div>
            <div className="text-[11px] font-normal text-gray-400">Account Summary</div>
          </button>
          <button onClick={() => setTab("uncategorized")} className={`border-b-2 pb-2 text-left ${tabCls(tab === "uncategorized")}`}>
            <div>{uncategorizedCount} Uncategorized Transactions</div>
            <div className="text-[11px] font-normal text-gray-400">From Bank Statements</div>
          </button>
          <button onClick={() => setTab("all")} className={`border-b-2 pb-2 text-left ${tabCls(tab === "all")}`}>
            <div>All Transactions</div>
            <div className="text-[11px] font-normal text-gray-400">In Zoho Books</div>
          </button>
        </nav>
      </header>

      {panel === "deposit" && (
        <QuickEntryPanel bankAccountId={bankAccountId} onDone={() => { setPanel(null); void qc.invalidateQueries(); }} onCancel={() => setPanel(null)} />
      )}
      {panel === "transfer" && (
        <TransferPanel bankAccountId={bankAccountId} onDone={() => { setPanel(null); void qc.invalidateQueries(); }} onCancel={() => setPanel(null)} />
      )}

      <div className="flex-1 overflow-y-auto">
        {tab === "dashboard" && (
          <DashboardTab
            rows={register?.rows ?? []}
            onImportStatement={() => {
              setTab("uncategorized");
              setPanel("import");
            }}
            onViewAllTransactions={() => setTab("all")}
          />
        )}
        {tab === "uncategorized" && (
          <UncategorizedTab
            bankAccountId={bankAccountId}
            showImport={panel === "import"}
            onToggleImport={() => setPanel(panel === "import" ? null : "import")}
          />
        )}
        {tab === "all" && <AllTransactionsTab rows={register?.rows ?? []} onOpen={(p) => navigate(p)} />}
      </div>
    </div>
  );
}

// ============================ Dashboard tab ============================

/** Daily closing-balance series, forward-filled across the window so the chart has no gaps. */
function buildDailySeries(rows: RegisterRow[], days: number) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  const startKey = start.toISOString().slice(0, 10);

  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.entryDate, Number(r.running));

  let carry = 0;
  for (const r of rows) {
    if (r.entryDate < startKey) carry = Number(r.running);
    else break;
  }

  const series: Array<{ date: string; value: number }> = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    if (byDate.has(key)) carry = byDate.get(key)!;
    series.push({ date: key, value: carry });
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

function compactMoney(v: number) {
  const abs = Math.abs(v);
  if (abs >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
  if (abs >= 100000) return `${(v / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${(v / 1000).toFixed(0)}K`;
  return v.toFixed(0);
}

function BankSummaryChart({ rows }: { rows: RegisterRow[] }) {
  const series = useMemo(() => buildDailySeries(rows, 30), [rows]);
  const width = 560;
  const height = 160;
  const padL = 44;
  const padB = 20;

  if (rows.length < 2) {
    return <div className="grid h-40 place-items-center text-sm text-gray-400">Not enough activity yet to chart a trend.</div>;
  }

  const values = series.map((s) => s.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const x = (i: number) => padL + (i / (series.length - 1)) * (width - padL - 10);
  const y = (v: number) => height - padB - ((v - min) / range) * (height - padB - 10);

  const linePath = series.map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(series.length - 1).toFixed(1)},${height - padB} L${x(0).toFixed(1)},${height - padB} Z`;
  const ticks = [max, min + range * 0.66, min + range * 0.33, min];
  const labelEvery = Math.ceil(series.length / 8);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={width} y1={y(t)} y2={y(t)} stroke="#ece3d5" strokeWidth={1} />
          <text x={0} y={y(t) + 3} fontSize={10} fill="#9ca3af">{compactMoney(t)}</text>
        </g>
      ))}
      <path d={areaPath} fill="var(--color-brand-500)" opacity={0.1} />
      <path d={linePath} fill="none" stroke="var(--color-brand-600)" strokeWidth={1.75} />
      {series.map((s, i) =>
        i % labelEvery === 0 ? (
          <text key={s.date} x={x(i)} y={height - 4} fontSize={9} fill="#9ca3af" textAnchor="middle">
            {formatDate(s.date).slice(0, 6)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function ActivityCard({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col p-4">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-gray-400">{icon}</span>
        {title}
      </div>
      <p className="mb-3 flex-1 text-xs leading-relaxed text-gray-500">{description}</p>
      {action}
    </div>
  );
}

function DashboardTab({
  rows,
  onImportStatement,
  onViewAllTransactions,
}: {
  rows: RegisterRow[];
  onImportStatement: () => void;
  onViewAllTransactions: () => void;
}) {
  const recent = useMemo(() => [...rows].reverse().slice(0, 5), [rows]);

  return (
    <div className="grid grid-cols-3 gap-6 p-6">
      <div className="col-span-2">
        <h2 className="mb-3 text-[13px] font-semibold text-gray-700">Activity Summary</h2>
        <div className="mb-6 grid grid-cols-3 gap-4">
          <ActivityCard
            icon={<UploadCloud size={16} />}
            title="Last Manual Import"
            description="You can import bank statements of your accounts manually. Your recent import details will be displayed here."
            action={
              <button onClick={onImportStatement} className="text-left text-[13px] font-medium text-brand-600 hover:underline">
                Import Statement
              </button>
            }
          />
          <ActivityCard
            icon={<Landmark size={16} />}
            title="Last Reconciliation"
            description="You can reconcile your transactions to ensure that the transactions in Zoho Books match the transactions in your bank statement."
            action={<span className="text-[13px] text-gray-400">Initiate Reconciliation</span>}
          />
          <ActivityCard
            icon={<SlidersHorizontal size={16} />}
            title="Transaction Rules"
            description="You can identify and categorise your bank transactions based on the criteria you set."
            action={<span className="text-[13px] text-gray-400">+ New Rule</span>}
          />
        </div>

        <div className="card p-4">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-gray-700">Bank Summary</h2>
            <span className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> Closing Balance · Last 30 days
            </span>
          </div>
          <BankSummaryChart rows={rows} />
        </div>
      </div>

      <div className="card p-4">
        <h2 className="mb-3 text-[13px] font-semibold text-gray-700">Recent Transactions</h2>
        {!recent.length ? (
          <p className="text-sm text-gray-400">No transactions yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {recent.map((r, i) => (
              <li key={`${r.entryId}-${i}`} className="py-2.5 text-[13px]">
                <div className="font-medium">
                  {formatMoney(Number(r.debit) > 0 ? r.debit : r.credit)} for {r.typeLabel}
                </div>
                <div className="text-xs text-gray-500">{formatDate(r.entryDate)} · {r.status}</div>
              </li>
            ))}
          </ul>
        )}
        <button onClick={onViewAllTransactions} className="mt-2 text-[13px] font-medium text-brand-600 hover:underline">
          + View More
        </button>
      </div>
    </div>
  );
}

// ============================ All Transactions tab ============================

const STATUS_STYLES: Record<RegisterRow["status"], string> = {
  Categorized: "text-green-600",
  Matched: "text-brand-600",
  "Manually Added": "text-gray-500",
};

function AllTransactionsTab({ rows, onOpen }: { rows: RegisterRow[]; onOpen: (path: string) => void }) {
  const desc = [...rows].reverse();
  if (!desc.length) {
    return <div className="p-12 text-center text-sm text-gray-500">No transactions posted to this account yet.</div>;
  }
  return (
    <table className="w-full text-[13px]">
      <thead className="table-head sticky top-0">
        <tr>
          <th className="border-b border-[#ece3d5] px-4 py-2.5">Date</th>
          <th className="border-b border-[#ece3d5] px-4 py-2.5">Reference#</th>
          <th className="border-b border-[#ece3d5] px-4 py-2.5">Type</th>
          <th className="border-b border-[#ece3d5] px-4 py-2.5">Status</th>
          <th className="border-b border-[#ece3d5] px-4 py-2.5 text-right">Deposits</th>
          <th className="border-b border-[#ece3d5] px-4 py-2.5 text-right">Withdrawals</th>
          <th className="border-b border-[#ece3d5] px-4 py-2.5 text-right">Running Balance</th>
        </tr>
      </thead>
      <tbody>
        {desc.map((r, i) => (
          <tr key={`${r.entryId}-${i}`} onClick={() => onOpen(r.docPath)} className="cursor-pointer bg-white transition-colors hover:bg-gray-50">
            <td className="border-b border-[#ece3d5] px-4 py-2.5 align-top">{formatDate(r.entryDate)}</td>
            <td className="border-b border-[#ece3d5] px-4 py-2.5 align-top text-gray-700">{r.reference ?? "—"}</td>
            <td className="border-b border-[#ece3d5] px-4 py-2.5 align-top">
              <div className="text-gray-800">{r.typeLabel}</div>
              {r.party && <div className="max-w-56 truncate text-xs text-gray-500">{r.party}</div>}
            </td>
            <td className={`border-b border-[#ece3d5] px-4 py-2.5 align-top ${STATUS_STYLES[r.status]}`}>{r.status}</td>
            <td className="border-b border-[#ece3d5] px-4 py-2.5 text-right align-top tabular-nums">
              {Number(r.debit) > 0 ? formatMoney(r.debit) : ""}
            </td>
            <td className="border-b border-[#ece3d5] px-4 py-2.5 text-right align-top tabular-nums">
              {Number(r.credit) > 0 ? formatMoney(r.credit) : ""}
            </td>
            <td className="border-b border-[#ece3d5] px-4 py-2.5 text-right align-top font-medium tabular-nums">
              {formatMoney(r.running)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ============================ Import Statement wizard ============================

/** Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas/newlines, "" escaping. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

/** Bank exports are usually DD/MM/YYYY or DD-MM-YYYY; also accept ISO. Returns null if unparseable. */
function parseFlexibleDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return null;
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type FieldKey = "date" | "description" | "withdrawal" | "deposit" | "reference";
const FIELD_LABELS: Record<FieldKey, string> = {
  date: "Date",
  description: "Description",
  withdrawal: "Withdrawals",
  deposit: "Deposits",
  reference: "Reference Number",
};
const FIELD_HINTS: Record<FieldKey, string[]> = {
  date: ["date"],
  description: ["description", "narration", "particulars", "remarks", "details"],
  withdrawal: ["withdrawal", "debit", "dr amount", "dr."],
  deposit: ["deposit", "credit", "cr amount", "cr."],
  reference: ["reference", "utr", "cheque", "chq", "ref no", "ref."],
};

function guessColumn(headers: string[], key: FieldKey): number | null {
  const lower = headers.map((h) => h.toLowerCase());
  for (const hint of FIELD_HINTS[key]) {
    const idx = lower.findIndex((h) => h.includes(hint));
    if (idx !== -1) return idx;
  }
  return null;
}

type Mapping = Record<FieldKey, number | null>;

interface ParsedTxnRow {
  txnDate: string | null;
  direction: "debit" | "credit" | null;
  amount: number | null;
  utr?: string;
  description?: string;
  valid: boolean;
  reason?: string;
}

function buildTxnRows(data: string[][], mapping: Mapping): ParsedTxnRow[] {
  return data.map((r) => {
    const get = (key: FieldKey) => (mapping[key] !== null ? (r[mapping[key]!] ?? "").trim() : "");
    const txnDate = mapping.date !== null ? parseFlexibleDate(get("date")) : null;
    const withdrawal = mapping.withdrawal !== null ? parseAmount(get("withdrawal")) : null;
    const deposit = mapping.deposit !== null ? parseAmount(get("deposit")) : null;

    let direction: "debit" | "credit" | null = null;
    let amount: number | null = null;
    if (deposit) {
      direction = "credit";
      amount = deposit;
    } else if (withdrawal) {
      direction = "debit";
      amount = withdrawal;
    }

    let reason: string | undefined;
    if (!txnDate) reason = "Unrecognised date";
    else if (!amount) reason = "No withdrawal or deposit amount";

    return {
      txnDate,
      direction,
      amount,
      utr: get("reference") || undefined,
      description: get("description") || undefined,
      valid: !reason,
      reason,
    };
  });
}

function ImportStatementWizard({
  bankAccountId,
  onImported,
  onCancel,
}: {
  bankAccountId: string;
  onImported: (message: string) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"configure" | "map" | "preview">("configure");
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({ date: null, description: null, withdrawal: null, deposit: null, reference: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFile = async (file: File) => {
    setError(null);
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      setError("Couldn't find any data rows in that file.");
      return;
    }
    const [head, ...rows] = parsed;
    setFileName(file.name);
    setHeaders(head!);
    setDataRows(rows);
    setMapping({
      date: guessColumn(head!, "date"),
      description: guessColumn(head!, "description"),
      withdrawal: guessColumn(head!, "withdrawal"),
      deposit: guessColumn(head!, "deposit"),
      reference: guessColumn(head!, "reference"),
    });
  };

  const parsedRows = useMemo(() => buildTxnRows(dataRows, mapping), [dataRows, mapping]);
  const validCount = parsedRows.filter((r) => r.valid).length;

  const runImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const transactions = parsedRows
        .filter((r) => r.valid)
        .map((r) => ({
          txnDate: r.txnDate!,
          direction: r.direction!,
          amount: r.amount!.toFixed(2),
          utr: r.utr,
          description: r.description,
        }));
      const result = (await api("/api/banking/transactions/import", {
        method: "POST",
        body: { bankAccountId, transactions },
      })) as { inserted: number; skipped: number };
      onImported(`Imported ${result.inserted} transactions, skipped ${result.skipped} duplicates.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b bg-gray-50 px-6 py-5">
      <div className="mb-4 flex items-center gap-2 text-[13px] font-medium">
        {(["configure", "map", "preview"] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-gray-300">›</span>}
            <span
              className={`flex items-center gap-1.5 ${step === s ? "text-brand-700" : "text-gray-400"}`}
            >
              <span
                className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${
                  step === s ? "bg-brand-600 text-white" : "bg-gray-200 text-gray-500"
                }`}
              >
                {i + 1}
              </span>
              {s === "configure" ? "Configure" : s === "map" ? "Map Fields" : "Preview"}
            </span>
          </div>
        ))}
      </div>

      {step === "configure" && (
        <div>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files[0];
              if (file) void loadFile(file);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed py-10 text-center transition-colors ${
              dragOver ? "border-brand-400 bg-brand-50" : "border-gray-300 bg-white"
            }`}
          >
            <UploadCloud size={22} className="mb-2 text-gray-400" />
            <div className="text-[13px] text-gray-600">
              {fileName ? <span className="font-medium text-gray-800">{fileName}</span> : "Drag and drop a CSV statement, or click to choose a file"}
            </div>
            <div className="mt-1 text-xs text-gray-400">Maximum file size 1 MB · CSV only</div>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
          </label>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => setStep("map")} disabled={!headers.length} className="btn-primary">
              Next
            </button>
            <button onClick={onCancel} className="text-[13px] text-gray-500 hover:underline">
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "map" && (
        <div>
          <p className="mb-3 text-xs text-gray-500">
            Match each column from <span className="font-medium text-gray-700">{fileName}</span> to a field in Zoho Books-style import. We
            guessed the mapping below — adjust anything that looks wrong.
          </p>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {(Object.keys(FIELD_LABELS) as FieldKey[]).map((key) => (
              <div key={key}>
                <label className={key === "date" ? "label-required" : "label"}>
                  {FIELD_LABELS[key]}
                  {key === "date" ? " *" : ""}
                </label>
                <select
                  value={mapping[key] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [key]: e.target.value === "" ? null : Number(e.target.value) }))}
                  className="input"
                >
                  <option value="">Not in file</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="max-h-40 overflow-auto rounded border bg-white">
            <table className="w-full text-xs">
              <thead className="table-head">
                <tr>{headers.map((h, i) => <th key={i} className="border-b border-[#ece3d5] px-2 py-1.5">{h}</th>)}</tr>
              </thead>
              <tbody>
                {dataRows.slice(0, 4).map((r, i) => (
                  <tr key={i}>
                    {headers.map((_, ci) => <td key={ci} className="border-b border-[#ece3d5] px-2 py-1.5">{r[ci]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => setStep("configure")} className="btn-secondary">Back</button>
            <button onClick={() => setStep("preview")} disabled={mapping.date === null} className="btn-primary">
              Next
            </button>
            <button onClick={onCancel} className="text-[13px] text-gray-500 hover:underline">Cancel</button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div>
          <p className="mb-3 text-[13px]">
            <span className="font-semibold text-green-700">{validCount} of {parsedRows.length} rows</span> will be imported.
            {validCount < parsedRows.length && <span className="text-gray-500"> The rest are highlighted below and will be skipped.</span>}
          </p>
          <div className="max-h-64 overflow-auto rounded border bg-white">
            <table className="w-full text-xs">
              <thead className="table-head sticky top-0">
                <tr>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5">Date</th>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5">Description</th>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5">Reference</th>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5 text-right">Withdrawal</th>
                  <th className="border-b border-[#ece3d5] px-2 py-1.5 text-right">Deposit</th>
                </tr>
              </thead>
              <tbody>
                {parsedRows.map((r, i) => (
                  <tr key={i} className={r.valid ? "" : "bg-red-50"}>
                    <td className="border-b border-[#ece3d5] px-2 py-1.5">{r.txnDate ?? <span className="text-red-500">{r.reason}</span>}</td>
                    <td className="border-b border-[#ece3d5] px-2 py-1.5">{r.description ?? "—"}</td>
                    <td className="border-b border-[#ece3d5] px-2 py-1.5">{r.utr ?? "—"}</td>
                    <td className="border-b border-[#ece3d5] px-2 py-1.5 text-right tabular-nums">
                      {r.direction === "debit" ? r.amount?.toFixed(2) : ""}
                    </td>
                    <td className="border-b border-[#ece3d5] px-2 py-1.5 text-right tabular-nums">
                      {r.direction === "credit" ? r.amount?.toFixed(2) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => setStep("map")} className="btn-secondary">Back</button>
            <button onClick={() => void runImport()} disabled={busy || !validCount} className="btn-primary">
              Import {validCount} Transaction{validCount === 1 ? "" : "s"}
            </button>
            <button onClick={onCancel} className="text-[13px] text-gray-500 hover:underline">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================ Uncategorized tab ============================

function UncategorizedTab({
  bankAccountId,
  showImport,
  onToggleImport,
}: {
  bankAccountId: string;
  showImport: boolean;
  onToggleImport: () => void;
}) {
  const qc = useQueryClient();
  const [subTab, setSubTab] = useState<"unmatched" | "excluded">("unmatched");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [catAccount, setCatAccount] = useState("");
  const [catNarration, setCatNarration] = useState("");
  const [matchJe, setMatchJe] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: txns } = useQuery({
    queryKey: ["bank-txns", bankAccountId, subTab],
    queryFn: () => api<BankTxn[]>(`/api/banking/transactions?bankAccountId=${bankAccountId}&matchStatus=${subTab}`),
  });
  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });
  const { data: journals } = useQuery({
    queryKey: ["journals-recent"],
    queryFn: () => api<Journal[]>("/api/accounting/journals"),
  });

  const refresh = async () => {
    await qc.invalidateQueries();
    setExpanded(null);
    setCatAccount("");
    setCatNarration("");
    setMatchJe("");
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between border-b bg-gray-50/60 px-6 py-2.5">
        <div className="flex gap-1 rounded-md bg-gray-100 p-0.5 text-[13px]">
          {(["unmatched", "excluded"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              className={`rounded px-2.5 py-1 capitalize ${t === subTab ? "bg-white font-medium shadow-sm" : "text-gray-600"}`}
            >
              {t}
            </button>
          ))}
        </div>
        <button onClick={onToggleImport} className="btn-secondary">
          Import Statement
        </button>
      </div>

      {notice && <p className="border-b bg-green-50 px-6 py-2 text-sm text-green-700">{notice}</p>}
      {error && <p className="border-b bg-red-50 px-6 py-2 text-sm text-red-700">{error}</p>}

      {showImport && (
        <ImportStatementWizard
          bankAccountId={bankAccountId}
          onImported={(message) => {
            setNotice(message);
            onToggleImport();
            void refresh();
          }}
          onCancel={onToggleImport}
        />
      )}

      {!txns?.length ? (
        <div className="p-12 text-center text-sm text-gray-500">No {subTab} transactions.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead className="table-head sticky top-0">
            <tr>
              <th className="border-b border-[#ece3d5] px-4 py-2.5">Date</th>
              <th className="border-b border-[#ece3d5] px-4 py-2.5">Description</th>
              <th className="border-b border-[#ece3d5] px-4 py-2.5">UTR</th>
              <th className="border-b border-[#ece3d5] px-4 py-2.5 text-right">Withdrawal</th>
              <th className="border-b border-[#ece3d5] px-4 py-2.5 text-right">Deposit</th>
              <th className="border-b border-[#ece3d5] px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <>
                <tr
                  key={t.id}
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                  className="cursor-pointer border-b border-[#ece3d5] hover:bg-gray-50"
                >
                  <td className="px-4 py-2.5">{formatDate(t.txnDate)}</td>
                  <td className="px-4 py-2.5">{t.description ?? t.counterparty ?? "—"}</td>
                  <td className="px-4 py-2.5 text-gray-500">{t.utr ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {t.direction === "debit" ? formatMoney(t.amount) : ""}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {t.direction === "credit" ? formatMoney(t.amount) : ""}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={t.matchStatus} />
                  </td>
                </tr>
                {expanded === t.id && (
                  <tr key={`${t.id}-x`} className="border-b border-[#ece3d5] bg-gray-50">
                    <td colSpan={6} className="px-6 py-4">
                      {t.matchStatus === "unmatched" ? (
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="w-72">
                            <label className="label">Categorize to account</label>
                            <select value={catAccount} onChange={(e) => setCatAccount(e.target.value)} className="input">
                              <option value="">Select account…</option>
                              {accounts?.filter((a) => a.isActive).map((a) => (
                                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                              ))}
                            </select>
                          </div>
                          <div className="w-72">
                            <label className="label">Narration</label>
                            <input value={catNarration} onChange={(e) => setCatNarration(e.target.value)} className="input" />
                          </div>
                          <button
                            onClick={() =>
                              void act(() =>
                                api(`/api/banking/transactions/${t.id}/categorize`, {
                                  method: "POST",
                                  body: { accountId: catAccount, narration: catNarration || `Bank: ${t.description ?? t.utr ?? "transaction"}` },
                                }),
                              )
                            }
                            disabled={!catAccount}
                            className="btn-primary"
                          >
                            Categorize
                          </button>
                          <span className="text-xs text-gray-400">or</span>
                          <div className="w-72">
                            <label className="label">Match to journal entry</label>
                            <select value={matchJe} onChange={(e) => setMatchJe(e.target.value)} className="input">
                              <option value="">Select entry…</option>
                              {journals?.map((j) => (
                                <option key={j.id} value={j.id}>
                                  {j.entryNumber} · {j.narration.slice(0, 40)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            onClick={() =>
                              void act(() =>
                                api(`/api/banking/transactions/${t.id}/match`, {
                                  method: "POST",
                                  body: { journalEntryId: matchJe },
                                }),
                              )
                            }
                            disabled={!matchJe}
                            className="btn-secondary"
                          >
                            Match
                          </button>
                          <button
                            onClick={() => void act(() => api(`/api/banking/transactions/${t.id}/exclude`, { method: "POST" }))}
                            className="ml-auto text-[13px] text-gray-500 hover:underline"
                          >
                            Exclude
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => void act(() => api(`/api/banking/transactions/${t.id}/unmatch`, { method: "POST" }))}
                          className="text-[13px] font-medium text-brand-600 hover:underline"
                        >
                          Restore to Uncategorized
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ============================ Quick entry (Record Deposit) ============================

function QuickEntryPanel({ bankAccountId, onDone, onCancel }: { bankAccountId: string; onDone: () => void; onCancel: () => void }) {
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [contraAccountId, setContraAccountId] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["accounts-all"],
    queryFn: () => api<Account[]>("/api/accounting/accounts"),
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/banking/entries", {
        method: "POST",
        body: { bankAccountId, direction, amount: Number(amount).toFixed(2), date, contraAccountId, description: description || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b bg-gray-50 px-6 py-4">
      <h3 className="mb-3 text-[13px] font-bold">Record Deposit / Withdrawal</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Direction</label>
          <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")} className="input w-40">
            <option value="in">Money In (Deposit)</option>
            <option value="out">Money Out (Withdrawal)</option>
          </select>
        </div>
        <div>
          <label className="label-required">Date *</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input w-40" />
        </div>
        <div>
          <label className="label-required">Amount *</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="input w-32" />
        </div>
        <div className="w-64">
          <label className="label-required">{direction === "in" ? "From Account" : "To Account"} *</label>
          <select value={contraAccountId} onChange={(e) => setContraAccountId(e.target.value)} className="input">
            <option value="">Select account…</option>
            {accounts?.filter((a) => a.isActive).map((a) => (
              <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
            ))}
          </select>
        </div>
        <div className="w-64">
          <label className="label">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
        </div>
        <button onClick={() => void save()} disabled={busy || !date || !amount || !contraAccountId} className="btn-primary">
          Save
        </button>
        <button onClick={onCancel} className="text-[13px] text-gray-500 hover:underline">Cancel</button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// ============================ Transfer between accounts ============================

function TransferPanel({ bankAccountId, onDone, onCancel }: { bankAccountId: string; onDone: () => void; onCancel: () => void }) {
  const [toAccountId, setToAccountId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["banking-summary"],
    queryFn: () => api<{ accounts: BankAccountDoc[] }>("/api/banking/summary"),
  });
  const others = accounts?.accounts.filter((a) => a.id !== bankAccountId) ?? [];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/banking/transfer", {
        method: "POST",
        body: { fromBankAccountId: bankAccountId, toBankAccountId: toAccountId, amount: Number(amount).toFixed(2), date, reference: reference || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b bg-gray-50 px-6 py-4">
      <h3 className="mb-3 text-[13px] font-bold">Transfer to Another Account</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <label className="label-required">To Account *</label>
          <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} className="input">
            <option value="">Select account…</option>
            {others.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-required">Date *</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input w-40" />
        </div>
        <div>
          <label className="label-required">Amount *</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="input w-32" />
        </div>
        <div className="w-56">
          <label className="label">Reference</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} className="input" />
        </div>
        <button onClick={() => void save()} disabled={busy || !toAccountId || !date || !amount} className="btn-primary">
          Save
        </button>
        <button onClick={onCancel} className="text-[13px] text-gray-500 hover:underline">Cancel</button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// ============================ Add / Edit bank account ============================

export function BankAccountNewPage({ editId }: { editId?: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    kind: "bank",
    bankName: "",
    accountNumber: "",
    ifsc: "",
    branch: "",
    bankCustomerCode: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: existing } = useQuery({
    queryKey: ["bank-account", editId],
    queryFn: () => api<Record<string, string>>(`/api/banking/accounts/${editId}`),
    enabled: !!editId,
  });
  useEffect(() => {
    if (!existing) return;
    setForm({
      name: existing.name ?? "",
      kind: existing.kind ?? "bank",
      bankName: existing.bankName ?? "",
      accountNumber: existing.accountNumber ?? "",
      ifsc: existing.ifsc ?? "",
      branch: existing.branch ?? "",
      bankCustomerCode: existing.bankCustomerCode ?? "",
    });
  }, [existing]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(editId ? `/api/banking/accounts/${editId}` : "/api/banking/accounts", {
        method: editId ? "PATCH" : "POST",
        body: {
          name: form.name,
          kind: form.kind,
          bankName: form.bankName || undefined,
          accountNumber: form.accountNumber || undefined,
          ifsc: form.ifsc || undefined,
          branch: form.branch || undefined,
          bankCustomerCode: form.bankCustomerCode || undefined,
        },
      });
      await qc.invalidateQueries();
      navigate(editId ? `/banking/${editId}` : "/banking");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";
  const label = "label";
  const backPath = editId ? `/banking/${editId}` : "/banking";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">{editId ? "Account Settings" : "Add Bank Account"}</h1>
        <button onClick={() => navigate(backPath)} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-xl grid-cols-2 gap-4">
          <div>
            <label className="label-required">Account Name *</label>
            <input value={form.name} onChange={set("name")} className={inputCls} autoFocus />
          </div>
          <div>
            <label className={label}>Type</label>
            <select value={form.kind} onChange={set("kind")} className={inputCls}>
              <option value="bank">Bank</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
            </select>
          </div>
          <div>
            <label className={label}>Bank Name</label>
            <input value={form.bankName} onChange={set("bankName")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Account Number</label>
            <input value={form.accountNumber} onChange={set("accountNumber")} className={inputCls} />
          </div>
          <div>
            <label className={label}>IFSC</label>
            <input value={form.ifsc} onChange={set("ifsc")} maxLength={11} className={inputCls} />
          </div>
          <div>
            <label className={label}>Branch</label>
            <input value={form.branch} onChange={set("branch")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Bank Customer Code</label>
            <input
              value={form.bankCustomerCode}
              onChange={set("bankCustomerCode")}
              maxLength={20}
              placeholder="e.g. 307242"
              className={inputCls}
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Our code with the bank, printed on their bulk-payment file. Needed to pay vendors
              from this account.
            </p>
          </div>
        </div>
        {!editId && (
          <p className="mt-3 max-w-xl text-xs text-gray-500">
            A ledger account is created automatically under Cash &amp; Bank for this account.
          </p>
        )}
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button onClick={() => void save()} disabled={busy || !form.name.trim()} className="btn-primary">
          Save
        </button>
        <button onClick={() => navigate(backPath)} className="ml-2 text-[13px] text-gray-500 hover:underline">Cancel</button>
      </footer>
    </div>
  );
}
