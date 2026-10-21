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
import { and, desc, eq, gte } from "drizzle-orm";
import { attachments, ownerAgreements, ownerBillingRuns } from "@shared/schema";
import { db } from "../db";
import { nextDocumentNumber } from "../lib/numbering";
import { requirePermission } from "../lib/rbac";
import { PostingError } from "../services/posting";
import {
  agreementOn,
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
 * A month's statement as a PDF, before or after raising: feed by delivery day,
 * pullets by housing, eggs by day and shed at that day's rate. The same PDF that
 * is attached to the document when the month is raised, so what is checked is
 * what goes out.
 */
ownerBillingRouter.get("/statements/:contactId", requirePermission("sales", "view"), async (req, res) => {
  try {
    const p = period.parse(String(req.query.period ?? ""));
    const kind = z.enum(["feed", "birds", "eggs"]).parse(req.query.kind);
    const pdfs = await buildStatements(db, req.params.contactId!, p);
    const one = pdfs[kind];
    if (!one) return res.status(404).json({ error: "Nothing of that kind passed in that month" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${one.fileName.replace(/"/g, "")}"`);
    res.send(one.pdf);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message });
    if (!fail(err, res)) throw err;
  }
});

/** An owner's agreements, newest first: the egg spread and when each took effect. */
ownerBillingRouter.get("/agreements/:contactId", requirePermission("sales", "view"), async (req, res) => {
  const rows = await db
    .select()
    .from(ownerAgreements)
    .where(eq(ownerAgreements.contactId, req.params.contactId!))
    .orderBy(desc(ownerAgreements.effectiveFrom));
  res.json({ agreements: rows });
});

/**
 * Set the egg spread from a date.
 *
 * A new dated row rather than an edit, because a spread renegotiated in March
 * must not restate January. The same date again corrects that row. The feed
 * rate carries over from the agreement it replaces, since only the spread is
 * being set here. A month already raised is refused: its bill was priced at the
 * old spread, and a draft priced at the new one would disagree with it.
 */
ownerBillingRouter.post("/agreements", requirePermission("sales", "edit"), async (req, res) => {
  const parsed = z
    .object({
      contactId: z.string().uuid(),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date looks like 2026-09-01"),
      eggSpreadPerEgg: z.coerce.number().min(-100).max(100),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message });
  const { contactId, effectiveFrom, eggSpreadPerEgg } = parsed.data;

  const [raised] = await db
    .select({ period: ownerBillingRuns.period })
    .from(ownerBillingRuns)
    .where(
      and(
        eq(ownerBillingRuns.contactId, contactId),
        gte(ownerBillingRuns.period, `${effectiveFrom.slice(0, 7)}-01`),
      ),
    )
    .orderBy(desc(ownerBillingRuns.period))
    .limit(1);
  if (raised) {
    return res.status(422).json({
      error: `${raised.period.slice(0, 7)} is already raised at the old spread — choose a date after it`,
    });
  }

  const row = await db.transaction(async (tx) => {
    const [same] = await tx
      .select()
      .from(ownerAgreements)
      .where(and(eq(ownerAgreements.contactId, contactId), eq(ownerAgreements.effectiveFrom, effectiveFrom)));
    if (same) {
      const [updated] = await tx
        .update(ownerAgreements)
        .set({ eggSpreadPerEgg: eggSpreadPerEgg.toFixed(4) })
        .where(eq(ownerAgreements.id, same.id))
        .returning();
      return updated;
    }
    const prior = await agreementOn(tx, contactId, effectiveFrom);
    const [inserted] = await tx
      .insert(ownerAgreements)
      .values({
        contactId,
        effectiveFrom,
        eggSpreadPerEgg: eggSpreadPerEgg.toFixed(4),
        feedRatePerKg: prior?.feedRatePerKg ?? null,
        createdBy: req.session.user!.id,
      })
      .returning();
    return inserted;
  });
  res.status(201).json(row);
});

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
