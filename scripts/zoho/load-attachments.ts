/**
 * Phase 3: the files behind the documents.
 *
 *   npx tsx scripts/zoho/load-attachments.ts             # say what would happen
 *   npx tsx scripts/zoho/load-attachments.ts --commit    # fetch and store them
 *
 * The dump carried the attachment *metadata* — names, sizes, ids — but never
 * the bytes, so 3,571 scanned bills and receipts across seven document types
 * stayed in Zoho. They are the evidence behind the books, so the books are not
 * really migrated without them.
 *
 * Roughly 2.45 GB. Zoho is paced at one request every 700ms and has blocked
 * this org three times, so expect an hour or more; it is resumable and skips
 * whatever already landed.
 *
 * Files go through the one attachment mechanism the app already has — a row in
 * `attachments` with a filing reference, and the bytes under uploads/ — rather
 * than a second parallel store.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { attachments, users, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { nextDocumentNumber } from "../../server/lib/numbering";
import { zohoGetFile, type ZohoError } from "./client";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

/**
 * Where each kind of document keeps its files, and what it is called on each
 * side. The names do not line up by accident of history: the id map calls a
 * journal "journal" while the attachments table calls it "journal_entry", and
 * attaching to the wrong one would file every journal's paperwork under a
 * document that does not exist.
 */
const SOURCES = [
  { file: "bills", idField: "bill_id", apiPath: "bills", mapEntity: "bill", attachTo: "bill" },
  { file: "invoices", idField: "invoice_id", apiPath: "invoices", mapEntity: "invoice", attachTo: "invoice" },
  { file: "expenses", idField: "expense_id", apiPath: "expenses", mapEntity: "expense", attachTo: "expense" },
  { file: "vendorcredits", idField: "vendor_credit_id", apiPath: "vendorcredits", mapEntity: "vendor_credit", attachTo: "vendor_credit" },
  { file: "vendorpayments", idField: "payment_id", apiPath: "vendorpayments", mapEntity: "vendor_payment", attachTo: "vendor_payment" },
  { file: "journals", idField: "journal_id", apiPath: "journals", mapEntity: "journal", attachTo: "journal_entry" },
  { file: "contacts", idField: "contact_id", apiPath: "contacts", mapEntity: "contact", attachTo: "contact" },
] as const;

interface ZohoDocument {
  document_id: string;
  file_name: string;
  file_size?: string | number;
  file_type?: string;
}

