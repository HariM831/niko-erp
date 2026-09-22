/**
 * Propose — and with --apply, write — the Cost Analysis head mapping for the
 * chart as imported from Zoho, matched on account CODE.
 *
 * The mapping is the one agreed on 22 Sep 2026 (docs/cost-of-production-plan.md).
 * Codes not in the chart are reported and skipped; accounts already mapped are
 * left alone unless --force is given, so a decision taken on the Settings
 * screen survives a re-run.
 *
 *   npx tsx scripts/seed-cost-analysis-heads.ts            # print the proposal
 *   npx tsx scripts/seed-cost-analysis-heads.ts --apply    # write unmapped rows
 *   npx tsx scripts/seed-cost-analysis-heads.ts --apply --force
 */
import { eq, inArray } from "drizzle-orm";
import { accounts, costAnalysisHeads, type CostSection } from "@shared/schema";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

const MAP: Record<CostSection, string[]> = {
  income: ["4009"],
  cogs: ["5011", "5016", "5008", "5009"],
  farm: [
    "6011", "6014", "6016", "6015", "6017", "6018", "6019", "6020", "6049", "6021", "6022", "6012",
    "6050", "6549", "6546", "6548", "6552", "6545",
  ],
  mill: ["6032", "6033", "6034", "6035", "6036", "6038"],
  packing: ["5010"],
  admin: [
    "6550", "6509", "6529", "6530", "6531", "6510", "6511", "6523", "6516", "6517", "6526", "6528",
    "6527", "6508", "6505", "6503", "6595", "6512", "6514", "6515", "6583",
  ],
  finance: ["6558", "6557"],
  // Raw materials (feed FIFO stands in), chicks (the pullet stands in), the eggs
  // bought back from the LLPs and the feed and pullets sold to them (transfer
  // prices), suspense, net-credit oddities, and a site with no houses.
  excluded: ["5007", "5005", "5006", "4010", "4008", "6605", "6047", "6045", "6569"],
};

const wanted = new Map<string, CostSection>();
for (const [section, codes] of Object.entries(MAP) as Array<[CostSection, string[]]>) {
  for (const code of codes) wanted.set(code, section);
}

const chart = await db
  .select({ id: accounts.id, code: accounts.code, name: accounts.name })
  .from(accounts)
  .where(inArray(accounts.code, [...wanted.keys()]));
const byCode = new Map(chart.map((a) => [a.code, a]));
const existing = new Map(
  (await db.select().from(costAnalysisHeads)).map((h) => [h.accountId, h.section]),
);

let toWrite: Array<{ accountId: string; section: CostSection; code: string; name: string }> = [];
console.log("");
for (const [code, section] of wanted) {
  const acc = byCode.get(code);
  if (!acc) {
    console.log(`  ${code.padEnd(6)} not in the chart — skipped`);
    continue;
  }
  const have = existing.get(acc.id);
  const note = have && have !== section ? (FORCE ? `was ${have}, overwritten` : `already ${have}, kept`) : have ? "already set" : "new";
  console.log(`  ${code.padEnd(6)} ${section.padEnd(9)} ${acc.name}  (${note})`);
  if (!have || (FORCE && have !== section)) toWrite.push({ accountId: acc.id, section, ...acc });
}

if (!APPLY) {
  console.log(`\n  ${toWrite.length} row(s) would be written. Re-run with --apply.\n`);
  process.exit(0);
}

await db.transaction(async (tx) => {
  for (const w of toWrite) {
    await tx
      .insert(costAnalysisHeads)
      .values({ accountId: w.accountId, section: w.section })
      .onConflictDoUpdate({
        target: costAnalysisHeads.accountId,
        set: { section: w.section, updatedAt: new Date() },
      });
  }
});
console.log(`\n  wrote ${toWrite.length} row(s)\n`);
process.exit(0);
