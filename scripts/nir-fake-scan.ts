/**
 * Writes pretend NIR scans into a COPY of an IAS pro2.db, for rehearsing the
 * NIR feed away from the bench — no analyser, no weighbridge.
 *
 * Point Chrome's "Connect NIR" at the copy, then run this to make IAS-shaped
 * rows appear in it, exactly as IAS would write them after a soya-meal scan.
 * Never point it at the real bench file.
 *
 *   npx tsx scripts/nir-fake-scan.ts <file> add <sample name> [count] [model]
 *   npx tsx scripts/nir-fake-scan.ts <file> rename <resultSn> <new sample name>
 *   npx tsx scripts/nir-fake-scan.ts <file> list
 *
 * Model defaults to SoyadocIN (ash, fibre, moisture, oil, protein, SS, UA).
 */
import { DatabaseSync } from "node:sqlite";

const [file, cmd, ...args] = process.argv.slice(2);
if (!file || !cmd) {
  console.log("usage: nir-fake-scan.ts <pro2.db copy> add|rename|list …");
  process.exit(1);
}
const db = new DatabaseSync(file);

/** IAS's own local-time text: IST wall clock, no zone. */
const istNow = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 23);
const jitter = (v: number, by: number) => Math.round((v + (Math.random() - 0.5) * 2 * by) * 1e6) / 1e6;

if (cmd === "add") {
  const sample = args[0]!;
  const count = Number(args[1] ?? 1);
  const model = args[2] ?? "SoyadocIN";
  for (let i = 0; i < count; i++) {
    const at = istNow();
    const stamp = at.replace(/\D/g, "").slice(0, 14);
    const resultSn = `FAKE${stamp}-${String(i + 1).padStart(3, "0")}`;
    // A believable soya meal: ash, fibre, moisture, oil, protein, SS, UA.
    const values: Record<string, number> = {
      "1": jitter(6.6, 0.2),
      "2": jitter(5.4, 0.3),
      "3": jitter(11.4, 0.4),
      "4": jitter(1.3, 0.2),
      "5": jitter(46.1, 0.6),
      "6": jitter(1.1, 0.2),
      "7": jitter(0.06, 0.02),
    };
    const items = {
      InnerValues: values,
      MasVal: {},
      RealValues: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
      ResultColors: Object.fromEntries(Object.keys(values).map((k) => [k, 0])),
      ResultSN: resultSn,
      ResultValues: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.toFixed(2)])),
      ScanTime: at.replace("T", " "),
      ShortName: model,
      ShowMatter: ["2", "3", "4", "5", "6", "7", "1"],
      TestValues: values,
      Version: "1.0.0.0",
    };
    db.prepare(
      `INSERT INTO DBResult (devicesn, modelname, samplename, channel, items, info, status, generatedate, resultsn, creater)
       VALUES ('KFAL34N0', ?, ?, 0, ?, '{}', 1, ?, ?, 'admin')`,
    ).run(model, sample, JSON.stringify(items), at, resultSn);
    console.log(`added ${resultSn}  sample "${sample}"  moisture ${values["3"]}  protein ${values["5"]}`);
  }
} else if (cmd === "rename") {
  const [sn, name] = args;
  const out = db.prepare("UPDATE DBResult SET samplename = ? WHERE resultsn = ?").run(name!, sn!);
  console.log(out.changes ? `renamed ${sn} to "${name}"` : `no scan ${sn}`);
} else if (cmd === "list") {
  for (const r of db.prepare("SELECT resultsn, samplename, modelname, generatedate FROM DBResult ORDER BY id DESC LIMIT 20").all())
    console.log(`${r.resultsn}  "${r.samplename}"  ${r.modelname}  ${r.generatedate}`);
}
db.close();
