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
import { draftAll, draftMonth, owners, raiseMonth } from "../services/owner-billing";

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
ownerBillingRouter.post("/raise", requirePermission("sales", "create"), async (req, res) => {
  try {
    const body = z
      .object({ contactId: z.string().uuid(), period })
      .parse(req.body);
    const out = await db.transaction((tx) =>
      raiseMonth(tx, body.contactId, body.period, req.session.user!.id),
    );

    // Attached only once the documents are real. Writing the file inside the
    // transaction would leave it on disk even when the posting rolled back.
    const attached = await attachStatement(out, body.period, req.session.user!.id);

    res.status(201).json({
      invoiceId: out.invoiceId,
      billId: out.billId,
      attachments: attached,
      invoiceTotal: out.draft.invoiceTotal,
      billTotal: out.draft.billTotal,
      net: out.draft.net,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message });
    if (!fail(err, res)) throw err;
  }
});

/**
 * Write the supporting statement and hang it off both documents.
 *
 * A snapshot, not a live view: the deliveries and daily records behind a month
 * can be corrected afterwards, and a statement that quietly followed them would
 * stop explaining the invoice it is attached to.
 *
 * Runs after the posting transaction has committed. A failure here leaves the
 * invoice and bill standing without their attachment, which is recoverable;
 * failing the posting because a file could not be written would not be.
 */
async function attachStatement(
  out: { draft: { owner: { name: string } }; invoiceId: string | null; billId: string | null; statement: string },
  period: string,
  userId: string,
) {
  const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  const storedName = `${randomBytes(16).toString("hex")}.csv`;
  const body = Buffer.from(out.statement, "utf8");
  await writeFile(path.join(UPLOAD_DIR, storedName), body);

  const safeOwner = out.draft.owner.name.replace(/[^\w -]/g, "").trim() || "owner";
  const fileName = `${safeOwner} ${period.slice(0, 7)} statement.csv`;

  const targets = [
    ["invoice", out.invoiceId] as const,
    ["bill", out.billId] as const,
  ].filter((t): t is readonly ["invoice" | "bill", string] => !!t[1]);

  const made: Array<{ id: string; entityType: string }> = [];
  for (const [entityType, entityId] of targets) {
    // One row and one file per document, even though the bytes are identical.
    // `stored_name` is unique and the download route deletes the file with the
    // row, so a shared file would vanish from the invoice the moment somebody
    // tidied it off the bill.
    const row = await db.transaction(async (tx) => {
      const filingRef = await nextDocumentNumber(tx, "attachment");
      const [created] = await tx
        .insert(attachments)
        .values({
          filingRef,
          entityType,
          entityId,
          fileName,
          // Unique per row, so the second insert cannot collide on storedName.
          storedName: made.length ? `${randomBytes(16).toString("hex")}.csv` : storedName,
          mimeType: "text/csv",
          sizeBytes: body.length,
          uploadedBy: userId,
        })
        .returning();
      return created!;
    });
    // The second row needs its own copy on disk, since storedName is unique.
    if (row.storedName !== storedName) {
      await writeFile(path.join(UPLOAD_DIR, row.storedName), body);
    }
    made.push({ id: row.id, entityType });
  }
  return made;
}
