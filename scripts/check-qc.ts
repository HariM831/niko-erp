/**
 * Checks that a load is judged by its spec and charged by its rules — and that
 * the two stay independent.
 *
 * The case that matters is the gap between them: maize rejected above 16%
 * moisture but charged for above 14%. A reading of 15.1% must be ACCEPTED with
 * a warning AND carry a deduction. Collapse the two thresholds into one and
 * that load is either refused outright or paid for in full; both are wrong.
 *
 * Creates a spec and rules, exercises them, then rolls back.
 *
 * Run: npx tsx scripts/check-qc.ts
 */
import { and, eq } from "drizzle-orm";
import { deductionRules, items, qcSpecParams, qcSpecs } from "@shared/schema";
import { db, type Tx } from "../server/db";
import { computeDeductions, judgeLine, loadDeductionRules, loadSpecs } from "../server/services/qc";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
};

class Rollback extends Error {}

async function main() {
  const [maize] = await db.select({ id: items.id }).from(items).where(eq(items.name, "Maize")).limit(1);
  if (!maize) throw new Error("No 'Maize' item to test against");

  try {
    await db.transaction(async (tx: Tx) => {
      // Only one spec per material may be live, so the real one stands down for
      // the length of this transaction — which is always rolled back.
      await tx
        .update(qcSpecs)
        .set({ isActive: false })
        .where(and(eq(qcSpecs.itemId, maize.id), eq(qcSpecs.isActive, true)));

      const [spec] = await tx
        .insert(qcSpecs)
        .values({ itemId: maize.id, version: 99, effectiveFrom: "2026-01-01", sampleCount: 3 })
        .returning();
      await tx.insert(qcSpecParams).values([
        // Refuse above 16, flag above 14. The gap is deliberate.
        { specId: spec!.id, parameter: "moisture", label: "Moisture", direction: "max", target: "12", warnAt: "14", rejectAt: "16", sortOrder: 0 },
        // Protein fails downwards.
        { specId: spec!.id, parameter: "protein", label: "Protein", direction: "min", target: "9", warnAt: "8", rejectAt: "7", sortOrder: 1 },
      ]);

      const specs = await loadSpecs(tx, [maize.id]);
      const forMaize = specs.get(maize.id);

      console.log("\n  THE SPEC DECIDES WHETHER WE TAKE IT\n");
      check("clean load passes", judgeLine({ moisture: 12, protein: 9.2 }, forMaize).verdict === "pass");
      const warn = judgeLine({ moisture: 15.1, protein: 9 }, forMaize);
      check("15.1% moisture is a warning, not a refusal", warn.verdict === "warning",
        warn.params.find((p) => p.parameter === "moisture")?.detail ?? "");
      check("16.5% moisture is refused", judgeLine({ moisture: 16.5, protein: 9 }, forMaize).verdict === "rejected");
      check("protein fails downwards", judgeLine({ moisture: 12, protein: 6.5 }, forMaize).verdict === "rejected",
        "6.5 under the 7 minimum");
      check("one bad parameter rejects the line", judgeLine({ moisture: 16.5, protein: 9.5 }, forMaize).verdict === "rejected");

      const partial = judgeLine({ moisture: 12 }, forMaize);
      check("an unmeasured parameter is missing, not a pass", partial.missing.includes("Protein"), partial.missing.join(", "));
      check("a material with no spec yields no_spec", judgeLine({ moisture: 12 }, undefined).verdict === "no_spec");

      // ── Rules ──
      // Same reason as the spec above: this exercises the rules it writes, so
      // the live ones stand down rather than competing with them. A real
      // "shortage over 50 kg" rule would otherwise beat the one below and
      // charge 40 kg where the check expects 90.
      await tx.update(deductionRules).set({ isActive: false }).where(eq(deductionRules.isActive, true));

      await tx.insert(deductionRules).values([
        // Money starts at 14, two points below the reject limit.
        { name: "Moisture over 14%", parameter: "moisture", direction: "max", itemId: maize.id, threshold: "14", basis: "pct_of_value", version: 1, effectiveFrom: "2026-01-01" },
        { name: "Damage", parameter: "damage", direction: "max", threshold: "0", basis: "pct_of_value", version: 1, effectiveFrom: "2026-01-01" },
        { name: "Weight shortage", parameter: "shortage", direction: "max", threshold: "0", basis: "shortfall_value", version: 1, effectiveFrom: "2026-01-01" },
      ]);
      const rules = await loadDeductionRules(tx);

      console.log("\n  THE RULES DECIDE WHAT WE PAY\n");
      const base = { itemId: maize.id, vendorId: null, netKg: 24290, ratePerKg: 23.1 };

      // 15.1% — accepted by the spec, still charged by the rule. The whole point.
      const wet = computeDeductions(rules, { ...base, readings: { moisture: 15.1 } });
      const expectedWet = Number(((1.1 * 24290 * 23.1) / 100).toFixed(2));
      check("a warning load still carries a deduction", wet.length === 1 && wet[0]!.amount === expectedWet,
        `₹${wet[0]?.amount.toLocaleString("en-IN")} — ${wet[0]?.basis}`);

      // 13.5% — inside the deduction threshold, nothing comes off.
      check("below the deduction threshold, nothing is charged",
        computeDeductions(rules, { ...base, readings: { moisture: 13.5 } }).length === 0);

      const dmg = computeDeductions(rules, { ...base, readings: { damage: 2 } });
      check("damage is charged on its own rule", dmg.length === 1, `₹${dmg[0]?.amount.toLocaleString("en-IN")}`);

      const short = computeDeductions(rules, { ...base, readings: { shortage: 90 } });
      check("shortage charges the missing weight", short.length === 1 && short[0]!.amount === Number((90 * 23.1).toFixed(2)),
        `₹${short[0]?.amount.toLocaleString("en-IN")} — ${short[0]?.basis}`);

      const all = computeDeductions(rules, { ...base, readings: { moisture: 15.1, damage: 2, shortage: 90 } });
      check("three rules can fire on one line", all.length === 3,
        all.map((d) => `${d.parameter} ₹${d.amount.toLocaleString("en-IN")}`).join(", "));

      // A material-specific rule must not double up with a blanket one.
      await tx.insert(deductionRules).values({
        name: "Moisture, all materials", parameter: "moisture", direction: "max",
        threshold: "10", basis: "pct_of_value", version: 1, effectiveFrom: "2026-01-01",
      });
      const both = computeDeductions(await loadDeductionRules(tx), { ...base, readings: { moisture: 15.1 } });
      check("the material-specific rule wins, and fires once", both.length === 1 && both[0]!.amount === expectedWet,
        both.map((d) => d.name).join(", "));

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  // Not "the table is empty" — real specs live here now. What must be true is
  // that this run left nothing of its own behind, and put the live spec back.
  const strays = await db.select({ id: qcSpecs.id }).from(qcSpecs).where(eq(qcSpecs.version, 99));
  const live = await db
    .select({ id: qcSpecs.id })
    .from(qcSpecs)
    .where(and(eq(qcSpecs.itemId, maize.id), eq(qcSpecs.isActive, true)));
  check("nothing survives the run", strays.length === 0, `${strays.length} test spec(s) left`);
  check("the real spec is live again", live.length === 1, `${live.length} active on Maize`);
  console.log(failed === 0 ? "\n  All QC checks passed.\n" : `\n  ${failed} check(s) FAILED.\n`);
  process.exit(failed ? 1 : 0);
}

void main();
