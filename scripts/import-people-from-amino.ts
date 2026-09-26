/**
 * Bring the people across from Amino — employees, daily-wage workers, and
 * every face the gate already knows.
 *
 * Dry by default: it resolves everything, says what it would write, and stops.
 * `--apply` writes, in ONE transaction, so a failure half-way leaves nothing
 * behind rather than a payroll that is half here.
 *
 * The faces transfer verbatim. Both apps pin @vladmandic/human@3.3.5 with the
 * same model files, so a descriptor enrolled on Amino matches on niko's
 * devices without anyone standing in front of a camera again. The export
 * stamps its model; a stamp this file doesn't recognise stops the import,
 * because a database full of unmatchable vectors LOOKS enrolled.
 *
 * Mapping notes, the non-obvious ones:
 *
 *  - Amino keeps department and designation as text on the employee; niko
 *    normalises them into tables. Created here by name, exactly as the
 *    /employees/import endpoint would.
 *  - Amino's wage_workers are a table of their own; in niko a daily-wage
 *    worker is an employee with payType "daily_wage". They arrive without an
 *    empCode, so they get W-0001… in enrolment order — deterministic for the
 *    same export file, which is what makes a re-run an upsert and not a
 *    duplication.
 *  - reportingAuthority is free text in Amino ("Hari M") and a self-reference
 *    in niko. Resolved by exact name in a second pass; anything unresolved is
 *    reported and left blank rather than guessed. [[ask-never-guess]]
 *  - photoHash is recomputed here with the same sha256(photoUrl) the payroll
 *    routes use, not copied — the one thing worse than no photo on a device
 *    is a stale hash that convinces it the photo it has is current.
 *
 *   npx tsx scripts/import-people-from-amino.ts --dir people-export
 *   npx tsx scripts/import-people-from-amino.ts --dir people-export --apply
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { departments, designations, employees, wageRoles } from "@shared/schema";
import { db } from "../server/db";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const DIR = arg("dir") ?? "people-export";
const APPLY = process.argv.includes("--apply");

const KNOWN_MODEL = "@vladmandic/human@3.3.5 faceres";

type Row = Record<string, unknown>;
const exp = JSON.parse(await readFile(path.join(DIR, "people-export.json"), "utf8")) as {
  exportedAt: string;
  faceModel: string;
  data: { employees: Row[]; wage_workers: Row[]; wage_roles: Row[] };
};

const s = (v: unknown) => (v == null ? null : String(v) || null);
const money = (v: unknown) => (Number(v ?? 0) || 0).toFixed(2);
/**
 * A government ID, cleaned. Amino took these through a CSV once and a leading
 * comma stayed on 21 of them — ",371059587893" — which niko's varchar(12)
 * refuses whole. Digits only; a value that still isn't the right length is
 * reported and dropped rather than stored wrong, because a wrong Aadhar on
 * file is worse than a blank one.
 */
/**
 * Amino let HR type anything into a field they had nothing for, so "N/A",
 * "Pending" and "nil" are all over the identity columns. They are not values;
 * they are a blank with a word in it, and niko's own forms refuse to save a
 * record carrying one — which locked HR out of an employee entirely.
 */
const PLACEHOLDER = /^(n\/?a|na|nil|none|null|pending|not applicable|no|-|\.)$/i;
const notPlaceholder = (v: unknown) => {
  const t = s(v);
  return t && !PLACEHOLDER.test(t.trim()) ? t : null;
};
const realEmail = (v: unknown) => {
  const t = notPlaceholder(v);
  return t && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t.trim()) ? t.trim() : null;
};
/** Ten characters or it is not a PAN; niko refuses to store anything else. */
const pan = (v: unknown, who: string) => {
  const t = notPlaceholder(v);
  if (!t) return null;
  const norm = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (norm.length === 10) return norm;
  problem(`${who}: PAN "${t}" is not ten characters (dropped)`);
  return null;
};
/**
 * The digits, and only the digits. A CSV import into Amino years ago left a
 * comma on the front of a hundred of these, and niko writes payment files
 * from this column — ",30935103625" is not an account any bank will pay.
 */
