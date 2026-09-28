/**
 * Checks the two records that let a past decision be re-read:
 *
 *   a purchase order carries the quality standard AS TEXT in its notes, because
 *   a PO is a document sent to a vendor and the standard they agreed to has to
 *   be legible on the paper they were sent. A link would say "whatever the spec
 *   is now", which is the one thing it must not say.
 *
 *   a vendor credit line carries the RULE ID AND VERSION that charged it,
 *   because prose answers a vendor's query but only a column answers "what has
 *   this rule cost us".
 *
 * The pairing is deliberate: one is deliberately a copy, the other deliberately
 * a reference, and the reasons are opposite.
 *
 * Everything runs inside a transaction that is always rolled back, so no order,
 * bill, credit or journal survives. The materials, their spec, the rule and the
 * vendor are the check's own, made inside it: the figures asserted below are
 * the ones it wrote, not whatever the real Maize spec happens to say today.
 *
 * Run: npx tsx scripts/check-spec-and-rule-provenance.ts
 */
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  contacts,
  users,
  deductionRules,
  items,
  qcSpecParams,
  qcSpecs,
  vendorCreditLines,
} from "@shared/schema";
import { db } from "../server/db";
import { createVendorCredit, loadVendor } from "../server/services/purchases";
import { describeSpecsForOrder } from "../server/services/qc";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(54)} ${detail}`);
};

class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const [maize, cement] = await tx
      .insert(items)
      .values([
        { name: "ZZ Check Maize", unit: "kg", isFeedIngredient: true },
        { name: "ZZ Check Cement", unit: "bag" },
      ])
      .returning();
    if (!maize || !cement) throw new Error("could not make the scratch materials");
    // Refused above 16, charged above 14; protein fails downwards at 7, warns at 8.
    const [v1] = await tx
      .insert(qcSpecs)
      .values({ itemId: maize.id, version: 1, effectiveFrom: "2026-01-01", sampleCount: 3 })
      .returning();
    await tx.insert(qcSpecParams).values([
      { specId: v1!.id, parameter: "moisture", label: "Moisture", unit: "%", direction: "max", target: "12", warnAt: "14", rejectAt: "16", sortOrder: 0 },
      { specId: v1!.id, parameter: "protein", label: "Protein", unit: "%", direction: "min", target: "9", warnAt: "8", rejectAt: "7", sortOrder: 1 },
    ]);

    console.log("\n  THE ORDER CARRIES THE STANDARD, IN WORDS\n");

    const note = await describeSpecsForOrder(tx, [{ itemId: maize.id, name: "Maize" }]);
    check(
      "an inspected material puts its standard on the order",
      note != null,
      note?.split("\n")[1] ?? "",
    );
    check(
      "one figure per parameter, and it is where money starts",
      note?.includes("Moisture : Max 14%") === true,
      "the warning threshold, not the target",
    );
    check("a minimum reads as Min, not Max", note?.includes("Protein : Min 8%") === true);
    check(
      "the reject limit stays ours — printing it invites aiming at it",
      !note?.includes("16") && !note?.includes("7%"),
      "no 16, no 7",
    );
    check(
      "no sample count and no version on the vendor's copy",
      !note?.includes("sample") && !/v\d/.test(note ?? ""),
      "settled in conversation",
    );
    check("two lines, not a page", (note?.split("\n").length ?? 0) === 2, JSON.stringify(note));

    const none = await describeSpecsForOrder(tx, [{ itemId: cement.id, name: "Cement" }]);
    check("an order for something uninspected gets no empty heading", none === null);

    // A spec that moves must not rewrite an order already sent. The note is a
    // copy, so the only way to prove that is to move the spec and re-read it.
    const before = note;
    await tx.update(qcSpecs).set({ isActive: false }).where(eq(qcSpecs.id, v1!.id));
    const [v2] = await tx
      .insert(qcSpecs)
      .values({ itemId: maize.id, version: 99, effectiveFrom: "2026-09-01", sampleCount: 5 })
      .returning();
    await tx.insert(qcSpecParams).values({
      specId: v2!.id,
      parameter: "moisture",
      label: "Moisture",
      unit: "%",
      direction: "max",
      target: "10",
      warnAt: "11",
      rejectAt: "12",
      sortOrder: 0,
    });

    // A parameter that is NOT a percentage. Before the unit column this printed
    // "Max 20%" for a limit of twenty parts per billion — off by seven orders of
    // magnitude, and entirely ordinary-looking on a page a vendor skims.
    await tx.insert(qcSpecParams).values({
      specId: v2!.id,
      parameter: "aflatoxin",
      label: "Aflatoxin",
      unit: " ppb",
      direction: "max",
      warnAt: "20",
      rejectAt: "30",
      sortOrder: 1,
    });
    const after = await describeSpecsForOrder(tx, [{ itemId: maize.id, name: "Maize" }]);
    check(
      "a new spec changes what the NEXT order says",
      after !== before && !!after?.includes("Max 11%"),
      after?.split("\n")[1] ?? "",
    );
    check(
      "text already written is untouched by the change",
      !!before?.includes("Max 14%"),
      "the copy on a sent order cannot move",
    );
    check(
      "a parameter that is not a percentage says so",
      after?.includes("Aflatoxin : Max 20 ppb") === true,
      "not 20%, which is off by seven orders of magnitude",
    );

    console.log("\n  THE CREDIT LINE NAMES THE RULE THAT CHARGED IT\n");

    const [rule] = await tx
      .insert(deductionRules)
      .values({
        name: "ZZ Check moisture over 14%", parameter: "moisture", direction: "max", itemId: maize.id,
        threshold: "14", basis: "pct_of_value", version: 3, effectiveFrom: "2026-01-01",
      })
      .returning();
    const [vendorRow] = await tx
      .insert(contacts)
      .values({ type: "vendor", displayName: "ZZ Check Provenance Vendor" })
      .returning({ id: contacts.id });
    if (!rule || !vendorRow) throw new Error("could not make the scratch rule and vendor");

    // A credit line has to post somewhere; settlement takes the material's own
    // purchase account, and any expense account serves the same purpose here.
    const [expense] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.type, "expense"))
      .limit(1);
    if (!expense) throw new Error("Need an expense account");

    const [actor] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!actor) throw new Error("Need a user to post as");

    const vendor = await loadVendor(tx, vendorRow.id);
    const credit = await createVendorCredit(tx, {
      vendor,
      creditDate: "2026-08-17",
      notes: "provenance check",
      lines: [
        {
          name: rule.name,
          accountId: expense.id,
          quantity: "1.000",
          rate: "1234.560000",
          ruleId: rule.id,
          ruleVersion: rule.version,
        },
        // A figure somebody typed. Null is the honest record of that, not a
        // reason to invent a rule it did not come from.
        { name: "Agreed by hand", accountId: expense.id, quantity: "1.000", rate: "500.000000" },
      ],
      postedBy: actor.id,
    });

    const lines = await tx
      .select({
        name: vendorCreditLines.name,
        ruleId: vendorCreditLines.ruleId,
        ruleVersion: vendorCreditLines.ruleVersion,
        amount: vendorCreditLines.amount,
      })
      .from(vendorCreditLines)
      .where(eq(vendorCreditLines.vendorCreditId, credit.id));

    const fromRule = lines.find((l) => l.name === rule.name);
    const byHand = lines.find((l) => l.name === "Agreed by hand");
    check("the rule's id reaches the credit line", fromRule?.ruleId === rule.id, credit.number);
    check("so does the version that charged it", fromRule?.ruleVersion === rule.version, `v${fromRule?.ruleVersion}`);
    check("a hand-entered deduction records no rule", byHand?.ruleId === null, "null, not a guess");

    // The question the columns exist to answer.
    const asked = await tx.execute(sql`
      SELECT count(*)::int AS lines, sum(amount)::text AS total
      FROM vendor_credit_lines WHERE rule_id = ${rule.id}::uuid
    `);
    const row = asked.rows[0] as { lines: number; total: string };
    check(
      "a rule can be asked what it has cost",
      row.lines >= 1 && Number(row.total) >= 1234.56,
      `${row.lines} line(s), ₹${Number(row.total).toLocaleString("en-IN")}`,
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const strays = await db.select({ id: qcSpecs.id }).from(qcSpecs).where(eq(qcSpecs.version, 99));
const scratch = await db.select({ id: items.id }).from(items).where(eq(items.name, "ZZ Check Maize"));
check("nothing survives the run", strays.length === 0 && scratch.length === 0, `${strays.length} test spec(s) left`);

console.log(failed === 0 ? "\n  All provenance checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