interface Pending {
  documentId: string;
  fileName: string;
  size: number;
  apiPath: string;
  parentZohoId: string;
  attachTo: string;
  eggsyId: string;
  label: string;
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(`.zoho-dump/detail/${file}.jsonl`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function main() {
  const commit = process.argv.includes("--commit");
  // `--limit N` stores only the first N. A run this long should be proved on a
  // handful before it is trusted with three and a half thousand.
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

  const idsOf = async (entity: string) =>
    new Map(
      (
        await db
          .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
          .from(zohoIdMap)
          .where(eq(zohoIdMap.entity, entity))
      ).map((r) => [r.zohoId, r.eggsyId]),
    );
  const done = await idsOf("attachment");

  const pending: Pending[] = [];
  const orphans: string[] = [];

  for (const src of SOURCES) {
    const rows = await readJsonl(src.file);
    if (!rows.length) continue;
    const parents = await idsOf(src.mapEntity);

    for (const row of rows) {
      const docs = (row.documents ?? []) as ZohoDocument[];
      if (!docs.length) continue;
      // Zoho spells the vendor credit id differently in places, so both are tried.
      const parentZohoId = String(
        row[src.idField] ?? row.vendorcredit_id ?? row.creditnote_id ?? "",
      );
      const eggsyId = parents.get(parentZohoId);

      for (const d of docs) {
        if (done.has(String(d.document_id))) continue;
        if (!eggsyId) {
          // The document itself never made it into niko, so there is nothing
          // to attach to. Reported rather than guessed at.
          orphans.push(`${src.file} ${parentZohoId || "(no id)"} — ${d.file_name}`);
          continue;
        }
        pending.push({
          documentId: String(d.document_id),
          fileName: d.file_name,
          size: Number(d.file_size ?? 0),
          apiPath: src.apiPath,
          parentZohoId,
          attachTo: src.attachTo,
          eggsyId,
          label: `${src.file}/${d.file_name}`,
        });
      }
    }
  }

  const totalBytes = pending.reduce((s, p) => s + p.size, 0);
  console.log(`${done.size} attachments already stored`);
  console.log(`${pending.length} to fetch, ${mb(totalBytes)}`);
  const byKind = new Map<string, { n: number; bytes: number }>();
  for (const p of pending) {
    const e = byKind.get(p.attachTo) ?? { n: 0, bytes: 0 };
    e.n += 1;
    e.bytes += p.size;
    byKind.set(p.attachTo, e);
  }
  for (const [k, v] of [...byKind].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${k.padEnd(16)}${String(v.n).padStart(6)}  ${mb(v.bytes)}`);
  }
  if (orphans.length) {
    console.log(`\n${orphans.length} file(s) hang off a document that is not in niko:`);
    for (const o of orphans.slice(0, 10)) console.log(`    ${o}`);
    if (orphans.length > 10) console.log(`    … and ${orphans.length - 10} more`);
  }

  if (!commit) {
    console.log("\nDry run — nothing fetched. Re-run with --commit to apply.");
    await pool.end();
    return;
  }
  if (!pending.length) {
    console.log("\nNothing to do.");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("No user to attribute the files to");
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  if (Number.isFinite(limit)) {
    pending.length = Math.min(pending.length, limit);
    console.log(`\nLimited to ${pending.length} file(s) for this run.`);
  }

  let stored = 0;
  let storedBytes = 0;
  const failures: string[] = [];

  for (const [i, p] of pending.entries()) {
    let storedPath: string | null = null;
    try {
      const { bytes, contentType } = await zohoGetFile(
        `${p.apiPath}/${p.parentZohoId}/documents/${p.documentId}`,
      );

      const ext = path.extname(p.fileName).slice(0, 10).replace(/[^.\w]/g, "");
      const storedName = `${randomBytes(16).toString("hex")}${ext}`;
      storedPath = path.join(UPLOAD_DIR, storedName);
      await writeFile(storedPath, bytes);

      await db.transaction(async (tx) => {
        const filingRef = await nextDocumentNumber(tx, "attachment");
        const [created] = await tx
          .insert(attachments)
          .values({
            filingRef,
            entityType: p.attachTo,
            entityId: p.eggsyId,
            fileName: p.fileName.slice(0, 255),
            storedName,
            mimeType: contentType,
            sizeBytes: bytes.length,
            uploadedBy: admin.id,
          })
          .returning({ id: attachments.id });
        await tx.insert(zohoIdMap).values({
          entity: "attachment",
          zohoId: p.documentId,
          eggsyId: created!.id,
          label: p.fileName.slice(0, 120),
        });
      });

      stored += 1;
      storedBytes += bytes.length;
      storedPath = null; // committed; no longer ours to clean up
    } catch (err) {
      // A file on disk with no row pointing at it is invisible clutter, so a
      // failed insert takes its bytes with it.
      if (storedPath) await unlink(storedPath).catch(() => {});
      const e = err as ZohoError;
      failures.push(`${p.label} (${p.documentId}): ${e.status ?? ""} ${e.message.slice(0, 80)}`);
    }

    if ((i + 1) % 25 === 0 || i === pending.length - 1) {
      process.stdout.write(
        `\r  ${i + 1}/${pending.length} — ${stored} stored (${mb(storedBytes)}), ${failures.length} failed   `,
      );
    }
  }

  console.log(`\n\nStored ${stored} of ${pending.length}, ${mb(storedBytes)}`);
  if (failures.length) {
    console.log(`\n${failures.length} failed:`);
    for (const f of failures.slice(0, 20)) console.log(`    ${f}`);
    if (failures.length > 20) console.log(`    … and ${failures.length - 20} more`);
    console.log("\nRe-running picks up only what is still missing.");
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n${e.message}`);
  console.error("Progress is saved; re-running continues from where it stopped.");
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
