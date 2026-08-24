/**
 * Dr niko — field observations sent for diagnosis.
 *
 * A worker in a shed photographs what they found and submits it; the analyze
 * step sends the photos to a vision model TOGETHER WITH the flock's own
 * numbers — age, breed, live birds, and the last week of production, mortality,
 * feed and water from flock_day. The model is asked to act as a pathologist
 * reading a post-mortem against the performance record, not as an oracle
 * looking at a photo in a vacuum.
 *
 * The division of labour mirrors the bill OCR: the model reads and correlates;
 * every number it is given is computed here from the ledger, where it is
 * testable. The model's answer is stored verbatim with the model's name, so a
 * change in behaviour stays attributable.
 *
 * Photos ride the existing attachments machinery (entity_type
 * 'ai_observation'), uploaded through /api/attachments like every other file.
 */
import { Router } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { existsSync, createReadStream } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import {
  aiObservations,
  attachments,
  breeds,
  flockDay,
  flockPlacements,
  flocks,
  houses,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { z } from "zod";

export const drEggsyRouter = Router();

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

/**
 * The model. Flash rather than lite: unlike the bill OCR — dot-matrix digits
 * on white paper — this is gross pathology in shed lighting, and the answer is
 * a clinical judgement rather than a transcription.
 */
const DR_niko_MODEL = process.env.DR_niko_MODEL || "gemini-flash-latest";

/** Observations, newest first, with their photos' attachment ids. */
drEggsyRouter.get("/", requirePermission("farms", "view"), async (_req, res) => {
  const rows = await db
    .select({
      id: aiObservations.id,
      houseId: aiObservations.houseId,
      houseCode: houses.code,
      observedOn: aiObservations.observedOn,
      note: aiObservations.note,
      aiRemark: aiObservations.aiRemark,
      aiModel: aiObservations.aiModel,
      analyzedAt: aiObservations.analyzedAt,
      createdAt: aiObservations.createdAt,
    })
    .from(aiObservations)
    .innerJoin(houses, eq(houses.id, aiObservations.houseId))
    .orderBy(desc(aiObservations.observedOn), desc(aiObservations.createdAt));

  const ids = rows.map((r) => r.id);
  const files = ids.length
    ? await db
        .select({
          id: attachments.id,
          entityId: attachments.entityId,
          fileName: attachments.fileName,
          mimeType: attachments.mimeType,
        })
        .from(attachments)
        .where(and(eq(attachments.entityType, "ai_observation"), inArray(attachments.entityId, ids)))
    : [];
  const byObs = new Map<string, typeof files>();
  for (const f of files) {
    const bucket = byObs.get(f.entityId) ?? [];
    byObs.set(f.entityId, bucket);
    bucket.push(f);
  }
  res.json({
    observations: rows.map((r) => ({ ...r, images: byObs.get(r.id) ?? [] })),
  });
});

const createSchema = z.object({
  houseId: z.string().uuid(),
  observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(4000).optional(),
});

/** A new observation. Photos are attached afterwards via /api/attachments. */
drEggsyRouter.post(
  "/",
  requirePermission("farms", "create"),
  validateBody(createSchema),
  async (req, res) => {
    const [house] = await db.select().from(houses).where(eq(houses.id, req.body.houseId));
    if (!house) return res.status(404).json({ error: "House not found" });
    const [row] = await db
      .insert(aiObservations)
      .values({
        houseId: req.body.houseId,
        observedOn: req.body.observedOn,
        note: req.body.note || null,
        submittedBy: req.session.user!.id,
      })
      .returning();
    res.status(201).json(row);
  },
);

/**
 * The clinical context: what the ledger knows about the birds in this house
 * around this date. Everything the model is told is computed here.
 */
async function clinicalContext(houseId: string, on: string) {
  // The placement that held birds in this house on that date. If several
  // overlap (a split mid-move), take the one with the most recent start —
  // the birds the person in the shed was most likely looking at.
  const [placement] = await db
    .select({
      id: flockPlacements.id,
      flockId: flockPlacements.flockId,
      flockCode: flocks.code,
      hatchDate: flocks.hatchDate,
      breedName: breeds.name,
    })
    .from(flockPlacements)
    .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
    .leftJoin(breeds, eq(breeds.id, flocks.breedId))
    .where(
      and(
        eq(flockPlacements.houseId, houseId),
        lte(flockPlacements.fromDate, on),
        or(isNull(flockPlacements.toDate), gte(flockPlacements.toDate, on)),
      ),
    )
    .orderBy(desc(flockPlacements.fromDate))
    .limit(1);
  if (!placement) return null;

  // The last seven recorded days up to the observation, oldest first.
  const days = (
    await db
      .select()
      .from(flockDay)
      .where(and(eq(flockDay.placementId, placement.id), lte(flockDay.day, on)))
      .orderBy(desc(flockDay.day))
      .limit(7)
  ).reverse();

  const latest = days[days.length - 1];
  const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

  const lines = days.map((d) => {
    const birds = d.closingBirds || 1;
    const mortPct = ((d.mortality / birds) * 100).toFixed(2);
    const hd = d.hdPct != null ? Number(d.hdPct).toFixed(1) : "n/a";
    const feed = d.feedPerBirdG != null ? Number(d.feedPerBirdG).toFixed(0) : "n/a";
    const water = d.waterPerBirdMl != null ? Number(d.waterPerBirdMl).toFixed(0) : "n/a";
    return `${d.day}: mortality=${d.mortality} (${mortPct}%), production=${d.eggs ?? 0} (HD ${hd}%), feed=${feed}g/bird, water=${water}ml/bird`;
  });

  // Water:feed as a heat-stress proxy, same as the vet would compute it.
  const ratios = days
    .map((d) => {
      const w = num(d.waterPerBirdMl);
      const f = num(d.feedPerBirdG);
      return w != null && f != null && f > 0 ? w / f : null;
    })
    .filter((x): x is number => x != null);
  const wf = ratios.length ? (ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2) : "n/a";

  const ageDays = latest
    ? latest.ageDays
    : Math.floor((new Date(on).getTime() - new Date(placement.hatchDate).getTime()) / 86_400_000);

  return {
    placement,
    breed: placement.breedName ?? "Not specified",
    ageWeeks: Math.floor(ageDays / 7),
    liveBirds: latest?.closingBirds ?? null,
    phase: latest?.phase ?? "unknown",
    dailySummary: lines.join("\n"),
    waterFeedRatio: wf,
  };
}

/** Send the photos and the record to the model; keep its answer. */
drEggsyRouter.post("/:id/analyze", requirePermission("farms", "create"), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "GEMINI_API_KEY is not configured — analysis is unavailable" });
  }

  const [obs] = await db.select().from(aiObservations).where(eq(aiObservations.id, req.params.id!));
  if (!obs) return res.status(404).json({ error: "Observation not found" });

  const [house] = await db.select().from(houses).where(eq(houses.id, obs.houseId));
  const files = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.entityType, "ai_observation"), eq(attachments.entityId, obs.id)));
  if (!files.length) {
    return res.status(400).json({ error: "No photos attached — there is nothing to look at" });
  }

  const imageParts = [];
  for (const f of files) {
    const p = path.join(UPLOAD_DIR, f.storedName);
    if (!existsSync(p)) continue;
    imageParts.push({
      inlineData: { data: (await readFile(p)).toString("base64"), mimeType: f.mimeType },
    });
  }
  if (!imageParts.length) {
    return res.status(410).json({ error: "The photo files are missing from storage" });
  }

  const ctx = await clinicalContext(obs.houseId, obs.observedOn);

  const prompt = `Act as a senior avian pathologist at Amino Farms, a commercial layer operation in Assam, India. Analyze the attached field images alongside the provided flock record.

FLOCK PROFILE:
- Shed: ${house?.code ?? "?"} (${house?.purpose ?? "?"})
- Breed: ${ctx?.breed ?? "Not specified"}
- Flock age: ${ctx ? `${ctx.ageWeeks} weeks` : "Unknown"}
- Phase: ${ctx?.phase ?? "unknown"}
- Current live birds: ${ctx?.liveBirds?.toLocaleString("en-IN") ?? "Unknown"}

LAST ${ctx ? ctx.dailySummary.split("\n").length : 0} RECORDED DAYS:
${ctx?.dailySummary || "No records available"}

ENVIRONMENTAL INDICATORS:
- Average water:feed ratio: ${ctx?.waterFeedRatio ?? "n/a"} (normal 1.5-2.0 ml/g; higher suggests heat stress)

FIELD NOTE FROM THE OBSERVER:
${obs.note || "(none)"}

RESPOND IN THIS EXACT FORMAT:

**Category:** [CRITICAL_INFECTIOUS | WARNING_MANAGEMENT | INFO_NUTRITIONAL]

**Clinical Remark:** [One concise sentence: pathology + likely trigger + risk.]

**Pathological Findings:**
- Primary: [Main gross finding from the images]
- Secondary: [Additional findings]

**Correlation Analysis:**
- Trend: [How the mortality/production record relates to the pathology]
- Environmental: [Water:feed analysis, stress indicators]
- Feed: [Any feed-related correlations]

**Action Plan:**
- Water: [Water treatment recommendation with dosage]
- Feed: [Feed modification]
- Shed: [Management/environmental change]
- Diagnostic: [Lab samples or serology needed]

**Confidence:** [0-100]%

Be direct and clinical. If the images are unclear, say so and advise from the performance record alone.`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: DR_niko_MODEL });
    const result = await model.generateContent([prompt, ...imageParts]);
    const remark = result.response.text();

    const [updated] = await db
      .update(aiObservations)
      .set({ aiRemark: remark, aiModel: DR_niko_MODEL, analyzedAt: new Date() })
      .where(eq(aiObservations.id, obs.id))
      .returning();
    res.json(updated);
  } catch (e) {
    console.error("[dr-eggsy] analyze failed:", e);
    res.status(502).json({ error: "The model did not answer — try again in a moment" });
  }
});

/** The photo itself, streamed inline for the gallery. */
drEggsyRouter.get("/image/:attachmentId", requirePermission("farms", "view"), async (req, res) => {
  const row = await db.query.attachments.findFirst({
    where: and(
      eq(attachments.id, req.params.attachmentId!),
      eq(attachments.entityType, "ai_observation"),
    ),
  });
  if (!row) return res.status(404).json({ error: "Not found" });
  const p = path.join(UPLOAD_DIR, row.storedName);
  if (!existsSync(p)) return res.status(410).json({ error: "File missing from storage" });
  res.setHeader("Content-Type", row.mimeType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  createReadStream(p).pipe(res);
});

drEggsyRouter.delete("/:id", requirePermission("farms", "delete"), async (req, res) => {
  await db.transaction(async (tx) => {
    await tx
      .delete(attachments)
      .where(and(eq(attachments.entityType, "ai_observation"), eq(attachments.entityId, req.params.id!)));
    await tx.delete(aiObservations).where(eq(aiObservations.id, req.params.id!));
  });
  // Files on disk are left behind deliberately: attachment rows are the index,
  // and an orphaned file is recoverable where a deleted one is not.
  res.json({ ok: true });
});
