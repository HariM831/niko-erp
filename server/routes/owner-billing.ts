/**
 * Owner billing — the month's trade between Amino and the people who own sheds.
 *
 * Reading a draft and raising the documents are separate calls on purpose. The
 * draft is free to look at as often as you like; raising posts an invoice and a
 * bill to the ledger and can only happen once for a month.
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Router, type Response } from "express";
import { z } from "zod";
import { attachments } from "@shared/schema";
import { db } from "../db";
import { nextDocumentNumber } from "../lib/numbering";
import { requirePermission } from "../lib/rbac";
import { PostingError } from "../services/posting";
import {
  buildStatements,
  draftAll,
  draftMonth,
  owners,
  raiseMonth,
  type StatementKind,
} from "../services/owner-billing";

export const ownerBillingRouter = Router();

const period = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, "A period looks like 2026-08");

/** A refusal is a 422 with the reason; anything else is a bug and rethrows. */
function fail(err: unknown, res: Response) {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

/** Everyone who owns a house. */
ownerBillingRouter.get("/owners", requirePermission("sales", "view"), async (_req, res) => {
  res.json({ owners: await owners(db) });
});

/** Every owner's month, for the review screen. Reads only. */
ownerBillingRouter.get("/drafts", requirePermission("sales", "view"), async (req, res) => {
  try {
    const p = period.parse(String(req.query.period ?? ""));
    res.json({ drafts: await draftAll(db, p) });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message });
    if (!fail(err, res)) throw err;
  }
});

/** One owner's month. */
ownerBillingRouter.get("/drafts/:contactId", requirePermission("sales", "view"), async (req, res) => {
  try {
    const p = period.parse(String(req.query.period ?? ""));
    res.json(await draftMonth(db, req.params.contactId!, p));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message });
    if (!fail(err, res)) throw err;
  }
});

/**
 * Raise the invoice and the bill.
 *
 * `sales.create` rather than `view`: this posts to the ledger. The refusals all
 * live in the service, so the route does not get to decide what is billable.
 */
/**
 * Raise the month's documents.
 *
 * `sales.create` rather than `view`: this posts to the ledger. Every refusal
 * lives in the service, so the route does not get to decide what is billable.
 */
ownerBillingRouter.post("/raise", requirePermission("sales", "create"), async (req, res) => {
  try {
    const body = z.object({ contactId: z.string().uuid(), period }).parse(req.body);
    const out = await db.transaction((tx) =>
      raiseMonth(tx, body.contactId, body.period, req.session.user!.id),
    );

    // Attached only once the documents are real. Rendering and writing files
    // inside the posting transaction would leave them on disk after a rollback.
    const attachments = await attachStatements(out, body.period, req.session.user!.id);

    res.status(201).json({
      feedInvoiceId: out.feedInvoiceId,
      birdInvoiceId: out.birdInvoiceId,
      billId: out.billId,
      feedTotal: out.draft.feedTotal,
      birdTotal: out.draft.birdTotal,
      eggTotal: out.draft.eggTotal,
      attachments,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message });
    if (!fail(err, res)) throw err;
  }
});

/**
 * Build each document's statement and hang it on that document.
 *
 * One statement per document, showing only its own trade: the feed invoice gets
 * the feed, the pullet invoice gets the pullets, the bill gets the eggs. A
 * statement covering all three would invite somebody to total the wrong column
 * and query a figure that is not on the paper in front of them.
 *
 * Runs after the posting transaction has committed. A failure here leaves the
 * documents standing without their statements, which
 * `scripts/attach-owner-statement.ts` can put right; failing the posting
 * because a file could not be written would not be recoverable.
 */
async function attachStatements(
  out: {
    draft: { owner: { id: string; name: string } };
    feedInvoiceId: string | null;
    birdInvoiceId: string | null;
    billId: string | null;
  },
  period: string,
  userId: string,
) {
  const built = await buildStatements(db, out.draft.owner.id, period);
  const targets: Array<{ entityType: "invoice" | "bill"; entityId: string; kind: StatementKind }> = [];
  if (out.feedInvoiceId) targets.push({ entityType: "invoice", entityId: out.feedInvoiceId, kind: "feed" });
  if (out.birdInvoiceId) targets.push({ entityType: "invoice", entityId: out.birdInvoiceId, kind: "birds" });
  if (out.billId) targets.push({ entityType: "bill", entityId: out.billId, kind: "eggs" });

  const made: Array<{ id: string; entityType: string; kind: string; bytes: number }> = [];
  for (const t of targets) {
    const doc = built[t.kind];
    if (!doc) continue;
    const row = await saveAttachment(t.entityType, t.entityId, doc.fileName, doc.pdf, userId);
    made.push({ id: row.id, entityType: t.entityType, kind: t.kind, bytes: doc.pdf.length });
  }
  return made;
}

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

/**
 * Write one statement to the uploads store and file it against a document.
 *
 * The file goes down first: an attachment row pointing at nothing shows the
 * reader a paperclip that opens an error, whereas a file with no row is inert.
 */
async function saveAttachment(
  entityType: "invoice" | "bill",
  entityId: string,
  fileName: string,
  body: Buffer,
  userId: string,
) {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
  const storedName = `${randomBytes(16).toString("hex")}.pdf`;
  await writeFile(path.join(UPLOAD_DIR, storedName), body);
  return db.transaction(async (tx) => {
    const filingRef = await nextDocumentNumber(tx, "attachment");
    const [row] = await tx
      .insert(attachments)
      .values({
        filingRef,
        entityType,
        entityId,
        fileName,
        storedName,
        mimeType: "application/pdf",
        sizeBytes: body.length,
        uploadedBy: userId,
      })
      .returning();
    return row!;
  });
}
