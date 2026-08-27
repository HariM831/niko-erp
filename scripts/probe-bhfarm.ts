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
 *
 * And the intraday series, which is what tells a live counter from a stuck one.
 * A daily total that never moves between midnight and now is not a slow farm;
 * it is a tag that has stopped being written:
 *
 *   npx tsx scripts/probe-bhfarm.ts --history 5 --hours 24
 *   npx tsx scripts/probe-bhfarm.ts --history 5 --tags 今日总用料量,料塔卸料总累计
 */
import {
  FROZEN_LEGACY_NAMES,
  METRIC_TAGS,
  SINGLE_TAGS,
  discoverDevices,
  discoverTagTree,
  fetchCurrentValues,
  fetchHistoryRows,
  nameOf,
  tokenExpiry,
  unpackHistoryRow,
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

/**
 * The intraday series for one house: how each tag moved since midnight.
 *
 * The live endpoint can only ever show you a number. Whether that number is
 * TODAY's or the one the controller last managed to push is a question about
 * change over time, and this is the only view that answers it.
 */
async function history(houseName: string) {
  const devices = (await discoverDevices()).filter((d) => d.enabled);
  const d = devices.find((x) => x.name.toLowerCase() === houseName.toLowerCase())
    ?? devices.find((x) => x.name.toLowerCase().includes(houseName.toLowerCase()));
  if (!d) {
    console.log(`No enabled device matches ${houseName}. Known: ${devices.map((x) => x.name).join(", ")}`);
    return;
  }

  const hours = Number(arg("--hours") ?? 24);
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  const rows = await fetchHistoryRows({ houseCode: d.houseCode, from, to, spanMinutes: 60 });
  if (!rows.length) {
    console.log(`${d.name}: history returned no rows for the last ${hours}h`);
    return;
  }

  const series0 = rows
    .map((r) => ({ at: String(r.time ?? r.Time ?? ""), vals: unpackHistoryRow(d.houseCode, r) }))
    .filter((s) => s.at)
    .sort((a, b) => a.at.localeCompare(b.at));

  // --moved: every tag that changed, whatever it is called.
  //
  // Asking "which tag holds today's feed?" by name assumes we know the name.
  // The vendor has renamed this family once already, and the old names kept
  // answering with stale values. Ranking by whether a value CHANGED finds the
  // live counter without knowing what it is called this month.
  if (has("--moved")) {
    const seen = new Map<string, string[]>();
    for (const s of series0) {
      for (const v of s.vals) {
        if (v.value == null) continue;
        const k = nameOf(v.tagId);
        const list = seen.get(k) ?? seen.set(k, []).get(k)!;
        if (list[list.length - 1] !== v.value) list.push(v.value);
      }
    }
    const moved = [...seen.entries()].filter(([, v]) => v.length > 1);
    const flat = [...seen.entries()].filter(([, v]) => v.length === 1);
    console.log(`══ ${d.name}  (${d.houseCode})   last ${hours}h\n`);
    console.log(`   MOVED (${moved.length}):`);
    for (const [k, v] of moved.sort((a, b) => b[1].length - a[1].length)) {
      console.log(`     ${k.padEnd(16)} ${v.length} values   ${v[0]} → ${v[v.length - 1]}`);
    }
    console.log(`\n   FLAT (${flat.length}):`);
    for (const [k, v] of flat) console.log(`     ${k.padEnd(16)} ${v[0]}`);
    return;
  }

  const want = (arg("--tags") ?? "今日总用料量,今日总用水量,料塔当前总料量,料塔卸料总累计,料塔本日总卸料量")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`══ ${d.name}  (${d.houseCode})   last ${hours}h, hourly\n`);
  const series = rows
    .map((r) => {
      const vals = unpackHistoryRow(d.houseCode, r);
      const by = new Map(vals.map((v) => [nameOf(v.tagId), v.value]));
      return { at: String(r.time ?? r.Time ?? ""), by };
    })
    .filter((s) => s.at)
    .sort((a, b) => a.at.localeCompare(b.at));

  const head = ["time", ...want];
  const body = series.map((s) => [
    s.at.replace("T", " ").slice(5, 16),
    ...want.map((t) => s.by.get(t) ?? "—"),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  console.log("   " + head.map((h, i) => h.padEnd(w[i]!)).join("  "));
  for (const r of body) console.log("   " + r.map((c, i) => c.padEnd(w[i]!)).join("  "));

  // The whole point: which of these actually changed today?
  console.log();
  for (const t of want) {
    const seen = [...new Set(series.map((s) => s.by.get(t)).filter((v) => v != null))];
    const verdict =
      seen.length === 0 ? "no data" : seen.length === 1 ? `FLAT at ${seen[0]} all ${hours}h` : `moved (${seen.length} distinct)`;
    console.log(`   ${t.padEnd(12)} ${verdict}`);
  }
}

async function main() {
  if (!process.env.BH_TOKEN) throw new Error("BH_TOKEN is not set");
  const exp = tokenExpiry();
  console.log(`token expires ${exp ? exp.toISOString() : "unknown"}`);

  const hist = arg("--history");
  if (hist) return history(hist);

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
