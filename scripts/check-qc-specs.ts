/**
 * Checks the two guarantees the Quality Specs screen rests on.
 *
 *   1. Bands run one way. A spec whose target, warning and reject limits cross
 *      is not strict or lax — it is unjudgeable, and must be refused at save
 *      rather than discovered by a technician at 6am.
 *
 *   2. One live spec per material, enforced by the database rather than by the
 *      route that happens to write it. Two active specs would make a verdict a
 *      coin toss between them.
 *
 * The database half runs inside a transaction that is always rolled back, so it
 * leaves nothing behind and posts nothing to the ledger.
 *
 * Run: npx tsx scripts/check-qc-specs.ts
 */
import { and, eq } from "drizzle-orm";
import { items, qcSpecs } from "@shared/schema";
import { db } from "../server/db";
import { bandProblem } from "../server/routes/item-quality";
import { describeRule } from "../server/services/qc";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(54)} ${detail}`);
};

const band = (
  direction: "max" | "min",
  target: string | null,
  warnAt: string | null,
  rejectAt: string | null,
) => bandProblem({ parameter: "moisture", label: "Moisture", direction, target, warnAt, rejectAt });

console.log("\n  BAND ORDERING\n");

check("moisture 12 / 14 / 16 is a valid max spec", band("max", "12", "14", "16") === null);
check("protein 9 / 8 / 7 is a valid min spec", band("min", "9", "8", "7") === null);

check(
  "a max spec whose reject sits below its warning is refused",
  band("max", "12", "16", "14") !== null,
  band("max", "12", "16", "14") ?? "",
);
check(
  "a min spec that climbs is refused",
  band("min", "9", "10", "11") !== null,
  band("min", "9", "10", "11") ?? "",
);
check(
  "a max spec whose target sits above its warning is refused",
  band("max", "15", "14", "16") !== null,
);

check("equal bands are allowed — warn at target, no warning band", band("max", "14", "14", "14") === null);
check("a reject limit alone is enough to judge", band("max", null, null, "16") === null);
check("a warning alone is enough to judge", band("max", "12", "14", null) === null);
check(
  "a parameter with no limits at all is refused",
  band("max", "12", null, null) !== null,
  band("max", "12", null, null) ?? "",
);

console.log("\n  RULE SENTENCES\n");

const rule = (over: Partial<Parameters<typeof describeRule>[0]>) =>
  describeRule({
    id: "r",
    name: "n",
    parameter: "moisture",
    direction: "max",
    scope: "line",
    itemId: null,
    vendorId: null,
    threshold: "14",
    basis: "pct_of_value",
    ratePerPoint: null,
    flatAmount: null,
    minAmount: null,
    version: 1,
    effectiveFrom: "2026-01-01",
    isActive: true,
    createdBy: null,
    createdAt: new Date(),
    ...over,
  } as Parameters<typeof describeRule>[0]);

check("a percentage rule reads as a percentage per point", rule({}) === "1% of line value for each point over 14", rule({}));
check(
  "a min-direction rule says under, not over",
  rule({ direction: "min", parameter: "protein", threshold: "8" }).includes("under 8"),
  rule({ direction: "min", threshold: "8" }),
);
check(
  "the shortage rule names the truck, not the line",
  rule({ basis: "shortfall_value", scope: "vehicle", threshold: "50" }).endsWith("once per truck"),
  rule({ basis: "shortfall_value", scope: "vehicle", threshold: "50" }),
);
check(
  "a floor is mentioned where one is set",
  rule({ minAmount: "100" }).includes("nothing under ₹100"),
  rule({ minAmount: "100" }),
);

console.log("\n  ONE LIVE SPEC PER MATERIAL\n");

await db
  .transaction(async (tx) => {
    const item = await tx.query.items.findFirst({ where: eq(items.isPurchased, true) });
    if (!item) {
      console.log("    SKIP  no purchasable item to test against");
      throw new Error("__rollback__");
    }

    // Stand every real spec down, so the index is being tested and not tripped
    // by whatever is already live.
    await tx
      .update(qcSpecs)
      .set({ isActive: false })
      .where(and(eq(qcSpecs.itemId, item.id), eq(qcSpecs.isActive, true)));

    await tx.insert(qcSpecs).values({
      itemId: item.id,
      version: 900,
      effectiveFrom: "2026-01-01",
      isActive: true,
    });

    let refused = false;
    try {
      // A nested transaction, so the violation does not poison the outer one.
      await tx.transaction(async (inner) => {
        await inner.insert(qcSpecs).values({
          itemId: item.id,
          version: 901,
          effectiveFrom: "2026-01-02",
          isActive: true,
        });
      });
    } catch (e) {
      refused = (e as { code?: string }).code === "23505";
    }
    check("a second active spec for the same material is refused", refused, `on ${item.name}`);

    // Retiring the first is what makes room for the second — the same order the
    // route writes in.
    await tx
      .update(qcSpecs)
      .set({ isActive: false })
      .where(and(eq(qcSpecs.itemId, item.id), eq(qcSpecs.version, 900)));
    await tx.insert(qcSpecs).values({
      itemId: item.id,
      version: 901,
      effectiveFrom: "2026-01-02",
      isActive: true,
    });
    const live = await tx
      .select()
      .from(qcSpecs)
      .where(and(eq(qcSpecs.itemId, item.id), eq(qcSpecs.isActive, true)));
    check("retiring first lets the successor in", live.length === 1 && live[0]!.version === 901);

    let dupVersion = false;
    try {
      await tx.transaction(async (inner) => {
        await inner.insert(qcSpecs).values({
          itemId: item.id,
          version: 901,
          effectiveFrom: "2026-01-03",
          isActive: false,
        });
      });
    } catch (e) {
      dupVersion = (e as { code?: string }).code === "23505";
    }
    check("a version number is never reused for a material", dupVersion);

    throw new Error("__rollback__");
  })
  .catch((e) => {
    if ((e as Error).message !== "__rollback__") throw e;
  });

console.log(failed === 0 ? "\n  All quality-spec checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
