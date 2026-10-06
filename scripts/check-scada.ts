/**
 * Checks the feed mill SCADA copy: batches land once, read in IST, by their
 * own bin names; usage merges what is one material and drops nothing that was
 * weighed; and a SCADA device's token opens nothing that names a person.
 *
 * Makes its own site, device and batches inside one transaction that is rolled
 * back.
 *
 * Run: npx tsx scripts/check-scada.ts
 */
import { eq } from "drizzle-orm";
import { devices, locations, scadaBatches } from "@shared/schema";
import { db, type Tx } from "../server/db";
import { checkDeviceToken, hashToken } from "../server/routes/device";
import { istInstant, storeBatches, summarizeUsage, type ScadaRow } from "../server/routes/scada";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
};
class Rollback extends Error {}

const row = (time: string, recipe: string, qty: number, set: number[], act: number[], names: string[]): ScadaRow => ({
  time,
  recipe,
  qty,
  set,
  act,
  names,
});

async function main() {
  console.log("\n  THE PC'S CLOCK\n");
  const t = istInstant("2026-10-06 11:54:35.733");
  check("SCADA local time is read as IST", t.toISOString() === "2026-10-06T06:24:35.733Z", t.toISOString());
  check("…with no fraction too", istInstant("2026-10-06 00:10:00").toISOString() === "2026-10-05T18:40:00.000Z");

  try {
    await db.transaction(async (tx: Tx) => {
      const [site] = await tx.insert(locations).values({ code: "SCADATST", name: "TEST SCADA SITE" }).returning();
      const [dev] = await tx
        .insert(devices)
        .values({ name: "TEST SCADA PC", role: "scada", locationId: site!.id, tokenHash: hashToken("zz-test-scada-token") })
        .returning();

      console.log("\n  STORING\n");
      // Far in the past, so no real batch shares the key.
      const names = ["DORB", "STONE", "MAIZE", "MAIZE", "DDGS", "SOYA", "MAIZE", "DORB"];
      const rows = [
        row("2001-01-01 10:00:00.100", "Layer  3", 1, [181, 153, 170, 370, 75, 194, 322, 0], [184, 158, 176, 386, 78, 194, 330, 0], names),
        row("2001-01-01 10:05:00.200", "Layer  3", 2, [181, 153, 170, 370, 75, 194, 322, 0], [183, 157, 175, 372, 78, 194, 332, 0], names),
      ];
      check("two new batches are stored", (await storeBatches(tx, rows, dev!.id)) === 2);
      check("sending them again stores nothing", (await storeBatches(tx, rows, dev!.id)) === 0);
      const [kept] = await tx.select().from(scadaBatches).where(eq(scadaBatches.sourceTime, "2001-01-01 10:00:00.100"));
      check("totals are the sum of the bins", Number(kept?.setTotalKg) === 1465 && Number(kept?.actTotalKg) === 1506,
        `${kept?.setTotalKg} / ${kept?.actTotalKg}`);
      const bins = kept?.bins as Array<{ bin: number; name: string }>;
      check("each bin keeps the name it had in that batch", bins[0]?.name === "DORB" && bins[1]?.name === "STONE");

      console.log("\n  USAGE\n");
      const stored = await tx.select().from(scadaBatches).where(eq(scadaBatches.deviceId, dev!.id));
      const binMap = new Map([["MAIZE", { itemId: "maize-id", itemName: "Maize" }]]);
      const u = summarizeUsage(stored, binMap, new Map());
      const maize = u.materials.find((m) => m.name === "Maize");
      check("three maize bins are one maize", maize?.setKg === 2 * (170 + 370 + 322), String(maize?.setKg));
      const dorb = u.materials.find((m) => m.name === "DORB");
      check("an unmapped name is kept under its own spelling", !!dorb && !dorb.mapped && dorb.actKg === 184 + 183);
      check("…and listed as unmapped", u.unmapped.bins.includes("DORB") && u.unmapped.bins.includes("STONE"));
      check("a bin with nothing set or weighed is not a material",
        u.materials.reduce((s, m) => s + m.actKg, 0) === 1506 + 1491, String(u.materials.reduce((s, m) => s + m.actKg, 0)));
      check("the recipe's spacing is folded but not its name", u.unmapped.recipes.join() === "LAYER 3");
      check("both batches fall on their IST day", u.days.length === 1 && u.days[0]?.day === "2001-01-01" && u.days[0]?.batches === 2);

      console.log("\n  THE SCADA TOKEN\n");
      const asScada = await checkDeviceToken(tx, "zz-test-scada-token", "scada");
      check("it opens the SCADA upload", asScada.ok);
      const asPhone = await checkDeviceToken(tx, "zz-test-scada-token", ["gate", "canteen"]);
      check("it does not open the people endpoints", !asPhone.ok && asPhone.status === 403);

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
