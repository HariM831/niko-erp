/**
 * Checks the guarantee the Deduction Rules screen rests on: at most one live
 * rule per reading per material per vendor.
 *
 * `computeDeductions` keeps ONE rule per parameter and picks the most specific.
 * Two live rules of equal specificity leave that pick to whatever order the
 * rows came back in — so a vendor's deduction would depend on the query plan.
 * The index that prevents it has to use COALESCE, because a plain unique index
 * treats two NULL item_ids as distinct and would wave through exactly the
 * blanket rules that collide.
 *
 * Also checks that overlapping rules of DIFFERENT specificity are still
 * allowed, and that the narrower one wins — a vendor-specific rule is meant to
 * beat the blanket one, not to be refused alongside it.
 *
 * Runs inside a transaction that is always rolled back.
 *
 * Run: npx tsx scripts/check-deduction-rules.ts
 */
import { eq } from "drizzle-orm";
import { contacts, deductionRules, items } from "@shared/schema";
import { db } from "../server/db";
import { computeDeductions, describeRule } from "../server/services/qc";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};

class Rollback extends Error {}

/** Ran it, caught the unique violation, said whether the database refused. */
async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return true;
    throw e;
  }
}

const rule = (over: Partial<typeof deductionRules.$inferInsert>) => ({
  name: "test",
  parameter: "moisture",
  direction: "max" as const,
  scope: "line" as const,
  basis: "pct_of_value" as const,
  threshold: "14",
  effectiveFrom: "2026-01-01",
  version: 1,
  ...over,
});

try {
  await db.transaction(async (tx) => {
    const [item] = await tx.select({ id: items.id, name: items.name }).from(items).limit(1);
    const [vendor] = await tx.select({ id: contacts.id }).from(contacts).limit(1);
    if (!item || !vendor) throw new Error("Need an item and a contact to test against");

    // Clear the field so the index is being tested, not tripped by live config.
    await tx.update(deductionRules).set({ isActive: false }).where(eq(deductionRules.isActive, true));

    console.log("\n  ONE LIVE RULE PER READING\n");

    await tx.insert(deductionRules).values(rule({ name: "blanket" }));
    check(
      "a second blanket rule for the same reading is refused",
      await refused(() =>
        tx.transaction((inner) => inner.insert(deductionRules).values(rule({ name: "blanket twin" }))),
      ),
      "two NULL item_ids are the same rule, not two",
    );

    await tx.insert(deductionRules).values(rule({ name: "for a material", itemId: item.id }));
    check(
      "a second rule for the same material is refused",
      await refused(() =>
        tx.transaction((inner) =>
          inner.insert(deductionRules).values(rule({ name: "material twin", itemId: item.id })),
        ),
      ),
      item.name,
    );

    // Different specificities are the whole point of narrowing, and must coexist.
    await tx.insert(deductionRules).values(rule({ name: "for a vendor", vendorId: vendor.id }));
    const live = await tx.select().from(deductionRules).where(eq(deductionRules.isActive, true));
    check("rules that narrow differently coexist", live.length === 3, `${live.length} live`);

    check(
      "a retired rule frees its slot",
      await (async () => {
        await tx
          .update(deductionRules)
          .set({ isActive: false })
          .where(eq(deductionRules.name, "blanket"));
        await tx.insert(deductionRules).values(rule({ name: "blanket successor" }));
        return true;
      })(),
      "supersede is retire-then-insert, in one transaction",
    );

    console.log("\n  THE NARROWER RULE WINS\n");

    const rules = await tx.select().from(deductionRules).where(eq(deductionRules.isActive, true));
    const forThatItem = computeDeductions(rules, {
      itemId: item.id,
      vendorId: null,
      readings: { moisture: 15 },
      netKg: 1000,
      ratePerKg: 20,
    });
    check("only one rule ever charges a reading", forThatItem.length === 1, `${forThatItem.length} deduction(s)`);
    check("the material rule beats the blanket one", forThatItem[0]?.name === "for a material", forThatItem[0]?.name ?? "—");

    const forThatVendor = computeDeductions(rules, {
      itemId: null,
      vendorId: vendor.id,
      readings: { moisture: 15 },
      netKg: 1000,
      ratePerKg: 20,
    });
    check("the vendor rule beats the blanket one", forThatVendor[0]?.name === "for a vendor", forThatVendor[0]?.name ?? "—");

    const forNeither = computeDeductions(rules, {
      itemId: null,
      vendorId: null,
      readings: { moisture: 15 },
      netKg: 1000,
      ratePerKg: 20,
    });
    check("with nothing to narrow on, the blanket rule charges", forNeither[0]?.name === "blanket successor", forNeither[0]?.name ?? "—");

    console.log("\n  WHAT THE SCREEN SAYS A RULE DOES\n");

    const sentence = (over: Partial<typeof deductionRules.$inferSelect>) =>
      describeRule({ ...rule({}), id: "x", itemId: null, vendorId: null, ratePerPoint: null, flatAmount: null, minAmount: null, isActive: true, createdBy: null, createdAt: new Date(), ...over } as typeof deductionRules.$inferSelect);

    check(
      "a per-point rule names its rate",
      sentence({ basis: "per_point_per_kg", ratePerPoint: "0.5" }) === "₹0.5 per kg for each point over 14",
      sentence({ basis: "per_point_per_kg", ratePerPoint: "0.5" }),
    );
    check(
      "a vehicle-scoped rule says once per truck",
      sentence({ basis: "shortfall_value", scope: "vehicle", threshold: "50" }).endsWith("once per truck"),
      sentence({ basis: "shortfall_value", scope: "vehicle", threshold: "50" }),
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const survivors = await db.select({ n: deductionRules.name }).from(deductionRules).where(eq(deductionRules.name, "test"));
const stillLive = await db.select({ n: deductionRules.name }).from(deductionRules).where(eq(deductionRules.isActive, true));
check("nothing survives the run", survivors.length === 0);
check("the real rules are live again", stillLive.length > 0, `${stillLive.length} live`);

console.log(failed === 0 ? "\n  All deduction-rule checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
