import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { comments, users } from "@shared/schema";
import { db } from "../db";
import { requireAuth } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const commentsRouter = Router();

const ENTITY_TYPES = new Set([
  "invoice",
  "estimate",
  "sales_order",
  "credit_note",
  "bill",
  "purchase_order",
  "vendor_credit",
  "expense",
  "journal_entry",
  "contact",
]);

const querySchema = z.object({
  entityType: z.string().refine((v) => ENTITY_TYPES.has(v), "Unknown entity type"),
  entityId: z.string().uuid(),
});

commentsRouter.get("/", requireAuth, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "entityType and entityId required" });
  const rows = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      createdBy: comments.createdBy,
      authorName: users.name,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.createdBy))
    .where(
      and(
        eq(comments.entityType, parsed.data.entityType),
        eq(comments.entityId, parsed.data.entityId),
      ),
    )
    .orderBy(asc(comments.createdAt));
  res.json(rows);
});

commentsRouter.post(
  "/",
  requireAuth,
  validateBody(querySchema.extend({ body: z.string().min(1).max(4000) })),
  async (req, res) => {
    const [row] = await db
      .insert(comments)
      .values({
        entityType: req.body.entityType,
        entityId: req.body.entityId,
        body: req.body.body,
        createdBy: req.session.user!.id,
      })
      .returning();
    res.status(201).json(row);
  },
);

commentsRouter.delete("/:id", requireAuth, async (req, res) => {
  const existing = await db.query.comments.findFirst({
    where: eq(comments.id, req.params.id!),
  });
  if (!existing) return res.status(404).json({ error: "Comment not found" });
  const user = req.session.user!;
  const isAdmin = user.permissions["*"]?.includes("*");
  if (existing.createdBy !== user.id && !isAdmin) {
    return res.status(403).json({ error: "You can only delete your own comments" });
  }
  await db.delete(comments).where(eq(comments.id, existing.id));
  res.json({ ok: true });
});
