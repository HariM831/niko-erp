/**
 * Checks that an NIR scan lands on the right truck, or on none.
 *
 * The technician types the GR number into IAS by hand. The cases that matter
 * are the ones where that link is wrong or ambiguous: a scan must never be
 * forced onto a line, and a scan that is used must stay where it was used.
 *
 * Makes its own site, vendor, materials, specs and receipts inside one
 * transaction that is rolled back.
 *
 * Run: npx tsx scripts/check-nir.ts
 */
import { eq } from "drizzle-orm";
import {
  contacts,
  items,
  locations,
  nirModelItems,
  nirResults,
  officeReceiptLines,
  officeReceipts,
  qcSpecParams,
  qcSpecs,
} from "@shared/schema";
import { dryMatterBase, qcParameterFor, sampleKey, type NirUploadRow } from "@shared/nir";
import { db, type Tx } from "../server/db";
import { NirMatchError, averageScans, consumeScans, ingest, nirForReceipt } from "../server/services/nir";

const round = (n: number) => Math.round(n * 1000) / 1000;

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};

class Rollback extends Error {}

async function main() {
  console.log("\n  FOLDING A TYPED GR NUMBER\n");
  check("GR-00026, gr 26 and GR26 are one key",
    sampleKey("GR-00026") === "GR26" && sampleKey("gr 26") === "GR26" && sampleKey(" GR-026 ") === "GR26");
  check("a name with no digits is no key", sampleKey("maize") === null);
  check("IAS's default prefix never folds to a GR", sampleKey("Sfrf20") !== sampleKey("GR-00020"));
  check("oil is fat, fibre is fiber, SS is sand silica",
    qcParameterFor("oil") === "fat" && qcParameterFor("Fibre") === "fiber" && qcParameterFor("SS") === "sand_silica");
  check("an unknown name fills nothing", qcParameterFor("UA") === null);

  console.log("\n  DRY MATTER TO AS RECEIVED\n");
  check("Protein (DM) is dry matter, Moisture is not", dryMatterBase("Protein (DM)") === "Protein" && dryMatterBase("Moisture") === null);
  const corn = (sn: string, moisture: number, proteinDm: number) => ({
    resultSn: sn, model: "Corn", sampleName: "GR-1", scannedAt: new Date().toISOString(),
    readings: { "Fat (DM)": 3.6, Moisture: moisture, "Starch (DM)": 63.5, "Protein (DM)": proteinDm }, flagged: [],
  });
  const dm = averageScans([corn("a", 6, 10), corn("b", 14, 10)]);
  // 10 × 0.94 = 9.4 and 10 × 0.86 = 8.6, so 9.0.
  check("each scan converts with its own moisture", dm.average.protein === 9, String(dm.average.protein));
  const uneven = averageScans([corn("a", 6, 10), corn("b", 14, 12)]);
  check("…and is averaged after converting", uneven.average.protein === round(((10 * 94) / 100 + (12 * 86) / 100) / 2),
    String(uneven.average.protein));
  check("moisture itself is untouched", dm.average.moisture === 10);
  check("protein and fat are marked as from DM", dm.fromDryMatter.sort().join() === "fat,protein");
  check("starch is kept as the instrument reported it", dm.instrument["Starch (DM)"] === 63.5 && !("starch" in dm.average));

  try {
    await db.transaction(async (tx: Tx) => {
      const [site] = await tx.insert(locations).values({ code: "NIRTEST", name: "TEST NIR SITE" }).returning();
      const [vendor] = await tx.insert(contacts).values({ displayName: "TEST NIR VENDOR", type: "vendor" }).returning();
      const material = async (name: string) => {
        const [it] = await tx
          .insert(items)
          .values({ name, unit: "kg", isSold: false, category: "feed", isFeedIngredient: true })
          .returning({ id: items.id, name: items.name });
        const [spec] = await tx.insert(qcSpecs).values({ itemId: it!.id, version: 99, effectiveFrom: "2026-01-01" }).returning();
        await tx.insert(qcSpecParams).values([
          { specId: spec!.id, parameter: "moisture", label: "Moisture", direction: "max", warnAt: "12", rejectAt: "13" },
          { specId: spec!.id, parameter: "protein", label: "Protein", direction: "min", warnAt: "45", rejectAt: "43" },
        ]);
        return it!;
      };
      const sbm = await material("TEST NIR SBM");
      const maize = await material("TEST NIR MAIZE");
      await tx.insert(nirModelItems).values({ shortName: "ZZSoyadoc", itemId: sbm.id });

      const arrived = new Date(Date.now() - 60 * 60_000);
      const receipt = async (number: string, lineItems: Array<{ id: string; name: string }>) => {
        const [r] = await tx
          .insert(officeReceipts)
          .values({ number, locationId: site!.id, vendorId: vendor!.id, vehicleNumber: `NIR${number.slice(-3)}`, status: "weighed_in", arrivalAt: arrived })
          .returning();
        const lines = await tx
          .insert(officeReceiptLines)
          .values(lineItems.map((it, i) => ({ receiptId: r!.id, lineNo: i + 1, itemId: it.id, itemName: it.name, billQuantityKg: "10000.000" })))
          .returning();
        return { r: r!, lines };
      };
      // Numbers no real series uses, so no real receipt folds to the same key.
      const one = await receipt("ZQ-90001", [sbm, maize]);
      const two = await receipt("ZQ-90002", [sbm, sbm]);
      const lite = (x: typeof one) => ({
        receipt: { id: x.r.id, number: x.r.number, status: x.r.status, arrivalAt: x.r.arrivalAt },
        lines: x.lines.map((l) => ({ id: l.id, receiptId: l.receiptId, itemId: l.itemId, itemName: l.itemName, status: l.status })),
      });

      const scan = (sn: string, sample: string, readings: Record<string, number>, extra: Partial<NirUploadRow> = {}): NirUploadRow => ({
        iasId: 1, resultSn: sn, deviceSn: "ZZDEV", model: "ZZSoyadoc", modelVersion: "1",
        sampleName: sample, scannedAt: new Date().toISOString(), iasStatus: 1,
        readings, flags: Object.fromEntries(Object.keys(readings).map((k) => [k, 0])), raw: null, ...extra,
      });
      const userId = null as unknown as string;
      await ingest(tx, [
        scan("ZZ-1", "zq 90001", { Moisture: 11.5, Protein: 46.2, SS: 1.1, UA: 0.05 }),
        scan("ZZ-2", "ZQ90001", { Moisture: 11.9, Protein: 45.8, SS: 1.3, UA: 0.04 }, { flags: { Moisture: 3, Protein: 0, SS: 0, UA: 0 } }),
        scan("ZZ-3", "ZQ-90002", { Moisture: 12, Protein: 46 }),
        scan("ZZ-4", "ZQ-90001", { Moisture: 12, Protein: 46 }, { model: "ZZUnlinked" }),
        scan("ZZ-5", "ZQ-90001", { Moisture: 12, Protein: 46 }, { scannedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() }),
      ], [], "ZZDEV", userId);

      console.log("\n  PLACING SCANS ON A TWO-MATERIAL TRUCK\n");
      const a = lite(one);
      const nirA = await nirForReceipt(tx, a.receipt, a.lines);
      const sbmLine = one.lines.find((l) => l.itemId === sbm.id)!;
      const onSbm = nirA.byLine[sbmLine.id];
      check("both typed spellings land on the SBM line", onSbm?.scans.length === 2, `${onSbm?.scans.length ?? 0} scans`);
      check("moisture is averaged", onSbm?.average.moisture === 11.7, String(onSbm?.average.moisture));
      check("protein is averaged", onSbm?.average.protein === 46, String(onSbm?.average.protein));
      check("SS fills sand silica", onSbm?.average.sand_silica === 1.2, String(onSbm?.average.sand_silica));
      check("the instrument's flag carries to the parameter", !!onSbm?.flagged.includes("moisture"));
      check("nothing lands on the maize line", !nirA.byLine[one.lines.find((l) => l.itemId === maize.id)!.id]);
      const reasons = nirA.unplaced.map((u) => `${u.scan.resultSn}: ${u.reason}`);
      check("an unlinked model is left unplaced", reasons.some((r) => r.startsWith("ZZ-4") && r.includes("not linked")), reasons.join(" | "));
      check("a scan from before the truck arrived is unplaced", reasons.some((r) => r.startsWith("ZZ-5") && r.includes("before")));

      console.log("\n  TWO LINES OF ONE MATERIAL\n");
      const b = lite(two);
      const nirB = await nirForReceipt(tx, b.receipt, b.lines);
      check("no line is guessed", Object.keys(nirB.byLine).length === 0);
      check("the reason says to type by hand", nirB.unplaced[0]?.reason.includes("by hand") ?? false, nirB.unplaced[0]?.reason ?? "");

      console.log("\n  RENAMING IN IAS\n");
      await ingest(tx, [scan("ZZ-3", "ZQ-90001", { Moisture: 12, Protein: 46 })], [], "ZZDEV", userId);
      const moved = await nirForReceipt(tx, a.receipt, a.lines);
      check("a renamed scan moves to the truck now named", moved.byLine[sbmLine.id]?.scans.length === 3);

      console.log("\n  SAVING QC\n");
      const used = await consumeScans(tx, a.receipt, a.lines, sbmLine.id, ["ZZ-1", "ZZ-2", "ZZ-3"],
        { moisture: 11.6, protein: 46, sand_silica: 1.2 }, userId);
      check("a typed-over figure is recorded as edited", used.edited.join() === "moisture", used.edited.join(","));
      const after = await tx.select().from(nirResults).where(eq(nirResults.resultSn, "ZZ-1"));
      check("a used scan is fixed to its line", after[0]?.receiptLineId === sbmLine.id);

      let refused = "";
      try {
        await consumeScans(tx, a.receipt, a.lines, sbmLine.id, ["ZZ-1"], {}, userId);
      } catch (e) {
        if (e instanceof NirMatchError) refused = e.message;
        else throw e;
      }
      check("a scan cannot be used twice", refused !== "", refused);

      await ingest(tx, [scan("ZZ-1", "ZQ-90002", { Moisture: 99, Protein: 1 })], [], "ZZDEV", userId);
      const still = await tx.select().from(nirResults).where(eq(nirResults.resultSn, "ZZ-1"));
      check("renaming a used scan in IAS changes nothing", still[0]?.sampleName === "zq 90001" && (still[0]?.readings as Record<string, number>).Moisture === 11.5);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  console.log(failed ? `\n  ${failed} FAILED\n` : "\n  All passed. Rolled back.\n");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
