/**
 * Render the three statement PDFs from real data, without billing anything.
 *
 * For looking at the format before it is wired to a document. Writes to
 * ./tmp-statements and posts nothing.
 *
 *   npx tsx scripts/sample-owner-statements.ts --period 2026-08
 *   npx tsx scripts/sample-owner-statements.ts --period 2026-08 --owner Luit
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { flockPlacements, flocks, houses } from "@shared/schema";
import { db } from "../server/db";
import { setFlockTransfers } from "../server/services/flocks";
import {
  birdStatement,
  eggStatement,
  feedStatement,
  owners,
} from "../server/services/owner-billing";
import { renderStatement } from "../server/services/owner-statement-pdf";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const period = arg("period") ?? new Date().toISOString().slice(0, 7);
const only = arg("owner");
const outDir = arg("out") ?? path.resolve(process.cwd(), "tmp-statements");

const money = (v: number) =>
  v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: number, dp = 0) =>
  v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const dmy = (iso: string) => iso.split("-").reverse().join("/");

/** Thrown to abandon the staged pullet sample without saving it. */
class Rollback extends Error {}

await mkdir(outDir, { recursive: true });

for (const o of await owners(db)) {
  if (only && !o.name.toLowerCase().includes(only.toLowerCase())) continue;
  const slug = o.name.replace(/[^\w -]/g, "").trim();

  /* ── Feed ───────────────────────────────────────────────────────────── */
  const feed = await feedStatement(db, o.id, period);
  if (feed.rows.length) {
    const pdf = await renderStatement({
      title: "Feed supplied",
      document: `the feed invoice for ${period}`,
      orgName: feed.header.orgName,
      ownerName: feed.header.ownerName,
      direction: "Sold by / to",
      from: feed.header.from,
      to: feed.header.to,
      sheds: feed.header.houses.map((h) => h.code).join(" "),
      columns: [
        { label: "Date", width: 58 },
        { label: "Shed", width: 40 },
        { label: "Feed", width: 150 },
        { label: "Transfer", width: 78 },
        { label: "Kg", width: 62, align: "right" },
        { label: "Rate/kg", width: 55, align: "right" },
        { label: "Value INR", width: 72, align: "right" },
      ],
      rows: feed.rows.map((r) => [
        dmy(String(r[0])),
        String(r[1]),
        String(r[2]),
        String(r[3]),
        num(Number(r[4]), 2),
        num(Number(r[5]), 4),
        money(Number(r[6])),
      ]),
      total: ["Total", "", "", "", num(feed.totalKg, 2), "", money(feed.totalValue)],
      notes: [
        "Charged at what the mill made the feed for: raw material plus the milling charge, over the yield that leaves the mill.",
        ...(feed.blended
          ? ["A day with more than one delivery shows the weighted rate; the transfer numbers are listed to take it apart."]
          : []),
      ],
    });
    await writeFile(path.join(outDir, `${slug} ${period} feed.pdf`), pdf);
    console.log(`  ${slug} — feed: ${feed.rows.length} day(s), ${num(feed.totalKg, 2)} kg, ₹${money(feed.totalValue)}`);
  } else {
    console.log(`  ${slug} — no feed this month`);
  }

  /* ── Pullets ────────────────────────────────────────────────────────── */
  const birds = await birdStatement(db, o.id, period);
  if (birds.rows.length) {
    const pdf = await renderStatement({
      title: "Pullets supplied",
      document: `the pullet invoice for ${period}`,
      orgName: birds.header.orgName,
      ownerName: birds.header.ownerName,
      direction: "Sold by / to",
      from: birds.header.from,
      to: birds.header.to,
      sheds: birds.header.houses.map((h) => h.code).join(" "),
      columns: [
        { label: "Date", width: 64 },
        { label: "Batch", width: 90 },
        { label: "Moved", width: 110 },
        { label: "Age (wk)", width: 55, align: "right" },
        { label: "Birds", width: 66, align: "right" },
        { label: "Rate/bird", width: 62, align: "right" },
        { label: "Value INR", width: 78, align: "right" },
      ],
      rows: birds.rows.map((r) => [
        dmy(String(r[0])),
        String(r[1]),
        String(r[2]),
        String(r[3]),
        num(Number(r[4])),
        money(Number(r[5])),
        money(Number(r[6])),
      ]),
      total: ["Total", "", "", "", num(birds.totalBirds), "", money(birds.totalValue)],
      notes: ["Priced from the bird valuation curve at the flock's age in the week it was housed."],
    });
    await writeFile(path.join(outDir, `${slug} ${period} pullets.pdf`), pdf);
    console.log(`  ${slug} — pullets: ${birds.rows.length} housing(s), ${num(birds.totalBirds)} birds`);
  } else {
    console.log(`  ${slug} — no pullets housed this month`);
  }

  /* ── Eggs ───────────────────────────────────────────────────────────── */
  const eggs = await eggStatement(db, o.id, period);
  if (eggs.rows.length) {
    const pdf = await renderStatement({
      title: "Eggs purchased",
      document: `the egg bill for ${period}`,
      orgName: eggs.header.orgName,
      ownerName: eggs.header.ownerName,
      direction: "Bought by / from",
      from: eggs.header.from,
      to: eggs.header.to,
      sheds: eggs.header.houses.map((h) => h.code).join(" "),
      columns: [
        { label: "Date", width: 64 },
        { label: "Shed", width: 44 },
        { label: "Batch", width: 96 },
        { label: "Eggs", width: 70, align: "right" },
        { label: "Cracked", width: 58, align: "right" },
        { label: "Rate/egg", width: 62, align: "right" },
        { label: "Value INR", width: 78, align: "right" },
      ],
      rows: eggs.rows.map((r) => [
        dmy(String(r[0])),
        String(r[1]),
        String(r[2]),
        num(Number(r[3])),
        r[4] === "" ? "" : num(Number(r[4])),
        r[5] === "" ? "—" : num(Number(r[5]), 4),
        r[6] === "" ? "—" : money(Number(r[6])),
      ]),
      total: ["Total", "", "", num(eggs.totalEggs), "", "", money(eggs.totalValue)],
      notes: [
        "Each day at that day's benchmark price plus the agreed spread — the rate is the one in force on the day the eggs were laid.",
        eggs.ratesSeen.length > 1
          ? `The benchmark moved during the month: ${eggs.ratesSeen.map((r) => `${num(r, 2)}`).join(", ")} per egg.`
          : `Rate held at ${num(eggs.ratesSeen[0] ?? 0, 2)} per egg all month.`,
      ],
    });
    await writeFile(path.join(outDir, `${slug} ${period} eggs.pdf`), pdf);
    console.log(`  ${slug} — eggs: ${eggs.rows.length} row(s), ${num(eggs.totalEggs)} eggs, ₹${money(eggs.totalValue)}`);
  } else {
    console.log(`  ${slug} — no eggs this month`);
  }
}