const account = (v: unknown, who: string) => {
  const t = notPlaceholder(v);
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  if (!digits) {
    problem(`${who}: bank account "${t}" has no digits in it (dropped)`);
    return null;
  }
  if (digits !== t.trim()) problem(`${who}: bank account "${t}" cleaned to ${digits}`);
  return digits;
};

const idNum = (v: unknown, len: number, who: string, what: string): string | null => {
  if (v == null || v === "") return null;
  const digits = String(v).replace(/\D/g, "");
  if (digits.length === len) return digits;
  problem(`${who}: ${what} "${String(v).slice(0, 20)}" is not ${len} digits (dropped)`);
  return null;
};
const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

/** Thrown to roll a dry run back. Not an error anybody needs to see. */
class DryRun extends Error {}

let problems = 0;
const say = (m = "") => console.log(m);
const problem = (m: string) => {
  problems++;
  say(`   ! ${m}`);
};

say("\n  IMPORT PEOPLE FROM AMINO");
say(`  export of ${exp.exportedAt}${APPLY ? "" : "   (dry run — add --apply to write)"}`);

if (exp.faceModel !== KNOWN_MODEL) {
  say(`\n  REFUSING: export says its faces are "${exp.faceModel}",`);
  say(`  this import only understands "${KNOWN_MODEL}".`);
  say(`  A vector from another model would sit in the database looking enrolled`);
  say(`  and never match a face at the gate.\n`);
  process.exit(1);
}

/** Re-inline a photo file as the data URL niko stores. */
let photosMissing = 0;
const inhale = async (file: unknown): Promise<string | null> => {
  if (typeof file !== "string" || !file) return null;
  let buf;
  try {
    buf = await readFile(path.join(DIR, "photos", file));
  } catch {
    // The JSON travels ahead of its photos folder sometimes. Faces still
    // import (matching is on the descriptor) and a re-run with the folder
    // present fills the photos in, because everything upserts.
    photosMissing++;
    return null;
  }
  const mime = file.endsWith(".pdf") ? "application/pdf" : file.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
};

const face = (r: Row, who: string): number[] | null => {
  const d = r.face_descriptor;
  if (!Array.isArray(d) || d.length === 0) return null;
  if (d.length !== 1024) {
    problem(`${who}: descriptor has ${d.length} floats, expected 1024 — skipped, re-enrol on niko`);
    return null;
  }
  return d as number[];
};

