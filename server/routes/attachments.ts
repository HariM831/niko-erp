import { Router } from "express";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { attachments } from "@shared/schema";
import { db } from "../db";
import { requireAuth } from "../lib/rbac";

export const attachmentsRouter = Router();

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

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
  "item",
]);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).replace(/[^.\w]/g, "");
    cb(null, `${randomBytes(16).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_TYPES.has(file.mimetype));
  },
});

const metaSchema = z.object({
  entityType: z.string().refine((v) => ENTITY_TYPES.has(v), "Unknown entity type"),
  entityId: z.string().uuid(),
});

attachmentsRouter.get("/", requireAuth, async (req, res) => {
  const parsed = metaSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "entityType and entityId required" });
  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, parsed.data.entityType),
        eq(attachments.entityId, parsed.data.entityId),
      ),
    )
    .orderBy(desc(attachments.createdAt));
  res.json(rows);
});

attachmentsRouter.post("/", requireAuth, upload.single("file"), async (req, res) => {
  const parsed = metaSchema.safeParse(req.body);
  if (!parsed.success) {
    if (req.file) await unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: "entityType and entityId required" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No file received (10 MB max; pdf/image/sheet/doc only)" });
  }
  const [row] = await db
    .insert(attachments)
    .values({
      entityType: parsed.data.entityType,
      entityId: parsed.data.entityId,
      fileName: req.file.originalname.slice(0, 255),
      storedName: req.file.filename,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      uploadedBy: req.session.user!.id,
    })
    .returning();
  res.status(201).json(row);
});

attachmentsRouter.get("/:id/download", requireAuth, async (req, res) => {
  const row = await db.query.attachments.findFirst({
    where: eq(attachments.id, req.params.id!),
  });
  if (!row) return res.status(404).json({ error: "Attachment not found" });
  const filePath = path.join(UPLOAD_DIR, row.storedName);
  if (!existsSync(filePath)) return res.status(410).json({ error: "File missing from storage" });
  res.setHeader("Content-Type", row.mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(row.fileName)}"`,
  );
  createReadStream(filePath).pipe(res);
});

attachmentsRouter.delete("/:id", requireAuth, async (req, res) => {
  const [row] = await db
    .delete(attachments)
    .where(eq(attachments.id, req.params.id!))
    .returning();
  if (!row) return res.status(404).json({ error: "Attachment not found" });
  await unlink(path.join(UPLOAD_DIR, row.storedName)).catch(() => {});
  res.json({ ok: true });
});
