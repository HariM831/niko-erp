import { Router } from "express";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  journalEntryLineTags,
  reportingTagOptions,
  reportingTags,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const reportingTagsRouter = Router();

const tagSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

const optionSchema = z.object({
  name: z.string().min(1).max(60),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

/** Every tag with its options, and how many journal lines carry each option. */
reportingTagsRouter.get("/", requirePermission("settings", "view"), async (_req, res) => {
  const [tags, options] = await Promise.all([
    db.select().from(reportingTags).orderBy(asc(reportingTags.name)),
    db
      .select({
        id: reportingTagOptions.id,
        tagId: reportingTagOptions.tagId,
        name: reportingTagOptions.name,
        isActive: reportingTagOptions.isActive,
        sortOrder: reportingTagOptions.sortOrder,
        usageCount: sql<number>`count(${journalEntryLineTags.id})::int`,
      })
      .from(reportingTagOptions)
      .leftJoin(journalEntryLineTags, eq(journalEntryLineTags.optionId, reportingTagOptions.id))
      .groupBy(reportingTagOptions.id)
      .orderBy(asc(reportingTagOptions.sortOrder), asc(reportingTagOptions.name)),
  ]);
  res.json(
    tags.map((t) => ({ ...t, options: options.filter((o) => o.tagId === t.id) })),
  );
});

reportingTagsRouter.post(
  "/",
  requirePermission("settings", "create"),
  validateBody(tagSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof tagSchema>;
    const existing = await db.query.reportingTags.findFirst({
      where: eq(reportingTags.name, body.name),
    });
    if (existing) return res.status(422).json({ error: "A tag with that name exists" });
    const [row] = await db.insert(reportingTags).values(body).returning();
    res.status(201).json(row);
  },
);

reportingTagsRouter.patch(
  "/:id",
  requirePermission("settings", "edit"),
  validateBody(tagSchema.partial()),
  async (req, res) => {
    const [row] = await db
      .update(reportingTags)
      .set(req.body)
      .where(eq(reportingTags.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Tag not found" });
    res.json(row);
  },
);

/**
 * Deleting a tag takes its options with it (cascade), which would orphan the
 * lines charged to them — so a tag in use has to be deactivated instead.
 */
reportingTagsRouter.delete("/:id", requirePermission("settings", "delete"), async (req, res) => {
  const tag = await db.query.reportingTags.findFirst({
    where: eq(reportingTags.id, req.params.id!),
  });
  if (!tag) return res.status(404).json({ error: "Tag not found" });
  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntryLineTags)
    .where(eq(journalEntryLineTags.tagId, tag.id));
  const n = Number(used?.n ?? 0);
  if (n > 0) {
    return res.status(422).json({
      error: `${n} journal line${n === 1 ? " is" : "s are"} tagged with "${tag.name}" — deactivate it instead`,
    });
  }
  await db.delete(reportingTags).where(eq(reportingTags.id, tag.id));
  res.json({ ok: true });
});

reportingTagsRouter.post(
  "/:id/options",
  requirePermission("settings", "create"),
  validateBody(optionSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof optionSchema>;
    const tag = await db.query.reportingTags.findFirst({
      where: eq(reportingTags.id, req.params.id!),
    });
    if (!tag) return res.status(404).json({ error: "Tag not found" });
    try {
      const [row] = await db
        .insert(reportingTagOptions)
        .values({ ...body, tagId: tag.id })
        .returning();
      res.status(201).json(row);
    } catch (err) {
      if (err instanceof Error && err.message.includes("uq_tag_option")) {
        return res.status(422).json({ error: `"${body.name}" is already an option of ${tag.name}` });
      }
      throw err;
    }
  },
);

reportingTagsRouter.patch(
  "/options/:optionId",
  requirePermission("settings", "edit"),
  validateBody(optionSchema.partial()),
  async (req, res) => {
    try {
      const [row] = await db
        .update(reportingTagOptions)
        .set(req.body)
        .where(eq(reportingTagOptions.id, req.params.optionId!))
        .returning();
      if (!row) return res.status(404).json({ error: "Option not found" });
      res.json(row);
    } catch (err) {
      if (err instanceof Error && err.message.includes("uq_tag_option")) {
        return res.status(422).json({ error: "That option name is already used on this tag" });
      }
      throw err;
    }
  },
);

reportingTagsRouter.delete(
  "/options/:optionId",
  requirePermission("settings", "delete"),
  async (req, res) => {
    const [used] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(journalEntryLineTags)
      .where(eq(journalEntryLineTags.optionId, req.params.optionId!));
    const n = Number(used?.n ?? 0);
    if (n > 0) {
      return res.status(422).json({
        error: `${n} journal line${n === 1 ? " uses" : "s use"} this option — deactivate it instead`,
      });
    }
    const [row] = await db
      .delete(reportingTagOptions)
      .where(eq(reportingTagOptions.id, req.params.optionId!))
      .returning();
    if (!row) return res.status(404).json({ error: "Option not found" });
    res.json({ ok: true });
  },
);
