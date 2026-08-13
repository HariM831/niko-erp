/**
 * Phase 2: propose how Zoho's 398 accounts become EGGSY accounts.
 *
 * Almost all of this is mechanical — Zoho's account_type maps onto EGGSY's
 * subtype enum nearly one-for-one, because that enum was built from Zoho in the
 * first place. Two things are not mechanical and are why this step exists as a
 * review gate:
 *
 *   Codes. Only 6 of the 398 accounts carry an account_code, so EGGSY's
 *   mandatory unique code has to be generated. They are assigned in bands by
 *   type and depth-first through the hierarchy, so a child sits next to its
 *   parent and the statement tree — which sorts siblings by code — reads in a
 *   sensible order.
 *
 *   System keys. The posting engine finds accounts like `ap`, `ar` and `sales`
 *   by key, not by name. A wrong one does not fail loudly; it silently posts to
 *   the wrong account for the life of the system. They are proposed here from
 *   Zoho's own system-account flags and names, and want human confirmation.
 *
 * Writes a machine-readable map for the loader and a review document for a
 * person. Reads only files; touches neither Zoho nor the database.
 */
import { readFile, writeFile } from "node:fs/promises";

const DIR = ".zoho-dump";

interface ZohoAccount {
  account_id: string;
  account_name: string;
  account_code: string;
  account_type: string;
  description: string;
  parent_account_id: string;
  depth: number;
  is_system_account: boolean;
  is_child_present: boolean;
}

/** Zoho's account_type -> EGGSY's broad type and granular subtype. */
const TYPE_MAP: Record<string, { type: string; subtype: string }> = {
  other_asset: { type: "asset", subtype: "other_asset" },
  other_current_asset: { type: "asset", subtype: "other_current_asset" },
  cash: { type: "asset", subtype: "cash" },
  bank: { type: "asset", subtype: "bank" },
  accounts_receivable: { type: "asset", subtype: "accounts_receivable" },
  fixed_asset: { type: "asset", subtype: "fixed_asset" },
  stock: { type: "asset", subtype: "stock" },
  other_current_liability: { type: "liability", subtype: "other_current_liability" },
  accounts_payable: { type: "liability", subtype: "accounts_payable" },
  // The only name that differs between the two systems.
  long_term_liability: { type: "liability", subtype: "non_current_liability" },
  other_liability: { type: "liability", subtype: "other_liability" },
  credit_card: { type: "liability", subtype: "credit_card" },
  equity: { type: "equity", subtype: "equity" },
  income: { type: "income", subtype: "income" },
  other_income: { type: "income", subtype: "other_income" },
  expense: { type: "expense", subtype: "expense" },
  cost_of_goods_sold: { type: "expense", subtype: "cost_of_goods_sold" },
  other_expense: { type: "expense", subtype: "other_expense" },
};

/** Starting number for each subtype's code band, following the seeded chart. */
const BAND: Record<string, number> = {
  asset: 1000,
  liability: 2000,
  equity: 3000,
  income: 4000,
  other_income: 4500,
  cost_of_goods_sold: 5000,
  expense: 6000,
  other_expense: 6500,
};

const bandFor = (type: string, subtype: string) =>
  BAND[subtype] ?? BAND[type] ?? 9000;

/**
 * Every system key the server actually resolves, and how to recognise its
 * account in Zoho. `exact` matches the Zoho account name outright; `hint` is a
 * looser search used only to suggest a candidate for a human to confirm.
 */
