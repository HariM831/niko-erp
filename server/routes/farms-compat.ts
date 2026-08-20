/**
 * Writes for the ported screens, in the shapes they send.
 *
 * Those pages think in sheds, batch numbers and dates. EGGSY thinks in
 * placements, flocks and a movement ledger. Rather than edit a couple of
 * thousand lines of JSX to change what it posts — every edit a chance to change
 * a number on screen — the translation happens here, beside the read adapter
 * that does the same job in the other direction.
 *
 * Nothing here writes to the ledger directly. Everything goes through the same
 * services the rest of the app uses, so a day saved from this screen is subject
 * to the same refusals as one saved anywhere else.
 */
import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  birdWeighings,
  flockMovements,
  flockPlacements,
  flocks,
  houses,
  placementDays,
  vaccinationEvents,
} from "@shared/schema";
import { db } from "../db";
import type { db as Db } from "../db";
import { requirePermission } from "../lib/rbac";
import { PostingError } from "../services/posting";
import { DAILY_KINDS, saveDay } from "../services/daily";
import { createFlock } from "../services/flocks";
import { refreshFromPlacement } from "../services/rollup";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export const farmsCompatRouter = Router();

const manage = requirePermission("farms", "manage");

const fail = (err: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) => {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
};

/** "2026-08-19T00:00:00.000Z" or "2026-08-19" — the screens send both. */
const day = (v: string) => String(v).slice(0, 10);

/**
 * The placement a screen means by (shed, batch, date).
 *
 * A shed can have held several batches, so the batch number picks between them;
 * without one, the placement open on that day wins.
 */
async function resolvePlacement(
  tx: Tx,
  shedId: string,
  batchNumber: string | null | undefined,
  on: string,
): Promise<string> {
  const rows = await tx
    .select({
      id: flockPlacements.id,
      fromDate: flockPlacements.fromDate,
      toDate: flockPlacements.toDate,
      code: flocks.code,
    })
    .from(flockPlacements)
    .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
    .where(eq(flockPlacements.houseId, shedId));
  if (!rows.length) throw new PostingError("No flock has ever been placed in that house");

  const named = batchNumber && batchNumber !== "__all__" ? rows.filter((r) => r.code === batchNumber) : rows;
  if (!named.length) throw new PostingError(`No batch ${batchNumber} in that house`);

  const covering = named.find((r) => r.fromDate <= on && (!r.toDate || r.toDate >= on));
  if (covering) return covering.id;
  // Not covered by any occupancy: say so rather than writing to a neighbour.
  throw new PostingError(
    `No batch was in that house on ${on}. Check the date, or record the arrival first.`,
  );
}

/* ── Daily records ───────────────────────────────────────────────────────── */

const dailyBody = z.object({
  shedId: z.string().uuid().optional(),
  batchNumber: z.string().nullish(),
  date: z.string(),
  mortality: z.number().default(0),
  maleBirds: z.number().default(0),
  birdsTransferredIn: z.number().default(0),
  birdsTransferredOut: z.number().default(0),
  birdsCulled: z.number().default(0),
  waterUpperKl: z.number().default(0),
  waterLowerKl: z.number().default(0),
  feedDeliveredKg: z.number().default(0),
  feedIntakeKg: z.number().default(0),
  feedStockKg: z.number().default(0),
  eggsProduced: z.number().default(0),
});

/**
 * Save one shed-day.
 *
 * Two fields on that form are refused rather than quietly dropped, because in
 * EGGSY they are owned elsewhere and writing them here would give the same
 * movement two homes:
 *
 *  - transferred in / out — birds move on the flock's Transfer tab, as dated
 *    lines. A transfer also needs both ends; one written from here would be a
 *    bird leaving a house and arriving nowhere.
 *  - feed delivered — that is the mill's transfer into the house, which already
 *    exists as a stock movement with a cost on it.
 */
async function writeDaily(tx: Tx, body: z.infer<typeof dailyBody>, userId: string, placementId: string) {
  if (body.birdsTransferredIn || body.birdsTransferredOut) {
    throw new PostingError(
      "Birds move on the flock's Transfer tab, where both ends of the move are recorded together. Leave transferred in/out at zero here.",
    );
  }
  if (body.feedDeliveredKg) {
    throw new PostingError(
      "Feed delivered comes from the mill's transfer into this house — record it in Feed Mill, not here.",
    );
  }
  const losses = [
    { kind: "mortality" as const, qty: body.mortality },
    { kind: "cull" as const, qty: body.birdsCulled },
    { kind: "male_removal" as const, qty: body.maleBirds },
  ].filter((l) => l.qty > 0);

  return saveDay(
    tx,
    {
      placementId,
      day: day(body.date),
      feedConsumedKg: body.feedIntakeKg ? String(body.feedIntakeKg) : null,
      feedClosingKg: body.feedStockKg ? String(body.feedStockKg) : null,
      waterUpperKl: body.waterUpperKl ? String(body.waterUpperKl) : null,
      waterLowerKl: body.waterLowerKl ? String(body.waterLowerKl) : null,
      eggsTotal: body.eggsProduced || null,
      losses,
    },
    userId,
  );
}

