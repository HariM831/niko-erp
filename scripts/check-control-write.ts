/**
 * Stage 0 of the shed controls: prove that niko can write a register to a
 * controller and see it take.
 *
 * Re-saves ONE register on ONE house with the value it already holds, through
 * the same path every future write will use (`writeAndConfirm`), and prints
 * the vendor's reply and the readback. The register is the level-increase
 * delay, a timing in seconds; written unchanged it alters nothing in the shed.
 *
 *   npx tsx scripts/check-control-write.ts                  (read only)
 *   npx tsx scripts/check-control-write.ts --apply          (the same-value write)
 *   npx tsx scripts/check-control-write.ts --house 3 --apply
 *
 * No database: this talks to bhfarm.net only, with BH_TOKEN.
 */
import { discoverDevices, fetchDeviceStatus, readRegisters } from "../server/services/iot/bhfarm";
import { writeAndConfirm } from "../server/services/iot/control";

const APPLY = process.argv.includes("--apply");
const i = process.argv.indexOf("--house");
const HOUSE = i > -1 ? process.argv[i + 1]! : "2";
/** 基础控制.通风级别调整.提高级别延时时间 — "increase level delay time", seconds, range 10–300. */
const REGISTER = "基础控制.通风级别调整.提高级别延时时间";

const devices = await discoverDevices();
const dev = devices.find((d) => d.name === HOUSE);
if (!dev) {
  console.error(`no house named ${HOUSE}; known: ${devices.map((d) => d.name).join(", ")}`);
  process.exit(1);
}
const fullName = `${dev.houseCode}.${REGISTER}`;

const status = await fetchDeviceStatus(dev.houseCode);
console.log(`\n  house ${HOUSE} (${dev.houseCode}): controller ${status.isLiving ? "reachable" : "NOT reachable"}`);
const [current] = await readRegisters([fullName]);
console.log(`  ${REGISTER} = ${current?.value ?? "?"} s`);

if (!APPLY) {
  console.log("\n  read only — add --apply to re-save this value unchanged through niko's write path\n");
  process.exit(0);
}
if (!current) {
  console.error("  the register did not answer; not writing");
  process.exit(1);
}

const record = await writeAndConfirm(dev.houseCode, [{ key: fullName, value: current.value }]);
console.log(`\n  vendor reply: ${JSON.stringify(record.reply)}`);
console.log(`  refused: ${record.refused}`);
for (const r of record.registers) {
  console.log(`  ${r.fullName.split(".").pop()}: before ${r.before}, sent ${r.sent}, after ${r.after} → ${r.took ? "took" : "DID NOT TAKE"}`);
}
console.log(`  ${(record.finishedAt.getTime() - record.startedAt.getTime()) / 1000}s end to end`);
console.log(record.confirmed ? "\n  stage 0: the write path works\n" : "\n  stage 0: NOT confirmed — read the reply above\n");
process.exit(record.confirmed ? 0 : 1);