const SYSTEM_KEYS: Array<{
  key: string;
  exact?: string;
  hint?: RegExp;
  type?: string;
  why: string;
}> = [
  { key: "ar", exact: "Accounts Receivable", why: "every invoice debits it" },
  { key: "ap", exact: "Accounts Payable", why: "every bill credits it" },
  { key: "sales", exact: "Sales", why: "catch-all revenue when a line names no account" },
  { key: "cogs", exact: "Cost of Goods Sold", why: "cost of sale postings" },
  { key: "retained_earnings", exact: "Retained Earnings", why: "year-end close" },
  { key: "petty_cash", exact: "Cash", why: "cash in hand; also counted as cash in the cash flow" },
  {
    // Confirmed by the user on 2026-08-13, over the SBI current account: the
    // working capital runs through the cash credit limit, which is why this one
    // carries a ~3.9cr credit balance and the current account carries 18 lakh.
    // Left as an exact name rather than a guess so it cannot drift.
    key: "cash_bank",
    exact: "Amino SBI CC Account-44656290967",
    why: "default bank for money in and out — the CC limit, where the working capital moves",
  },
  { key: "customer_advances", exact: "Unearned Revenue", why: "payments received before invoicing" },
  { key: "input_gst", exact: "Input Tax Credits", why: "unused once tax is folded into cost" },
  { key: "cgst_payable", exact: "Output CGST", why: "unused once tax is folded in" },
  { key: "sgst_payable", exact: "Output SGST", why: "unused once tax is folded in" },
  { key: "igst_payable", exact: "Output IGST", why: "unused once tax is folded in" },
  {
    key: "tds_payable",
    exact: "TDS Payable",
    hint: /^tds|tax deducted/i,
    why: "tax withheld on vendor payments",
  },
  {
    // Confirmed by the user over the two similarly named accounts, both of
    // which are unused. This is the one carrying the ₹83.7 lakh charged in
    // FY25-26.
    key: "depreciation_expense",
    exact: "Depreciation",
    why: "the charge a fixed asset's schedule posts",
  },
  {
    // Created, not mapped. Ind AS 2 requires a stock write-down to be an
    // expense of the period, so this must not point at one of Zoho's five (all
    // unused) stock asset accounts — that would net the loss against the asset
    // and hide it from the P&L entirely.
    key: "inventory_adjustment",
    why: "where a stock write-down lands",
  },
];

/**
 * Accounts EGGSY needs that Zoho has no equivalent for.
 *
 * Zoho never recorded accumulated depreciation or asset disposals — the ₹83.7
 * lakh charge went straight to an expense account with no contra-asset — so
 * there is nothing to map and these are created instead. Confirmed by the user
 * rather than assumed; nothing posts to them until the fixed-asset module is
 * used, so they sit at zero until then.
 */
const CREATE: Array<{
  systemKey: string;
  name: string;
  type: string;
  subtype: string;
  why: string;
}> = [
  {
    systemKey: "accum_depreciation",
    name: "Accumulated Depreciation",
    type: "asset",
    subtype: "fixed_asset",
    why: "contra-asset the depreciation charge credits",
  },
  {
    systemKey: "gain_on_disposal",
    name: "Gain on Disposal of Assets",
    type: "income",
    subtype: "other_income",
    why: "asset sold above book value",
  },
  {
    systemKey: "loss_on_disposal",
    name: "Loss on Disposal of Assets",
    type: "expense",
    subtype: "other_expense",
    why: "asset sold below book value",
  },
  {
    // An operating expense rather than a cost of sales line, confirmed by the
    // user. Keeping write-downs out of COGS stops an abnormal loss — a disease
    // outbreak, a fire — from distorting gross margin, which is the whole
    // reason standard practice separates them. When the feedmill module lands
    // and normal mortality is tracked as a production cost, that becomes its
    // own COGS account: splitting the two later is easy, disentangling them
    // from COGS afterwards is not.
    systemKey: "inventory_adjustment",
    name: "Inventory Adjustments (Write-off / Shrinkage)",
    type: "expense",
    subtype: "expense",
    why: "stock write-downs and shrinkage, visible as their own line",
  },
];

interface Mapped {
  zohoId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  parentZohoId: string | null;
  depth: number;
  description: string;
  systemKey: string | null;
  isSystemAccount: boolean;
  /** All-time balance from Zoho's trial balance; 0 means the account is unused. */
  balance: number;
}

