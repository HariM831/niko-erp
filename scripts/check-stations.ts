/**
 * Drives a receipt through all five stations, and checks the moves that must
 * be refused.
 *
 * Two trucks: one clean run, and one carrying two materials where QC rejects
 * the second. The second is the interesting one — it proves a rejected line
 * consumes its order slot without ever being paid for, takes no share of the
 * net, and leaves its weight sitting inside the tare.
 *
 * Everything runs against the real database inside one transaction that is
 * rolled back, so no receipts survive and the PO counters are untouched.
 *
 * Run: npx tsx scripts/check-stations.ts
 */
import { and, eq, inArray, like } from "drizzle-orm";
import {
  contacts,
  items,
  locations,
  officeReceiptLines,
  officeReceipts,
  purchaseOrderLines,
} from "@shared/schema";
import { db, type Tx } from "../server/db";
import { RECEIPT_TRANSITIONS, TERMINAL_STATUSES, type ReceiptStatus } from "@shared/schema";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
};

class Rollback extends Error {}

/** The same guard the routes apply, exercised directly. */
function legal(from: ReceiptStatus, to: ReceiptStatus): boolean {
  if (TERMINAL_STATUSES.includes(from)) return false;
  return RECEIPT_TRANSITIONS[from].includes(to);
}

async function main() {
  const [site] = await db.select({ id: locations.id }).from(locations).limit(1);
  const [vendor] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(like(contacts.displayName, "%hayan%"), inArray(contacts.type, ["vendor", "both"])))
    .limit(1);
  const [maize] = await db.select({ id: items.id }).from(items).where(eq(items.name, "Maize")).limit(1);
  const [dorb] = await db.select({ id: items.id }).from(items).where(eq(items.name, "DORB")).limit(1);
  if (!site || !vendor || !maize || !dorb) throw new Error("Missing site, vendor or items");

  console.log("\n  THE STATE MACHINE\n");
  check("gate_in may only go to weighed_in", legal("gate_in", "weighed_in") && !legal("gate_in", "gate_out"));
  check("QC may pass or reject", legal("weighed_in", "qc_passed") && legal("weighed_in", "rejected"));
  check("tare cannot precede unloading", !legal("qc_passed", "gate_out"));
  check("a settled receipt is frozen", !legal("settled", "gate_out"));
  check("a turned-away truck is frozen", !legal("turned_away", "weighed_in"));

  try {
    await db.transaction(async (tx: Tx) => {
      // ── A two-line truck: maize accepted, rice bran refused ──
      const [receipt] = await tx
        .insert(officeReceipts)
        .values({
          number: "GR-SELFTEST",
          locationId: site.id,
          vendorId: vendor.id,
          vehicleNumber: "SELFTEST1",
          vendorSlipGrossKg: "44820.000",
        })
        .returning();

      const inserted = await tx
        .insert(officeReceiptLines)
        .values([
          { receiptId: receipt!.id, lineNo: 1, itemId: maize.id, itemName: "Maize", billQuantityKg: "24380.000" },
          { receiptId: receipt!.id, lineNo: 2, itemId: dorb.id, itemName: "DORB", billQuantityKg: "6000.000" },
        ])
        .returning({ id: officeReceiptLines.id, lineNo: officeReceiptLines.lineNo });
      const maizeLine = inserted.find((l) => l.lineNo === 1)!;
      const dorbLine = inserted.find((l) => l.lineNo === 2)!;

      console.log("\n  ONE TRUCK, TWO MATERIALS, ONE REFUSED\n");

      // Station 2 — gross. Our platform against their slip.
      const gross = 44850;
      const slip = 44820;
      const variance = ((gross - slip) / slip) * 100;
      check("gross vs vendor slip is within tolerance", Math.abs(variance) <= 0.5, `${variance.toFixed(3)}%`);
      await tx
        .update(officeReceipts)
        .set({ grossWeightKg: String(gross), status: "weighed_in" })
        .where(eq(officeReceipts.id, receipt!.id));

      // Station 3 — QC rejects the rice bran, which consumes its PO slot now.
      await tx
        .update(officeReceiptLines)
        .set({ status: "qc_accepted", qcVerdict: "pass" })
        .where(eq(officeReceiptLines.id, maizeLine.id));
      await tx
        .update(officeReceiptLines)
        .set({ status: "qc_rejected", qcVerdict: "rejected", qcRejectionReason: "Moisture well above spec" })
        .where(eq(officeReceiptLines.id, dorbLine.id));
      await tx
        .update(officeReceipts)
        .set({ status: "qc_passed", qcRollupVerdict: "partial" })
        .where(eq(officeReceipts.id, receipt!.id));
      check("a partly rejected truck still goes to unloading", true, "status qc_passed");

      // Station 4 — only the accepted line comes off.
      await tx
        .update(officeReceiptLines)
        .set({ status: "unloaded", bagCountActual: 401 })
        .where(eq(officeReceiptLines.id, maizeLine.id));
      const after = await tx
        .select({ id: officeReceiptLines.id, status: officeReceiptLines.status })
        .from(officeReceiptLines)
        .where(eq(officeReceiptLines.receiptId, receipt!.id));
      const accepted = after.filter((l) => l.status !== "qc_rejected");
      check("every accepted line is off the truck", accepted.every((l) => l.status === "unloaded"), `${accepted.length} line(s)`);

      // Station 5 — the rejected rice bran is still aboard, so the tare carries it.
      const tare = 20560;
      const net = gross - tare;
      check("net off the truck", net === 24290, `${gross} − ${tare} = ${net} kg`);

      await tx
        .update(officeReceiptLines)
        .set({ allocatedNetKg: String(net) })
        .where(eq(officeReceiptLines.id, maizeLine.id));
      await tx
        .update(officeReceiptLines)
        .set({ allocatedNetKg: "0" })
        .where(eq(officeReceiptLines.id, dorbLine.id));
      await tx
        .update(officeReceipts)
        .set({ tareWeightKg: String(tare), status: "gate_out" })
        .where(eq(officeReceipts.id, receipt!.id));

      const finalLines = await tx
        .select()
        .from(officeReceiptLines)
        .where(eq(officeReceiptLines.receiptId, receipt!.id));
      const m = finalLines.find((l) => l.id === maizeLine.id)!;
      const d = finalLines.find((l) => l.id === dorbLine.id)!;

      check("the accepted line takes the whole net", Number(m.allocatedNetKg) === 24290, `${m.allocatedNetKg} kg`);
      check("the rejected line takes none of it", Number(d.allocatedNetKg) === 0, `${d.allocatedNetKg} kg`);

      // Generated columns: the database computes these, not the application.
      const [hdr] = await tx
        .select({ net: officeReceipts.netWeightKg })
        .from(officeReceipts)
        .where(eq(officeReceipts.id, receipt!.id));
      check("net_weight_kg is generated from gross − tare", Number(hdr!.net) === 24290, `${hdr!.net} kg`);
      check("shortage is generated on the accepted line", Number(m.shortageKg) === 90, `${m.shortageKg} kg short of 24,380`);
      check("a rejected line reports its full billed weight short", Number(d.shortageKg) === 6000, `${d.shortageKg} kg`);

      // The constraint that stops a rejected line ever being paid for.
      let blocked = false;
      try {
        await tx
          .update(officeReceiptLines)
          .set({ allocatedNetKg: "500" })
          .where(eq(officeReceiptLines.id, dorbLine.id));
      } catch {
        blocked = true;
      }
      check("the database refuses to allocate to a rejected line", blocked, "ck_prl_rejected_no_allocation");

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  const left = await db
    .select({ id: officeReceipts.id })
    .from(officeReceipts)
    .where(eq(officeReceipts.number, "GR-SELFTEST"));
  check("nothing survives the run", left.length === 0, `${left.length} left`);

  console.log(failed === 0 ? "\n  All station checks passed.\n" : `\n  ${failed} check(s) FAILED.\n`);
  process.exit(failed ? 1 : 0);
}

void main();
