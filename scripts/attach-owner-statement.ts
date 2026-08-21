/**
 * Attach (or re-attach) the supporting statement to a month's documents.
 *
 * Raising writes the statement after the posting has committed, so a failure
 * there leaves a real invoice and bill standing without their backing detail.
 * This is the recovery: it regenerates the statement from the same service and
 * hangs it on both documents.
 *
 * Regenerated, not recovered from anywhere — so if the underlying records have
 * been corrected since, the new statement describes them as they are now and
 * may no longer add up to the document it is attached to. It says so in its own
 * header when that is the case.
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
import { monthStatement } from "../server/services/owner-billing";

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

let attached = 0;
for (const { run, name } of runs) {
  if (wanted && !run.period.startsWith(wanted.slice(0, 7))) continue;
  const targets = (
    [
      ["invoice", run.invoiceId],
      ["bill", run.billId],
    ] as const
  ).filter((t): t is readonly ["invoice" | "bill", string] => !!t[1]);
  if (!targets.length) continue;

  const period = run.period.slice(0, 7);
  const fileName = `${name.replace(/[^\w -]/g, "").trim() || "owner"} ${period} statement.csv`;

  // Only where it is actually missing — this must not pile up a new copy on
  // every run.
  const already = await db
    .select({ entityId: attachments.entityId, fileName: attachments.fileName })
    .from(attachments)
    .where(
      and(
        inArray(
          attachments.entityId,
          targets.map((t) => t[1]),
        ),
        eq(attachments.fileName, fileName),
      ),
    );
  const have = new Set(already.map((a) => a.entityId));
  const missing = targets.filter(([, id]) => !have.has(id));
  if (!missing.length) {
    console.log(`  ${name} ${period} — already attached`);
    continue;
  }

  const body = Buffer.from(await monthStatement(db, run.contactId, period), "utf8");
  for (const [entityType, entityId] of missing) {
    const storedName = `${randomBytes(16).toString("hex")}.csv`;
    await writeFile(path.join(UPLOAD_DIR, storedName), body);
    await db.transaction(async (tx) => {
      const filingRef = await nextDocumentNumber(tx, "attachment");
      await tx.insert(attachments).values({
        filingRef,
        entityType,
        entityId,
        fileName,
        storedName,
        mimeType: "text/csv",
        sizeBytes: body.length,
        uploadedBy: userId,
      });
    });
    attached++;
    console.log(`  ${name} ${period} — attached to the ${entityType} (${body.length} bytes)`);
  }
}

console.log(attached ? `\n  ${attached} attachment(s) added\n` : "\n  nothing to do\n");
process.exit(0);
