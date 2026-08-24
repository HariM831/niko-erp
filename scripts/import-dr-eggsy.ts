/**
 * Bring Amino's Dr niko observations across — the last piece of the export
 * the main import left behind.
 *
 * Eleven observations, forty-six photos. The photos are copied from
 * farm-export/images/ into uploads/ under fresh random names (original names
 * are never used as paths — the same rule the attachments route enforces) and
 * registered as attachment rows; the observations keep Amino's id in
 * legacy_id, so running this twice adds nothing.
 *
 * Run: npx tsx scripts/import-dr-eggsy.ts [--apply]
 */
import { randomBytes } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { aiObservations, attachments, houses, users } from "@shared/schema";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");
const EXPORT_DIR = path.resolve(process.cwd(), "farm-export");
const IMAGES_DIR = path.join(EXPORT_DIR, "images");
const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

interface LegacyObs {
  id: string;
  shed_id: string;
  date: string;
  images: string[];
  ai_remark: string | null;
  created_at: string;
}

async function main() {
  const data = JSON.parse(readFileSync(path.join(EXPORT_DIR, "farm-export.json"), "utf8")).data;
  const legacy: LegacyObs[] = data.ai_observations ?? [];
  const shedName = new Map<string, string>(data.sheds.map((s: { id: string; name: string }) => [s.id, s.name]));

  const houseRows = await db.select({ id: houses.id, code: houses.code }).from(houses);
  const houseByCode = new Map(houseRows.map((h) => [h.code, h.id]));

  // Attributed to an admin: the Amino user ids mean nothing here, and the
  // record of who ORIGINALLY submitted stays in the export.
  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("no users exist to attribute the import to");

  if (APPLY && !existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  let made = 0;
  let photos = 0;
  let skipped = 0;

  for (const o of legacy) {
    const code = shedName.get(o.shed_id);
    const houseId = code ? houseByCode.get(code) : undefined;
    if (!houseId) {
      console.log(`  ! ${o.id.slice(0, 8)}: shed ${o.shed_id.slice(0, 8)} (${code ?? "?"}) has no house — skipped`);
      skipped++;
      continue;
    }

    const [existing] = await db
      .select({ id: aiObservations.id })
      .from(aiObservations)
      .where(eq(aiObservations.legacyId, o.id));
    if (existing) {
      skipped++;
      continue;
    }

    const observedOn = o.date.slice(0, 10);
    console.log(`  ${code}  ${observedOn}  ${o.images.length} photo(s)${o.ai_remark ? "  + remark" : ""}`);
    if (!APPLY) {
      made++;
      continue;
    }

    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(aiObservations)
        .values({
          houseId,
          observedOn,
          aiRemark: o.ai_remark || null,
          // Amino analysed with gemini-2.0-flash; recorded so the remark's
          // provenance survives the move.
          aiModel: o.ai_remark ? "gemini-2.0-flash (amino)" : null,
          analyzedAt: o.ai_remark ? new Date(o.created_at) : null,
          submittedBy: admin.id,
          legacyId: o.id,
          createdAt: new Date(o.created_at),
        })
        .returning({ id: aiObservations.id });

      for (const img of o.images) {
        const src = path.join(IMAGES_DIR, img);
        if (!existsSync(src)) {
          console.log(`    ! ${img} missing from the export`);
          continue;
        }
        const storedName = `${randomBytes(16).toString("hex")}.jpg`;
        copyFileSync(src, path.join(UPLOAD_DIR, storedName));
        await tx.insert(attachments).values({
          entityType: "ai_observation",
          entityId: row!.id,
          fileName: img,
          storedName,
          mimeType: "image/jpeg",
          sizeBytes: statSync(src).size,
          uploadedBy: admin.id,
          kind: "dr_eggsy_photo",
        });
        photos++;
      }
    });
    made++;
  }

  console.log(
    `\n  ${made} observation(s) ${APPLY ? "imported" : "would import"}, ${photos} photo(s), ${skipped} skipped${APPLY ? "" : " — add --apply"}\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
