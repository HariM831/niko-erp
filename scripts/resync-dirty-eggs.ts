/**
 * Recount eggs laid on every day whose grading has dirty eggs (7 Oct 2026).
 *
 * Dirty was converted to eggs as a 210-egg box; it is a tray of 30. Each
 * affected house-day is re-synced to its daily record with the corrected
 * count. Dry run by default.
 *
 * Run: npx tsx scripts/resync-dirty-eggs.ts [--apply]
 */
import { gt } from "drizzle-orm";
import { eggGrading } from "@shared/schema";
import { db } from "../server/db";
import { syncGradedEggsToDay } from "../server/services/egg-sales";

const apply = process.argv.includes("--apply");
class DryRun extends Error {}

async function main() {
  try {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ houseId: eggGrading.houseId, day: eggGrading.gradedOn, dirty: eggGrading.dirty })
        .from(eggGrading)
        .where(gt(eggGrading.dirty, 0));
      for (const r of rows) {
        const eggs = await syncGradedEggsToDay(tx, r.houseId, r.day);
        console.log(`${r.day} house ${r.houseId}: ${r.dirty} dirty trays → eggs laid now ${eggs ?? "(no daily record)"}`);
      }
      console.log(`${rows.length} house-days.`);
      if (!apply) throw new DryRun();
    });
    console.log("Applied.");
  } catch (e) {
    if (e instanceof DryRun) console.log("Dry run — rolled back. Add --apply to keep it.");
    else throw e;
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
