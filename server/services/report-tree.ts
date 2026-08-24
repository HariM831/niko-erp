/**
 * Turning flat account movements into the nested shape a financial statement
 * is actually read in.
 *
 * Every niko report rendered accounts flat, so a chart like "Feed & Additives"
 * with "Loading & Unloading" beneath it read as two unrelated lines and no
 * subtotal tied them together. Statements are hierarchical; this builds that
 * hierarchy once so each report doesn't reinvent it.
 */

export interface AccountRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  parentId: string | null;
  isGroup: boolean;
  /** Net movement on this account alone, already sign-corrected by the caller. */
  net: number;
  /**
   * Whether any document line naming an item posted here in the window. Decides
   * whether the statement drills into an item report or into the ledger.
   */
  hasItemLines: boolean;
}

export interface TreeNode {
  accountId: string;
  code: string;
  name: string;
  isGroup: boolean;
  hasItemLines: boolean;
  depth: number;
  /** This account's own movement. */
  amount: string;
  /** Own movement plus every descendant — the "Total for X" figure. */
  total: string;
  children: TreeNode[];
}

const money = (n: number) => n.toFixed(2);

/**
 * Build the forest for a set of accounts.
 *
 * Only the given rows are considered, so a caller filtering to expenses gets an
 * expense tree; a parent whose own parent was filtered out becomes a root
 * rather than disappearing with its children.
 */
export function buildTree(rows: AccountRow[]): { nodes: TreeNode[]; total: string } {
  const byId = new Map(rows.map((r) => [r.accountId, r]));
  const childrenOf = new Map<string | null, AccountRow[]>();

  for (const r of rows) {
    // Re-root anything whose parent is not in this slice.
    const parent = r.parentId && byId.has(r.parentId) ? r.parentId : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(r);
    childrenOf.set(parent, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.code.localeCompare(b.code));

  const build = (row: AccountRow, depth: number): TreeNode => {
    const kids = (childrenOf.get(row.accountId) ?? []).map((c) => build(c, depth + 1));
    const descendantTotal = kids.reduce((s, k) => s + Number(k.total), 0);
    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      isGroup: row.isGroup,
      hasItemLines: row.hasItemLines,
      depth,
      amount: money(row.net),
      total: money(row.net + descendantTotal),
      children: kids,
    };
  };

  const nodes = (childrenOf.get(null) ?? []).map((r) => build(r, 0));
  return { nodes, total: money(nodes.reduce((s, n) => s + Number(n.total), 0)) };
}

/** Drop branches with nothing in them, so a statement isn't padded with zeros. */
export function pruneEmpty(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((n) => ({ ...n, children: pruneEmpty(n.children) }))
    .filter((n) => Number(n.total) !== 0 || n.children.length > 0);
}
