/**
 * Read the Amino export and reconcile it before anything is imported.
 *
 * niko derives a flock's bird count from its movements and refuses any
 * movement that would leave a house holding fewer than zero birds. So the
 * numbers have to add up BEFORE the import runs, not during it.
 *
 * Two things about the source shape are worth knowing, because both are
 * invisible until you go looking:
 *
 * A batch is not one arrival. The first hatch is a `bird_stock` row; every
 * later hatch of the same batch arrives days afterwards as `birds_transferred_in`
 * on the daily sheet. A batch of 130,000 therefore looks like a batch of 36,000
 * until the arrivals are added back.
 *
 * `daily_bird_records.batch_number` cannot be trusted. Its own schema comment
 * says it was backfilled for a migration, and it shows: B240925 carries two
 * arrivals from February 2026, five months after it was placed and in the same
 * week a DIFFERENT batch was placed in the same house. Arrivals are therefore
 * resolved by SHED AND DATE — which batch was actually standing there — and
 * never by that column.
 *
 *   npx tsx scripts/check-amino-export.ts --file farm-export/farm-export.json
 */
import { readFile } from "node:fs/promises";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const FILE = arg("file") ?? "farm-export/farm-export.json";

type Row = Record<string, unknown>;
const exp = JSON.parse(await readFile(FILE, "utf8")) as { data: Record<string, Row[]> };
const t = (name: string) => exp.data[name] ?? [];

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const s = (v: unknown) => (v == null ? "" : String(v));
const day = (v: unknown) => s(v).slice(0, 10);
const num = (v: number) => v.toLocaleString("en-IN");

const sheds = new Map(t("sheds").map((r) => [s(r.id), s(r.name)]));
const stock = t("bird_stock");
const transfers = t("batch_transfers");
const daily = t("daily_bird_records");

let problems = 0;
let warnings = 0;
/** Something that will stop the import. */
const problem = (msg: string) => {
  problems++;
  console.log(`   ! ${msg}`);
};
/** Something wrong in the source that the import already handles. */
const warn = (msg: string) => {
  warnings++;
  console.log(`   · ${msg}`);
};

console.log("\n  RECONCILING THE AMINO EXPORT\n");

/* ── Which batch was standing in which shed, when ─────────────────────────── */
//
// Built from bird_stock alone: an origin row opens a house, an arrival row
// opens the destination. This is the timeline every daily record is resolved
// against, and the reason the untrustworthy batch_number column is not needed.
interface Stay {
  batch: string;
  shed: string;
  from: string;
}
const stays: Stay[] = stock.map((r) => ({
  batch: s(r.batch_number),
  shed: s(r.shed_id),
  from: day(r.date_in),
}));

const byShed = new Map<string, Stay[]>();
for (const st of stays) {
  const list = byShed.get(st.shed) ?? [];
  byShed.set(st.shed, list);
  list.push(st);
}
for (const list of byShed.values()) list.sort((a, b) => a.from.localeCompare(b.from));

/** Which batch a house held on a day — the latest one to have arrived by then. */
function batchOn(shedId: string, on: string): string | null {
  const list = byShed.get(shedId) ?? [];
  let found: string | null = null;
  for (const st of list) {
    if (st.from <= on) found = st.batch;
    else break;
  }
  return found;
}

/* ── Each batch, rebuilt ──────────────────────────────────────────────────── */
const origins = stock
  .filter((r) => !r.source_shed_id)
  .sort((a, b) => day(a.date_in).localeCompare(day(b.date_in)));

console.log("  Each batch as niko will read it\n");
const placedByBatch = new Map<string, number>();