async function main() {
  // Balances tell dormant accounts from live ones — 284 of the 398 have never
  // been posted to — and settle which of several similarly named accounts the
  // business actually uses. A far better signal than the name.
  let activity: Record<string, { name: string; balance: number; source: string }> = {};
  try {
    activity = JSON.parse(await readFile(`${DIR}/reports/account-activity.json`, "utf8"));
  } catch {
    console.warn("No account-activity.json — run pull-reports.ts for a better mapping.\n");
  }

  const raw = await readFile(`${DIR}/list/chartofaccounts.jsonl`, "utf8");
  const accounts: ZohoAccount[] = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const unknownTypes = [...new Set(accounts.map((a) => a.account_type))].filter(
    (t) => !TYPE_MAP[t],
  );
  if (unknownTypes.length) {
    throw new Error(
      `Zoho account types with no EGGSY equivalent: ${unknownTypes.join(", ")}. ` +
        `Add them to TYPE_MAP (and possibly to the accountSubtype enum) before loading.`,
    );
  }

  // Depth-first through the hierarchy so a child's code follows its parent's.
  const byParent = new Map<string, ZohoAccount[]>();
  for (const a of accounts) {
    const key = a.parent_account_id || "";
    byParent.set(key, [...(byParent.get(key) ?? []), a]);
  }
  for (const list of byParent.values()) {
    list.sort((x, y) => x.account_name.localeCompare(y.account_name));
  }

  const counters = new Map<number, number>();
  const mapped: Mapped[] = [];

  const visit = (a: ZohoAccount) => {
    const { type, subtype } = TYPE_MAP[a.account_type]!;
    const band = bandFor(type, subtype);
    const next = (counters.get(band) ?? 0) + 1;
    counters.set(band, next);

    mapped.push({
      zohoId: a.account_id,
      // A real Zoho code wins; otherwise one generated from the band.
      code: a.account_code?.trim() || String(band + next),
      name: a.account_name,
      type,
      subtype,
      parentZohoId: a.parent_account_id || null,
      depth: a.depth,
      description: a.description ?? "",
      systemKey: null,
      isSystemAccount: a.is_system_account,
      balance: activity[a.account_id]?.balance ?? 0,
      // Deliberately no isGroup: Zoho posts to parent accounts as readily as to
      // leaves — "Farm Expenses - Nabil" carries its own balance — so marking
      // parents as headers would reject postings the migration has to make.
    });
    for (const child of byParent.get(a.account_id) ?? []) visit(child);
  };
  for (const root of byParent.get("") ?? []) visit(root);

  if (mapped.length !== accounts.length) {
    throw new Error(
      `Traversal covered ${mapped.length} of ${accounts.length} accounts — the hierarchy has a cycle.`,
    );
  }
  const dupes = mapped.map((m) => m.code).filter((c, i, all) => all.indexOf(c) !== i);
  if (dupes.length) throw new Error(`Generated duplicate codes: ${[...new Set(dupes)].join(", ")}`);

  // ---- system keys ----
  const byName = new Map(mapped.map((m) => [m.name.toLowerCase(), m]));
  const resolved: Array<{
    key: string;
    account: Mapped | null;
    confidence: "exact" | "guess" | "none";
    candidates: string[];
    why: string;
  }> = [];

  for (const spec of SYSTEM_KEYS) {
    let account: Mapped | null = null;
    let confidence: "exact" | "guess" | "none" = "none";
    let candidates: string[] = [];

    if (spec.exact) {
      account = byName.get(spec.exact.toLowerCase()) ?? null;
      if (account) confidence = "exact";
    }
    if (!account && spec.hint) {
      const pool = mapped.filter(
        (m) => spec.hint!.test(m.name) && (!spec.type || m.subtype === spec.type),
      );
      candidates = pool.map(
        (m) => `${m.code} ${m.name}${m.balance ? ` (${m.balance.toFixed(2)})` : " (unused)"}`,
      );
      if (pool.length === 1) {
        account = pool[0]!;
        confidence = "guess";
      } else {
        // Several plausible names. If exactly one has ever been posted to, that
        // is the account the business uses and the others are strays.
        const used = pool.filter((m) => m.balance !== 0);
        if (used.length === 1) {
          account = used[0]!;
          confidence = "guess";
        }
      }
    }
    if (account) account.systemKey = spec.key;
    resolved.push({ key: spec.key, account, confidence, candidates, why: spec.why });
  }

  // Accounts with no Zoho counterpart, appended after the imported ones so
  // they take the next free code in their band.
  const created: Mapped[] = CREATE.map((c) => {
    const band = bandFor(c.type, c.subtype);
    const next = (counters.get(band) ?? 0) + 1;
    counters.set(band, next);
    return {
      zohoId: `eggsy:${c.systemKey}`,
      code: String(band + next),
      name: c.name,
      type: c.type,
      subtype: c.subtype,
      parentZohoId: null,
      depth: 0,
      description: c.why,
      systemKey: c.systemKey,
      isSystemAccount: true,
      balance: 0,
    };
  });
  for (const c of created) {
    const spec = resolved.find((r) => r.key === c.systemKey);
    if (spec) {
      spec.account = c;
      spec.confidence = "exact";
    } else {
      resolved.push({ key: c.systemKey, account: c, confidence: "exact", candidates: [], why: c.description });
    }
  }
  mapped.push(...created);

  await writeFile(
    `${DIR}/account-map.json`,
    JSON.stringify({ accounts: mapped, systemKeys: resolved, createdCount: created.length }, null, 2),
  );

  // ---- review document ----
  const counts = mapped.reduce<Record<string, number>>((acc, m) => {
    acc[m.subtype] = (acc[m.subtype] ?? 0) + 1;
    return acc;
  }, {});

  const missing = resolved.filter((r) => !r.account);
  const guessed = resolved.filter((r) => r.confidence === "guess");

  const lines: string[] = [
    "# Chart of accounts: proposed mapping",
    "",
    `${mapped.length} Zoho accounts, ${Object.keys(counts).length} subtypes, ${mapped.filter((m) => m.depth > 0).length} of them nested.`,
    "",
    "## What needs your eye",
    "",
    "### System keys",
    "",
    "The posting engine finds these by key, not by name. A wrong one posts to the",
    "wrong account silently, for the life of the system.",
    "",
    "| Key | Account | How | What it is for |",
    "| --- | --- | --- | --- |",
    ...resolved.map(
      (r) =>
        `| \`${r.key}\` | ${r.account ? `${r.account.code} · ${r.account.name}` : "**none found**"} | ${
          r.confidence === "exact" ? "exact name" : r.confidence === "guess" ? "**guessed**" : "—"
        } | ${r.why} |`,
    ),
    "",
  ];

  if (guessed.length) {
    lines.push(
      "Guessed matches came from a single name match rather than Zoho flagging the",
      "account as a system one. Worth confirming:",
      "",
      ...guessed.map((r) => `- \`${r.key}\` → ${r.account!.code} · ${r.account!.name}`),
      "",
    );
  }

  if (missing.length) {
    lines.push(
      "### Keys with no account in Zoho",
      "",
      "These have to be created in EGGSY. Where several candidates exist the choice",
      "is yours; where none do, the loader will add a new account.",
      "",
    );
    for (const r of missing) {
      lines.push(`**\`${r.key}\`** — ${r.why}`);
      lines.push(
        r.candidates.length
          ? `  candidates: ${r.candidates.join(" · ")}`
          : "  no candidate in the Zoho chart; a new account will be created",
      );
      lines.push("");
    }
  }

  lines.push(
    "## Everything else is mechanical",
    "",
    "| Zoho type | EGGSY type / subtype | Accounts |",
    "| --- | --- | --- |",
    ...Object.entries(TYPE_MAP)
      .filter(([z]) => accounts.some((a) => a.account_type === z))
      .map(([z, v]) => {
        const n = accounts.filter((a) => a.account_type === z).length;
        return `| ${z} | ${v.type} / ${v.subtype} | ${n} |`;
      }),
    "",
    "Codes: only 6 accounts had one in Zoho, so the rest are generated in bands —",
    Object.entries(BAND)
      .map(([k, v]) => `${k} from ${v}`)
      .join(", ") + ".",
    "",
    "## The chart as it will be created",
    "",
    `Of the ${mapped.length} accounts, ${mapped.filter((m) => m.balance !== 0).length} carry a balance.`,
    "The rest have never been posted to. They are still created — a dormant account",
    "costs nothing and deleting one loses history if it turns out to be used — but",
    "they are listed separately so the review is over the accounts that matter.",
    "",
    "### Accounts with a balance",
    "",
    "```",
    ...mapped
      .filter((m) => m.balance !== 0)
      .map(
        (m) =>
          `${m.code.padEnd(6)} ${m.name.padEnd(58)} ${m.balance.toFixed(2).padStart(16)}` +
          `${m.systemKey ? `  [${m.systemKey}]` : ""}`,
      ),
    "```",
    "",
    "### Dormant accounts",
    "",
    "```",
    ...mapped
      .filter((m) => m.balance === 0)
      .map(
        (m) =>
          `${"  ".repeat(m.depth)}${m.code.padEnd(6)} ${m.name}` +
          `${m.systemKey ? `   [${m.systemKey}]` : ""}`,
      ),
    "```",
    "",
  );

  await writeFile(`${DIR}/account-map.md`, lines.join("\n"));

  console.log(`${mapped.length} accounts mapped.`);
  console.table(counts);
  console.log(`\nSystem keys: ${resolved.filter((r) => r.confidence === "exact").length} exact, ${guessed.length} guessed, ${missing.length} missing.`);
  for (const r of missing) {
    console.log(`  missing ${r.key.padEnd(22)} ${r.candidates.length ? `candidates: ${r.candidates.join(" | ")}` : "(none — will be created)"}`);
  }
  console.log(`\nReview: ${DIR}/account-map.md`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
