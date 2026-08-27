/**
 * Ask the controllers what they actually report, and print it.
 *
 * This is the script the bhfarm client's header points at: the vendor's own
 * behaviour checked directly, with no database in the way. When a figure on the
 * Shed conditions panel looks wrong, the question is always "is niko reading the
 * wrong tag, or is the tag itself wrong?" — and the only way to answer it is to
 * see every tag the controller offers, side by side, against a shed whose true
 * state is known.
 *
 * By default it shows the feed and water family, because that is the family the
 * vendor renamed on 2026-07-16 and the one whose old names still answer with
 * frozen values. Tags niko reads are marked, so a value that disagrees with the
 * in-house display points straight at the tag to switch to.
 *
 * The four frozen legacy tags are re-added here on purpose. The client excludes
 * them so they can never reach a reading; a probe that hid them could not tell
 * you whether the number you are staring at is today's or July's.
 *
 *   npx tsx scripts/probe-bhfarm.ts                 # feed + water, every house
 *   npx tsx scripts/probe-bhfarm.ts --house L3      # one shed (niko's code)
 *   npx tsx scripts/probe-bhfarm.ts --all           # every tag the template has
 *   npx tsx scripts/probe-bhfarm.ts --grep 只鸡      # tags matching a string
 *   npx tsx scripts/probe-bhfarm.ts --nulls         # include null-valued tags
 */
import {
  FROZEN_LEGACY_NAMES,
  METRIC_TAGS,
  SINGLE_TAGS,
  discoverDevices,
  discoverTagTree,
  fetchCurrentValues,
  nameOf,
  tokenExpiry,
} from "../server/services/iot/bhfarm";

/** The frozen legacy leaves, by full path — the client drops them from the tree. */
const LEGACY_LEAVES = [
  "基础数据.水料量.料塔实时重量",
  "基础数据.水料量.料塔本日累加料",
  "基础数据.水料量.今日用料量",
  "基础数据.水料量.今日用水量",
];

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (flag: string) => process.argv.includes(flag);

/** Tags niko resolves a panel figure from, by leaf name. */
const USED = new Map<string, string>();
for (const [metric, spec] of Object.entries(METRIC_TAGS)) {
  USED.set(spec.total, `${metric}.total`);
  spec.lines.forEach((l, i) => USED.set(l, `${metric}.line${i + 1}`));
}
for (const [field, name] of Object.entries(SINGLE_TAGS)) USED.set(name, field);

async function main() {
  if (!process.env.BH_TOKEN) throw new Error("BH_TOKEN is not set");
  const exp = tokenExpiry();
  console.log(`token expires ${exp ? exp.toISOString() : "unknown"}`);

  const devices = (await discoverDevices()).filter((d) => d.enabled);
  const wanted = arg("--house");
  const picked = wanted
    ? devices.filter((d) => d.name.toLowerCase().includes(wanted.toLowerCase()))
    : devices;
  if (!picked.length) {
    console.log(`No enabled device matches ${wanted}. Known: ${devices.map((d) => d.name).join(", ")}`);
    return;
  }

  const { leaves } = await discoverTagTree();
  const all = [...leaves, ...LEGACY_LEAVES];

  const grep = arg("--grep");
  const selected = has("--all")
    ? all
    : grep
      ? all.filter((l) => l.includes(grep))
      : // 料 = feed, 水 = water. The whole family, numbered lines included.
        all.filter((l) => l.includes("料") || l.includes("水"));

  console.log(`${picked.length} house(s), ${selected.length} tag(s) each\n`);

  for (const d of picked) {
    const ids = selected.map((leaf) => `${d.houseCode}.${leaf}`);
    const values = await fetchCurrentValues(ids);
    const byName = new Map<string, (typeof values)[number]>();
    for (const v of values) byName.set(nameOf(v.tagId), v);

    console.log(`══ ${d.name}  (${d.houseCode})`);
    const rows: string[][] = [];
    for (const leaf of selected) {
      const name = nameOf(leaf);
      const v = byName.get(name);
      const raw = v?.value ?? null;
      if (raw == null && !has("--nulls")) continue;
      const marks = [
        USED.has(name) ? `niko:${USED.get(name)}` : "",
        FROZEN_LEGACY_NAMES.has(name) ? "FROZEN 16-Jul" : "",
        v && v.quality !== 0 && v.quality !== 192 ? `quality=${v.quality}` : "",
      ].filter(Boolean);
      rows.push([name, raw ?? "—", v?.unit ?? "", marks.join("  ")]);
    }
    if (!rows.length) {
      console.log("   (every selected tag is null)\n");
      continue;
    }
    const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) {
      console.log(
        `   ${r[0]!.padEnd(w[0])}  ${r[1]!.padStart(w[1])} ${r[2]!.padEnd(w[2])}  ${r[3]}`,
      );
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