for (const o of origins) {
  const batch = s(o.batch_number);
  const shed = s(o.shed_id);
  const start = day(o.date_in);
  const first = n(o.opening_count);

  // Later hatches: arrivals into the ORIGIN house while this batch stood there.
  const laterHatches = daily
    .filter((r) => s(r.shed_id) === shed && n(r.birds_transferred_in) > 0)
    .filter((r) => day(r.date) >= start && batchOn(shed, day(r.date)) === batch)
    .sort((a, b) => day(a.date).localeCompare(day(b.date)));

  const placed = first + laterHatches.reduce((sum, r) => sum + n(r.birds_transferred_in), 0);
  placedByBatch.set(batch, placed);

  /**
   * How many left, taken from the ARRIVALS rather than from batch_transfers.
   *
   * The two disagree, and the arrivals are the reliable side: they are what the
   * destination house opens with and what Amino's own dashboard counts. The
   * transfer log carries at least one lorry recorded twice — B160226 has
   * 2026-06-01 P1→L2 19,640 in it two times, which is the entire 14,844-bird
   * discrepancy plus the 4,796 of that day's second load.
   */
  const arrivals = stock.filter((r) => s(r.batch_number) === batch && r.source_shed_id);
  const movedOut = arrivals.reduce((sum, r) => sum + n(r.opening_count), 0);
  const dests = [...new Set(arrivals.map((r) => sheds.get(s(r.shed_id))))].join(", ");

  // Said out loud, because a duplicate here is a real lorry counted twice.
  const moves = transfers.filter((r) => s(r.batch_number) === batch);
  const logged = moves.reduce((sum, r) => sum + n(r.bird_count), 0);
  const seen = new Set<string>();
  const dupes = moves.filter((r) => {
    const key = `${day(r.transfer_date)}|${s(r.from_shed_id)}|${s(r.to_shed_id)}|${n(r.bird_count)}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });

  // Losses across every house this batch has stood in.
  const shedsOfBatch = new Set(stays.filter((x) => x.batch === batch).map((x) => x.shed));
  const own = daily.filter(
    (r) => shedsOfBatch.has(s(r.shed_id)) && batchOn(s(r.shed_id), day(r.date)) === batch,
  );
  const g = (k: string) => own.reduce((sum, r) => sum + n(r[k]), 0);
  const lost = g("mortality") + g("birds_culled") + g("male_birds");
  const alive = placed - lost;

  console.log(`   ${batch}  hatched into ${sheds.get(shed)}, housed to ${dests || "nowhere yet"}`);
  console.log(`     ${day(o.batch_birth_date) || start}   first hatch        ${num(first).padStart(9)}`);
  for (const h of laterHatches) {
    console.log(`     ${day(h.date)}   hatch              ${num(n(h.birds_transferred_in)).padStart(9)}`);
  }
  console.log(`     ${"".padEnd(10)}   ${String(laterHatches.length + 1).padStart(2)} hatches, placed  ${num(placed).padStart(9)}`);
  console.log(`     ${"".padEnd(10)}   moved out over ${String(arrivals.length).padStart(2)}   ${num(movedOut).padStart(9)}`);
  for (const dupe of dupes) {
    warn(
      `${batch}: batch_transfers records ${day(dupe.transfer_date)} ` +
        `${sheds.get(s(dupe.from_shed_id))}→${sheds.get(s(dupe.to_shed_id))} ` +
        `${num(n(dupe.bird_count))} TWICE — the arrivals have it once, and they are used`,
    );
  }
  if (!dupes.length && logged !== movedOut) {
    problem(`${batch}: transfer log says ${num(logged)}, arrivals say ${num(movedOut)}`);
  }
  console.log(`     ${"".padEnd(10)}   lost to date       ${num(lost).padStart(9)}   (${((lost / placed) * 100).toFixed(1)}%)`);
  console.log(`     ${"".padEnd(10)}   alive              ${num(alive).padStart(9)}`);

  if (movedOut > placed) {
    problem(`${batch}: ${num(movedOut - placed)} more birds moved out than were ever placed`);
  }
  if (alive < 0) {
    problem(`${batch}: losses exceed the birds placed`);
  }
  console.log("");
}

/* ── And the farm as a whole ──────────────────────────────────────────────── */
console.log("  Where the birds are now, by Amino's own formula\n");
console.log("     shed      opening        in       out      mort     = alive");
let farmAlive = 0;
for (const [id, name] of [...sheds].sort((a, b) => a[1].localeCompare(b[1]))) {
  const ss = stock.filter((r) => s(r.shed_id) === id);
  const inactive = new Set(ss.filter((r) => r.is_active === false).map((r) => s(r.batch_number)));
  const opening = ss
    .filter((r) => r.is_active !== false)
    .reduce((sum, r) => sum + n(r.opening_count), 0);
  const rows = daily.filter(
    (r) => s(r.shed_id) === id && !inactive.has(s(r.batch_number)),
  );
  const g = (k: string) => rows.reduce((sum, r) => sum + n(r[k]), 0);
  const alive =
    opening +
    g("birds_transferred_in") -
    g("mortality") -
    g("birds_transferred_out") -
    g("birds_culled") -
    g("male_birds");
  farmAlive += Math.max(0, alive);
  console.log(
    `     ${name.padEnd(6)} ${num(opening).padStart(10)} ${num(g("birds_transferred_in")).padStart(9)} ` +
      `${num(g("birds_transferred_out")).padStart(9)} ${num(g("mortality")).padStart(9)} = ${num(Math.max(0, alive)).padStart(10)}` +
      (alive < 0 ? `   ! really ${num(alive)}` : ""),
  );
  if (alive < 0) problems++;
}

const placedAll = [...placedByBatch.values()].reduce((a, b) => a + b, 0);
console.log(`\n     placed across every batch   ${num(placedAll).padStart(10)}`);
console.log(`     alive on the farm today     ${num(farmAlive).padStart(10)}`);
console.log(
  `     cumulative loss             ${(((placedAll - farmAlive) / placedAll) * 100).toFixed(1).padStart(9)}%`,
);

console.log(
  problems
    ? `\n  ${problems} thing(s) will stop the import\n`
    : "\n  it reconciles — the import can run\n",
);
process.exit(problems ? 1 : 0);