/* ── A pullet sample, when nothing was actually housed this month ─────────── */
//
// Housing happens a few times a year, so most months have nothing to show. To
// see the layout anyway, one is staged inside a transaction that is ROLLED
// BACK: the code path is the real one and the database is left untouched.
if (process.argv.includes("--demo-birds")) {
  try {
    await db.transaction(async (tx) => {
      const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
      const [pullet] = await tx
        .select()
        .from(houses)
        .where(and(eq(houses.purpose, "pullet"), isNull(houses.ownerId)));
      const [layer] = await tx
        .select()
        .from(houses)
        .where(and(eq(houses.purpose, "layer"), isNotNull(houses.ownerId)));
      if (!pullet || !layer?.ownerId) throw new Rollback();

      const [placement] = await tx
        .select({ flockId: flockPlacements.flockId })
        .from(flockPlacements)
        .where(and(eq(flockPlacements.houseId, pullet.id), isNull(flockPlacements.toDate)));
      if (!placement) throw new Rollback();

      await setFlockTransfers(
        tx,
        placement.flockId,
        [
          { eventDate: `${period}-08`, fromHouseId: pullet.id, toHouseId: layer.id, qty: 4000 },
          { eventDate: `${period}-09`, fromHouseId: pullet.id, toHouseId: layer.id, qty: 3500 },
        ],
        userId,
      );

      const birds = await birdStatement(tx, layer.ownerId, period);
      if (!birds.rows.length) throw new Rollback();

      // No bird valuation curve is set up yet, so every pullet prices at zero
      // and the sample shows a column of noughts instead of a layout. Filled in
      // with an illustrative rate, said plainly at the foot of the page.
      const priced = birds.rows.some((r) => Number(r[5]) > 0);
      const ILLUSTRATIVE = 250;
      const rows = priced
        ? birds.rows
        : birds.rows.map((r) => [...r.slice(0, 5), ILLUSTRATIVE, Number(r[4]) * ILLUSTRATIVE]);
      const totalValue = priced
        ? birds.totalValue
        : birds.totalBirds * ILLUSTRATIVE;

      const pdf = await renderStatement({
        title: "Pullets supplied",
        document: `the pullet invoice for ${period}`,
        orgName: birds.header.orgName,
        ownerName: birds.header.ownerName,
        direction: "Sold by / to",
        from: birds.header.from,
        to: birds.header.to,
        sheds: birds.header.houses.map((h) => h.code).join(" "),
        columns: [
          { label: "Date", width: 64 },
          { label: "Batch", width: 90 },
          { label: "Moved", width: 110 },
          { label: "Age (wk)", width: 55, align: "right" },
          { label: "Birds", width: 66, align: "right" },
          { label: "Rate/bird", width: 62, align: "right" },
          { label: "Value INR", width: 78, align: "right" },
        ],
        rows: rows.map((r) => [
          dmy(String(r[0])),
          String(r[1]),
          String(r[2]),
          String(r[3]),
          num(Number(r[4])),
          money(Number(r[5])),
          money(Number(r[6])),
        ]),
        total: ["Total", "", "", "", num(birds.totalBirds), "", money(totalValue)],
        notes: [
          "Priced from the bird valuation curve at the flock's age in the week it was housed.",
          "SAMPLE — this housing was staged to show the layout and was not saved.",
          ...(priced
            ? []
            : [
                `No bird valuation curve is set up yet, so ${ILLUSTRATIVE}.00 per bird is shown here to fill the page. A real pullet invoice cannot be raised until the curve is entered.`,
              ]),
        ],
      });
      await writeFile(path.join(outDir, `SAMPLE ${period} pullets.pdf`), pdf);
      console.log(
        `  SAMPLE pullets: ${birds.rows.length} housing(s), ${num(birds.totalBirds)} birds, ₹${money(birds.totalValue)}`,
      );
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) {
      console.log(`  could not stage a pullet sample: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

console.log(`\n  written to ${outDir}\n`);
process.exit(0);