farmsCompatRouter.post("/daily-records", manage, async (req, res) => {
  try {
    const body = dailyBody.parse(req.body);
    if (!body.shedId) throw new PostingError("Which house?");
    const out = await db.transaction(async (tx) => {
      const placementId = await resolvePlacement(tx, body.shedId!, body.batchNumber, day(body.date));
      return writeDaily(tx, body, req.session.user!.id, placementId);
    });
    res.status(201).json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/** The screens carry "placementId:YYYY-MM-DD" as a daily record's id. */
const splitDayId = (id: string) => {
  const [placementId, d] = id.split(":");
  if (!placementId || !d) throw new PostingError("That record id is not one of ours");
  return { placementId, day: d };
};

farmsCompatRouter.patch("/daily-records/:id", manage, async (req, res) => {
  try {
    const { placementId } = splitDayId(req.params.id!);
    const body = dailyBody.parse(req.body);
    const out = await db.transaction((tx) => writeDaily(tx, body, req.session.user!.id, placementId));
    res.json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

farmsCompatRouter.delete("/daily-records/:id", manage, async (req, res) => {
  try {
    const { placementId, day: d } = splitDayId(req.params.id!);
    await db.transaction(async (tx) => {
      await tx
        .delete(placementDays)
        .where(and(eq(placementDays.placementId, placementId), eq(placementDays.day, d)));
      // The day's losses go with it — they were entered on the same form.
      await tx.delete(flockMovements).where(
        and(
          eq(flockMovements.placementId, placementId),
          eq(flockMovements.eventDate, d),
          sql`${flockMovements.kind} = ANY(${sql.raw(`ARRAY['${DAILY_KINDS.join("','")}']`)})`,
        ),
      );
    });
    res.json({ ok: true });
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/* ── Weekly weights ──────────────────────────────────────────────────────── */

const weightBody = z.object({
  shedId: z.string().uuid().optional(),
  batchNumber: z.string().nullish(),
  weekNumber: z.number().int().min(0).max(120),
  date: z.string(),
  averageWeight: z.number().nullable(),
  eggWeight: z.number().nullable().optional(),
});

farmsCompatRouter.post("/weekly-weights", manage, async (req, res) => {
  try {
    const b = weightBody.parse(req.body);
    if (!b.shedId) throw new PostingError("Which house?");
    const row = await db.transaction(async (tx) => {
      const placementId = await resolvePlacement(tx, b.shedId!, b.batchNumber, day(b.date));
      const [made] = await tx
        .insert(birdWeighings)
        .values({
          placementId,
          weekNumber: b.weekNumber,
          weighedOn: day(b.date),
          avgWeightG: b.averageWeight == null ? null : String(b.averageWeight),
          eggWeightG: b.eggWeight == null ? null : String(b.eggWeight),
          recordedBy: req.session.user!.id,
        })
        // One weighing per placement-week; saving the same week again corrects it.
        .onConflictDoUpdate({
          target: [birdWeighings.placementId, birdWeighings.weekNumber],
          set: {
            weighedOn: day(b.date),
            avgWeightG: b.averageWeight == null ? null : String(b.averageWeight),
            eggWeightG: b.eggWeight == null ? null : String(b.eggWeight),
            recordedBy: req.session.user!.id,
          },
        })
        .returning();
      // Body and egg weight are carried forward onto every day until the next
      // weighing, so the rows have to be rebuilt when one is corrected.
      await refreshFromPlacement(tx, placementId);
      return made!;
    });
    res.status(201).json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

farmsCompatRouter.patch("/weekly-weights/:id", manage, async (req, res) => {
  try {
    const b = weightBody.parse(req.body);
    const [row] = await db
      .update(birdWeighings)
      .set({
        weekNumber: b.weekNumber,
        weighedOn: day(b.date),
        avgWeightG: b.averageWeight == null ? null : String(b.averageWeight),
        eggWeightG: b.eggWeight == null ? null : String(b.eggWeight),
      })
      .where(eq(birdWeighings.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Weighing not found" });
    res.json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

farmsCompatRouter.delete("/weekly-weights/:id", manage, async (req, res) => {
  await db.delete(birdWeighings).where(eq(birdWeighings.id, req.params.id!));
  res.json({ ok: true });
});

/* ── Vaccination ─────────────────────────────────────────────────────────── */

const vaccBody = z.object({
  shedId: z.string().uuid().optional(),
  batchNumber: z.string().nullish(),
  date: z.string(),
  vaccineName: z.string().min(1),
  make: z.string().nullish(),
  birdsVaccinated: z.number().nullish(),
  vaccinatorCount: z.number().nullish(),
  laboursCount: z.number().nullish(),
  imageUrl: z.string().nullish(),
});

farmsCompatRouter.post("/vaccination-records", manage, async (req, res) => {
  try {
    const b = vaccBody.parse(req.body);
    if (!b.shedId) throw new PostingError("Which house?");
    const row = await db.transaction(async (tx) => {
      const placementId = await resolvePlacement(tx, b.shedId!, b.batchNumber, day(b.date));
      const [made] = await tx
        .insert(vaccinationEvents)
        .values({
          placementId,
          eventDate: day(b.date),
          vaccineName: b.vaccineName,
          make: b.make ?? null,
          birdsVaccinated: b.birdsVaccinated ?? null,
          vaccinatorCount: b.vaccinatorCount ?? null,
          laboursCount: b.laboursCount ?? null,
          imageUrl: b.imageUrl ?? null,
          recordedBy: req.session.user!.id,
        })
        .returning();
      return made!;
    });
    res.status(201).json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

farmsCompatRouter.patch("/vaccination-records/:id", manage, async (req, res) => {
  try {
    const b = vaccBody.parse(req.body);
    const [row] = await db
      .update(vaccinationEvents)
      .set({
        eventDate: day(b.date),
        vaccineName: b.vaccineName,
        make: b.make ?? null,
        birdsVaccinated: b.birdsVaccinated ?? null,
        vaccinatorCount: b.vaccinatorCount ?? null,
        laboursCount: b.laboursCount ?? null,
        imageUrl: b.imageUrl ?? null,
      })
      .where(eq(vaccinationEvents.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Vaccination not found" });
    res.json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

farmsCompatRouter.delete("/vaccination-records/:id", manage, async (req, res) => {
  await db.delete(vaccinationEvents).where(eq(vaccinationEvents.id, req.params.id!));
  res.json({ ok: true });
});

/* ── Batches ─────────────────────────────────────────────────────────────── */

const stockBody = z.object({
  shedId: z.string().uuid().optional(),
  batchNumber: z.string().min(1),
  dateIn: z.string(),
  openingCount: z.number().int().positive(),
  breedId: z.string().uuid().nullish(),
  batchBirthDate: z.string().nullish(),
  isActive: z.boolean().optional(),
});

/** A "batch" arriving in a shed is a flock placed there. */
farmsCompatRouter.post("/bird-stock", manage, async (req, res) => {
  try {
    const b = stockBody.parse(req.body);
    if (!b.shedId) throw new PostingError("Which house?");
    if (!b.breedId) throw new PostingError("Pick a breed — it decides which standard the batch is measured against");
    const out = await db.transaction(async (tx) => {
      const [house] = await tx.select().from(houses).where(eq(houses.id, b.shedId!));
      if (!house) throw new PostingError("No such house");
      // The hatch date drives the age; without one the arrival date is the best
      // available answer, which is what the old screen assumed too.
      const hatch = day(b.batchBirthDate || b.dateIn);
      return createFlock(tx, {
        code: b.batchNumber.trim(),
        locationId: house.locationId,
        breedId: b.breedId!,
        houseId: house.id,
        hatches: [{ hatchDate: hatch, qty: b.openingCount }],
        userId: req.session.user!.id,
      });
    });
    res.status(201).json(out.flock);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});



/*
 * Retiring, deleting and transferring a batch are deliberately NOT here.
 * A batch belongs to the flock, not the shed: it arrives over several hatches,
 * moves over several lorries and is culled out over several days, keeping one
 * record throughout. Those three things are edited on the flock as dated line
 * sets, which is also where they can be checked against each other. A second
 * shed-wise door into the same ledger is how the two come to disagree.
 */

/* ── The shed itself ─────────────────────────────────────────────────────── */

farmsCompatRouter.patch("/sheds/:id", manage, async (req, res) => {
  try {
    const b = z
      .object({
        name: z.string().min(1).optional(),
        type: z.enum(["layer", "pullet"]).optional(),
        displayOrder: z.number().int().optional(),
      })
      .parse(req.body);
    const [row] = await db
      .update(houses)
      .set({
        ...(b.name ? { code: b.name } : {}),
        ...(b.type ? { purpose: b.type } : {}),
        ...(b.displayOrder !== undefined ? { displayOrder: b.displayOrder } : {}),
      })
      .where(eq(houses.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "House not found" });
    res.json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/* ── Bulk upload ─────────────────────────────────────────────────────────── */

/**
 * A CSV of days, all or nothing.
 *
 * One transaction: a file that fails halfway leaves nothing behind, which is
 * the only sane answer when somebody is uploading a month at a time and cannot
 * tell by eye which rows landed.
 */
farmsCompatRouter.post("/sheds/:id/bulk-daily-records", manage, async (req, res) => {
  try {
    const rows = z.object({ records: z.array(dailyBody).max(400) }).parse(req.body).records;
    const out = await db.transaction(async (tx) => {
      let n = 0;
      for (const r of rows) {
        const placementId = await resolvePlacement(tx, req.params.id!, r.batchNumber, day(r.date));
        await writeDaily(tx, r, req.session.user!.id, placementId);
        n++;
      }
      return n;
    });
    res.status(201).json({ saved: out });
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});
