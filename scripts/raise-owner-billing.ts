/**
 * Raise a month's owner documents from the command line.
 *
 * The same `raiseMonth` the screen calls, followed by the same statement
 * builder — this exists so a month can be closed without a browser, and so the
 * flow can be exercised in a session that has no login.
 *
 * Posts to the ledger. It refuses a month already billed, a month with an
 * unpriceable line, and an owner with nothing to bill, exactly as the screen
 * does, because every one of those refusals lives in the service.
 *
 *   npx tsx scripts/raise-owner-billing.ts --period 2026-08
 *   npx tsx scripts/raise-owner-billing.ts --period 2026-08 --owner Luit
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { attachments } from "@shared/schema";
import { db } from "../server/db";
import { nextDocumentNumber } from "../server/lib/numbering";
import { PostingError } from "../server/services/posting";
import {
  buildStatements,
  owners,
  raiseMonth,
  type StatementKind,
} from "../server/services/owner-billing";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const period = arg("period");
const only = arg("owner");

if (!period) {
  console.log("\n  --period is required, e.g. --period 2026-08\n");
  process.exit(1);
}

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const userId = ((await db.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
const money = (v: number) =>
  `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let failures = 0;
for (const o of await owners(db)) {
  if (only && !o.name.toLowerCase().includes(only.toLowerCase())) continue;
  console.log(`\n  ${o.name} — ${period.slice(0, 7)}`);

  let out;
  try {
    out = await db.transaction((tx) => raiseMonth(tx, o.id, period, userId));
  } catch (e) {
    failures++;
    console.log(`    ! ${e instanceof PostingError ? e.message : String(e)}`);
    continue;
  }

  console.log(
    `    feed invoice ${out.feedInvoiceId ? money(out.draft.feedTotal) : "—"}` +
      `   pullet invoice ${out.birdInvoiceId ? money(out.draft.birdTotal) : "—"}` +
      `   egg bill ${out.billId ? money(out.draft.eggTotal) : "—"}`,
  );

  // Statements are written AFTER the posting has committed: a file created
  // inside the transaction would survive a rollback and leave an orphan.
  const built = await buildStatements(db, o.id, period);
  const targets: Array<{ kind: StatementKind; entityType: "invoice" | "bill"; entityId: string }> = [];
  if (out.feedInvoiceId) targets.push({ kind: "feed", entityType: "invoice", entityId: out.feedInvoiceId });
  if (out.birdInvoiceId) targets.push({ kind: "birds", entityType: "invoice", entityId: out.birdInvoiceId });
  if (out.billId) targets.push({ kind: "eggs", entityType: "bill", entityId: out.billId });

  for (const t of targets) {
    const doc = built[t.kind];
    if (!doc) continue;
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
    console.log(`    attached ${doc.fileName} to the ${t.entityType} (${doc.pdf.length} bytes)`);
  }
}

console.log(failures ? `\n  ${failures} owner(s) could not be billed\n` : "\n  done\n");
process.exit(failures ? 1 : 0);