try {
  await db.transaction(async (tx) => {
    // ── The rate card, by name ─────────────────────────
    const roleId = new Map<string, string>();
    for (const r of exp.data.wage_roles) {
      const name = s(r.name);
      if (!name) continue;
      const allRoles = await tx.select().from(wageRoles);
      const have = allRoles.find((r2) => r2.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (have) {
        roleId.set(name, have.id);
      } else {
        const [made] = await tx
          .insert(wageRoles)
          .values({ name, dailyRate: money(r.daily_rate ?? r.dailyRate), isActive: r.is_active !== false })
          .returning();
        roleId.set(name, made!.id);
      }
    }
    say(`\n  wage roles          ${roleId.size} on the card`);

    // ── Departments and designations, by name ──────────
    //
    // Free text typed by different hands: "Office" and "OFFICE" are one
    // department, and matched exactly the first run made both. Matched folded,
    // first-seen casing kept.
    const foldName = (n: string) => n.replace(/\s+/g, " ").trim().toLowerCase();
    const deptId = new Map<string, string>(); // folded name
    const desigId = new Map<string, string>(); // "deptId folded-desig"
    const dept = async (name: string) => {
      const k = foldName(name);
      if (deptId.has(k)) return deptId.get(k)!;
      const all = await tx.select().from(departments);
      const have = all.find((d) => foldName(d.name) === k);
      const id = have ? have.id : (await tx.insert(departments).values({ name }).returning())[0]!.id;
      deptId.set(k, id);
      return id;
    };

    // ── Employees, upsert by empCode ───────────────────
    let created = 0;
    let updated = 0;
    let facesIn = 0;
    // "SANDIP DE" on the employee row, "Sandip De" in the reporting field:
    // the same person, stored by two hands. Case and spacing fold away;
    // null still marks a name two employees share.
    const fold = (n: string) => n.replace(/\s+/g, " ").trim().toLowerCase();
    const idByName = new Map<string, string | null>(); // folded name; null = ambiguous
    const reporting: Array<{ empCode: string; boss: string }> = [];

    for (const e of exp.data.employees) {
      const empCode = s(e.emp_code);
      const name = s(e.name);
      if (!empCode || !name) {
        problem(`employee without code or name: ${JSON.stringify(e).slice(0, 60)}`);
        continue;
      }
      const departmentId = s(e.department) ? await dept(s(e.department)!) : null;
      let designationId: string | null = null;
      if (departmentId && s(e.designation)) {
        const key = `${departmentId} ${foldName(s(e.designation)!)}`;
        if (!desigId.has(key)) {
          const all = await tx.select().from(designations).where(eq(designations.departmentId, departmentId));
          const found = all.find((d) => foldName(d.name) === foldName(s(e.designation)!));
          desigId.set(
            key,
            found
              ? found.id
              : (
                  await tx
                    .insert(designations)
                    .values({ departmentId, name: s(e.designation)! })
                    .returning()
                )[0]!.id,
          );
        }
        designationId = desigId.get(key)!;
      }

      const photoUrl = await inhale(e.photo_file);
      const descriptor = face(e, `${empCode} ${name}`);
      if (descriptor) facesIn++;

      const values = {
        empCode,
        name,
        payType: "salaried" as const,
        departmentId,
        designationId,
        dateOfJoining: s(e.date_of_joining)?.slice(0, 10) ?? null,
        contactNumber: s(e.contact_number),
        email: realEmail(e.email),
        panNumber: pan(e.pan_number, `${empCode} ${name}`),
        aadharNumber: idNum(e.aadhar_number, 12, `${empCode} ${name}`, "Aadhar"),
        uanNumber: idNum(e.uan_number, 12, `${empCode} ${name}`, "UAN"),
        esiNumber: notPlaceholder(e.esi_number),
        bankName: s(e.bank_name),
        bankAccountNumber: account(e.bank_account_number, `${empCode} ${name}`),
        bankIfsc: s(e.bank_ifsc),
        basicSalary: money(e.basic_salary),
        hra: money(e.hra),
        allowances: money(e.allowances),
        pfEnabled: e.pf_enabled !== false,
        esiEnabled: e.esi_enabled !== false,
        openingCl: Number(e.opening_cl ?? 0) || 0,
        openingSl: Number(e.opening_sl ?? 0) || 0,
        emergencyContactName: s(e.emergency_contact_name),
        emergencyContactNumber: s(e.emergency_contact_number),
        emergencyContactRelation: s(e.emergency_contact_relation),
        photoUrl,
        photoHash: photoUrl ? sha256(photoUrl) : null,
        panDocUrl: await inhale(e.pan_doc_file),
        aadharDocUrl: await inhale(e.aadhar_doc_file),
        faceDescriptor: descriptor,
        faceEnrolledAt: descriptor ? new Date(s(e.face_enrolled_at) ?? s(e.created_at) ?? Date.now()) : null,
        isActive: e.is_active !== false,
        updatedAt: new Date(),
      };

      const [existing] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.empCode, empCode));
      let id: string;
      if (existing) {
        await tx.update(employees).set(values).where(eq(employees.id, existing.id));
        id = existing.id;
        updated++;
      } else {
        id = (await tx.insert(employees).values(values).returning())[0]!.id;
        created++;
      }
      idByName.set(fold(name), idByName.has(fold(name)) ? null : id);
      if (s(e.reporting_authority)) reporting.push({ empCode, boss: s(e.reporting_authority)! });
    }
    say(`  employees           ${created} created, ${updated} updated, ${facesIn} faces`);

    // ── Wage workers become daily-wage employees ───────
    //
    // Two tables there, one table here — which is where a person enrolled in
    // BOTH (a daily-wage worker later put on salary) would silently become two
    // identities at the same gate. Aadhar is the one field both sides carry,
    // so a collision is reported and the wage row held back; deciding which
    // identity survives is a person's call, not an import's.
    const aadharSeen = new Map<string, string>(); // aadhar -> "empCode name"
    const wageAadhar = new Map<string, string>();
    for (const e of exp.data.employees) {
      if (s(e.aadhar_number)) aadharSeen.set(s(e.aadhar_number)!, `${s(e.emp_code)} ${s(e.name)}`);
    }
    let wCreated = 0;
    let wUpdated = 0;
    let wFaces = 0;
    let seq = 0;
    for (const w of exp.data.wage_workers) {
      seq++;
      const empCode = `W-${String(seq).padStart(4, "0")}`;
      const name = s(w.name);
      if (!name) {
        problem(`wage worker ${w.id} has no name — skipped`);
        continue;
      }
      const clash = s(w.aadhar_number) ? aadharSeen.get(s(w.aadhar_number)!) : undefined;
      if (clash) {
        problem(`${empCode} ${name}: same Aadhar as employee ${clash} — held back, merge by hand`);
        continue;
      }
      // Two DIFFERENT wage workers on one Aadhar are both real people with
      // their own faces. Both import, but HR gets told whose card is shared.
      const wClash = s(w.aadhar_number) ? wageAadhar.get(s(w.aadhar_number)!) : undefined;
      if (wClash) problem(`${empCode} ${name}: shares an Aadhar with ${wClash} (imported anyway, fix the number)`);
      if (s(w.aadhar_number)) wageAadhar.set(s(w.aadhar_number)!, `${empCode} ${name}`);
      const roleName = s(w.role);
      const wageRoleId = roleName ? (roleId.get(roleName) ?? null) : null;
      if (roleName && !wageRoleId) problem(`${empCode} ${name}: role "${roleName}" not on the rate card`);

      const photoUrl = await inhale(w.photo_file);
      const descriptor = face(w, `${empCode} ${name}`);
      if (descriptor) wFaces++;

      const values = {
        empCode,
        name,
        payType: "daily_wage" as const,
        wageRoleId,
        // No PF, no ESI. The column default is on, which suits the salaried;
        // on a wage worker it would take 12% of the day's pay, because PF is
        // reckoned on earned basic and their earnings are all basic.
        pfEnabled: false,
        esiEnabled: false,
        aadharNumber: idNum(w.aadhar_number, 12, `${empCode} ${name}`, "Aadhar"),
        photoUrl,
        photoHash: photoUrl ? sha256(photoUrl) : null,
        faceDescriptor: descriptor,
        faceEnrolledAt: descriptor ? new Date(s(w.created_at) ?? Date.now()) : null,
        isActive: w.is_active !== false,
        updatedAt: new Date(),
      };

      const [existing] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.empCode, empCode));
      if (existing) {
        await tx.update(employees).set(values).where(eq(employees.id, existing.id));
        wUpdated++;
      } else {
        await tx.insert(employees).values(values);
        wCreated++;
      }
    }
    say(`  wage workers        ${wCreated} created, ${wUpdated} updated, ${wFaces} faces  (codes W-0001…)`);

    // ── Reporting lines, by exact name ─────────────────
    let wired = 0;
    for (const r of reporting) {
      const bossId = idByName.get(fold(r.boss));
      if (bossId === null) {
        problem(`${r.empCode}: two employees are named "${r.boss}" — reporting line left blank`);
        continue;
      }
      if (!bossId) {
        problem(`${r.empCode}: reports to "${r.boss}", who is not in this export — left blank`);
        continue;
      }
      await tx
        .update(employees)
        .set({ reportingTo: bossId })
        .where(eq(employees.empCode, r.empCode));
      wired++;
    }
    say(`  reporting lines     ${wired} of ${reporting.length} wired`);

    if (!APPLY) throw new DryRun();
  });
} catch (e) {
  if (!(e instanceof DryRun)) throw e;
  if (photosMissing) say(`
  NOTE: ${photosMissing} photo files absent, descriptors imported; photos await the folder`);
  say(`\n  dry run rolled back — nothing written${problems ? ` (${problems} problems above)` : ""}\n`);
  process.exit(problems ? 1 : 0);
}

if (photosMissing) say(`
  NOTE: ${photosMissing} photo files absent, descriptors imported; photos await the folder`);
say(`\n  applied${problems ? ` with ${problems} problems noted above` : ", clean"}\n`);
process.exit(0);
