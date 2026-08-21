/**
 * Attach (or re-attach) each document's statement for a month.
 *
 * Raising writes the statements after the posting has committed, so a failure
 * there leaves real documents standing without their backing detail. This is
 * the recovery: it rebuilds each statement from the same service and hangs it
 * on the document it explains — feed on the feed invoice, pullets on the pullet
 * invoice, eggs on the bill.
 *
 * Rebuilt, not recovered: if the underlying records have been corrected since,
 * the new statement describes them as they are now and may no longer add up to
 * the document it is attached to.
 *
 *   npx tsx scripts/attach-owner-statement.ts                  # every gap
 *   npx tsx scripts/attach-owner-statement.ts --period 2026-08
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { attachments, contacts, ownerBillingRuns } from "@shared/schema";
import { db } from "../server/db";
import { nextDocumentNumber } from "../server/lib/numbering";
import { buildStatements, type StatementKind } from "../server/services/owner-billing";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const wanted = arg("period");

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const userId = ((await db.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;

const runs = await db
  .select({ run: ownerBillingRuns, name: contacts.displayName })
  .from(ownerBillingRuns)
  .innerJoin(contacts, eq(contacts.id, ownerBillingRuns.contactId));

let added = 0;
for (const { run, name } of runs) {
  if (wanted && !run.period.startsWith(wanted.slice(0, 7))) continue;
  const period = run.period.slice(0, 7);

  const targets: Array<{ kind: StatementKind; entityType: "invoice" | "bill"; entityId: string }> = [];
  if (run.feedInvoiceId) targets.push({ kind: "feed", entityType: "invoice", entityId: run.feedInvoiceId });
  if (run.birdInvoiceId) targets.push({ kind: "birds", entityType: "invoice", entityId: run.birdInvoiceId });
  if (run.billId) targets.push({ kind: "eggs", entityType: "bill", entityId: run.billId });
  if (!targets.length) continue;

  const built = await buildStatements(db, run.contactId, period);

  // Only where it is actually missing — this must not pile up a new copy on
  // every run.
  const already = await db
    .select({ entityId: attachments.entityId, fileName: attachments.fileName })
    .from(attachments)
    .where(inArray(attachments.entityId, targets.map((t) => t.entityId)));

  for (const t of targets) {
    const doc = built[t.kind];
    if (!doc) continue;
    if (already.some((a) => a.entityId === t.entityId && a.fileName === doc.fileName)) {
      console.log(`  ${name} ${period} — ${t.kind} already attached`);
      continue;
    }
    const storedName = `${randomBytes(16).toString("hex")}.pdf`;
    await writeFile(path.join(UPLOAD_DIR, storedName), doc.pdf);
    await db.transaction(async (tx) => {
      const filingRef = await nextDocumentNumber(tx, "attachment");
      await tx.insert(attachments).values({
        filingRef,
        entityType: t.entityType,
        entityId: t.entityId,
        fileName: doc.fileName,
        storedName,
        mimeType: "application/pdf",
        sizeBytes: doc.pdf.length,
        uploadedBy: userId,
      });
    });
    added++;
    console.log(`  ${name} ${period} — attached ${t.kind} to the ${t.entityType} (${doc.pdf.length} bytes)`);
  }
}

console.log(added ? `\n  ${added} attachment(s) added\n` : "\n  nothing to do\n");
process.exit(0);
