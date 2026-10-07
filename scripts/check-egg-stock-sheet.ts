/**
 * Checks the submitted-day lock on the egg stock statement — then rolls back.
 *
 * Uses a day far in the future so no real sheet is touched, and makes its own
 * submission rows inside the transaction.
 *
 * Run: npx tsx scripts/check-egg-stock-sheet.ts
 */
import { eq } from "drizzle-orm";
import { eggStockDays, users } from "@shared/schema";
import { STOCK_SHEET_SIZES } from "@shared/egg-sizes";
import { db } from "../server/db";
import { assertDayOpen, dayLock, loadAndInvoice } from "../server/services/egg-sales";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};
class Rollback extends Error {}

const DAY = "2099-01-01";

async function refuses(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function main() {
  const [actor] = await db.select({ id: users.id }).from(users).limit(1);
  if (!actor) throw new Error("No user");

  check(
    "the statement's column order",
    STOCK_SHEET_SIZES.join(",") === "small,medium,large,niko,brown,jumbo,dirty",
    STOCK_SHEET_SIZES.join(","),
  );

  try {
    await db.transaction(async (tx) => {
      check("a day nobody submitted is open", !(await dayLock(tx, DAY)).locked);

      const t0 = new Date("2099-01-01T12:00:00Z");
      await tx.insert(eggStockDays).values({ day: DAY, submittedBy: actor.id, submittedAt: t0 });
      check("submitted, it is locked", (await dayLock(tx, DAY)).locked);
      const msg = await refuses(() => assertDayOpen(tx, DAY, "its grading"));
      check("grading on it is refused", !!msg && /submitted/.test(msg), msg ?? "");
      const load = await refuses(() =>
        loadAndInvoice(
          tx,
          {
            dispatchDate: DAY,
            customerId: "00000000-0000-0000-0000-000000000000",
            loaded: { large: 1 },
            driverName: "x",
            vehicleNumber: "y",
          },
          actor.id,
        ),
      );
      check("a truck dated to it is refused before anything else", !!load && /submitted/.test(load), load ?? "");

      await tx
        .update(eggStockDays)
        .set({ reopenedBy: actor.id, reopenedAt: new Date("2099-01-01T13:00:00Z") })
        .where(eq(eggStockDays.day, DAY));
      check("reopened, it is open again", !(await dayLock(tx, DAY)).locked);

      await tx
        .update(eggStockDays)
        .set({ submittedAt: new Date("2099-01-01T14:00:00Z") })
        .where(eq(eggStockDays.day, DAY));
      check("submitted again after the reopen, locked again", (await dayLock(tx, DAY)).locked);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(failed ? `\n${failed} FAILED` : "\nAll passed (rolled back)");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
